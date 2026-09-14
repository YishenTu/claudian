import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import type {
  CollabAuthorityKind,
  CollabInvitationState,
  CollabInvitationView,
  CollabManagementOperationView,
  CollabOperationOptions,
} from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface InvitationOperationPort {
  readBinding(): Promise<{ readonly kind: CollabAuthorityKind; readonly identity: string }>;
  createLan(options: CollabOperationOptions): Promise<CollabInvitationView>;
  createCloud(select: (completionId: string) => void): Promise<CollabInvitationView>;
  readManagement(options: CollabOperationOptions): Promise<CollabManagementOperationView | null>;
  resumeManagement(completionId: string): Promise<CollabManagementOperationView>;
  completeManagement(completionId: string): Promise<void>;
}

/** Owns one Create/Resume intent, including retries and its exact completion receipt. */
export class InvitationOperation {
  readonly #queue = new SerialTaskQueue();
  readonly #abort = new AbortController();
  #bindingIdentity: string | null = null;
  #inspected: boolean;
  #previousCompletionId: string | null = null;
  #selectedCompletionId: string | null = null;
  #completionId: string | null = null;
  #result: CollabInvitationState | null = null;
  #expectedInvitation: CollabInvitationView | null = null;

  constructor(
    private readonly port: InvitationOperationPort,
    private readonly intent: 'create' | 'resume',
    private readonly action: 'create-invitation' | 'create-recovery-link' = 'create-invitation',
  ) {
    this.#inspected = intent === 'resume';
  }

  run(): Promise<CollabInvitationState> {
    return this.#queue.run(async () => {
      const kind = await this.#checkBinding();
      if (this.#result || this.#completionId) return this.#read();
      if (kind === 'cloud') {
        let existing = await this.port.readManagement({ signal: this.#abort.signal });
        this.#guard();
        if (this.#selectedCompletionId && existing?.completionId !== this.#selectedCompletionId) {
          this.#result = { status: 'unavailable', reason: 'unavailable' };
          return this.#result;
        }
        if (existing && existing.action !== this.action) return { status: 'blocked' };
        if (!this.#inspected) {
          this.#inspected = true;
          this.#previousCompletionId = existing?.status === 'result-retained' ? existing.completionId : null;
        }
        if (this.#previousCompletionId) {
          await this.port.completeManagement(this.#previousCompletionId);
          this.#guard();
          this.#previousCompletionId = null;
          existing = null;
        }
        if (existing) {
          this.#selectedCompletionId = existing.completionId;
          if (existing.status === 'pending') {
            existing = await this.port.resumeManagement(this.#selectedCompletionId);
            this.#guard();
          }
          await this.#checkBinding();
          return this.#retain(existing);
        }
        if (this.intent === 'resume') return { status: 'unavailable', reason: 'unavailable' };
        const invitation = await this.port.createCloud(completionId => {
          this.#guard();
          this.#selectedCompletionId = completionId;
        });
        this.#guard();
        this.#expectedInvitation = { ...invitation };
        const retained = await this.port.readManagement({ signal: this.#abort.signal });
        this.#guard();
        if (retained?.invitation?.encodedInvitation !== invitation.encodedInvitation
          || retained.invitation.expiresAt !== invitation.expiresAt) throw this.#invalidResult();
        await this.#checkBinding();
        return this.#retain(retained);
      }
      if (this.intent === 'resume') return { status: 'unavailable', reason: 'unavailable' };
      const invitation = await this.port.createLan({ signal: this.#abort.signal });
      await this.#checkBinding();
      this.#result = { status: 'ready', invitation, availableUntil: invitation.expiresAt };
      return this.#current();
    });
  }

  read(): Promise<CollabInvitationState> {
    return this.#queue.run(() => this.#read());
  }

  async #read(): Promise<CollabInvitationState> {
    await this.#checkBinding();
    if (this.#completionId) {
      const expected = this.#result;
      let retained: CollabManagementOperationView | null;
      try {
        retained = await this.port.readManagement({ signal: this.#abort.signal });
        await this.#checkBinding();
      } catch (error) {
        this.#result = null;
        throw error;
      }
      if (retained?.action !== this.action || retained.status !== 'result-retained'
        || retained.completionId !== this.#completionId) {
        this.#result = { status: 'unavailable', reason: 'unavailable' };
        this.#completionId = null;
        return this.#result;
      }
      if (expected?.status === 'ready' && retained.invitation
        && (expected.invitation.encodedInvitation !== retained.invitation.encodedInvitation
          || expected.invitation.expiresAt !== retained.invitation.expiresAt)) {
        this.#result = { status: 'unavailable', reason: 'unavailable' };
        throw this.#invalidResult();
      }
      return this.#retain(retained);
    }
    return this.#current();
  }

  acknowledge(): Promise<void> {
    return this.#queue.run(async () => {
      await this.#checkBinding();
      if (this.#completionId) {
        await this.port.completeManagement(this.#completionId);
        this.#guard();
        this.#completionId = null;
      }
    });
  }

  dispose(): void {
    this.#abort.abort();
    this.#result = null;
    this.#expectedInvitation = null;
  }

  #retain(operation: CollabManagementOperationView): CollabInvitationState {
    this.#guard();
    if (operation.action !== this.action || operation.status !== 'result-retained'
      || operation.completionId !== this.#selectedCompletionId) {
      throw this.#invalidResult();
    }
    if (this.#expectedInvitation && operation.invitation
      && (this.#expectedInvitation.encodedInvitation !== operation.invitation.encodedInvitation
        || this.#expectedInvitation.expiresAt !== operation.invitation.expiresAt)) {
      throw this.#invalidResult();
    }
    this.#completionId = operation.completionId;
    this.#expectedInvitation = operation.invitation ? { ...operation.invitation } : null;
    this.#result = operation.invitation && operation.secretAvailableUntil
      ? {
        status: 'ready', invitation: operation.invitation,
        availableUntil: new Date(Math.min(
          Date.parse(operation.invitation.expiresAt), Date.parse(operation.secretAvailableUntil),
        )).toISOString(),
      }
      : { status: 'unavailable', reason: 'unavailable' };
    return this.#current();
  }

  #current(): CollabInvitationState {
    this.#guard();
    if (this.#result?.status === 'ready') {
      const deadline = Date.parse(this.#result.availableUntil);
      if (!Number.isFinite(deadline) || deadline <= Date.now()) {
        this.#result = {
          status: 'unavailable',
          reason: Date.parse(this.#result.invitation.expiresAt) <= Date.now() ? 'expired' : 'unavailable',
        };
      }
    }
    if (this.#result?.status === 'ready') {
      return { ...this.#result, invitation: { ...this.#result.invitation } };
    }
    this.#expectedInvitation = null;
    return this.#result ?? { status: 'unavailable', reason: 'unavailable' };
  }

  async #checkBinding(): Promise<CollabAuthorityKind> {
    this.#guard();
    const binding = await this.port.readBinding();
    this.#guard();
    if (this.#bindingIdentity !== null && this.#bindingIdentity !== binding.identity) {
      this.dispose();
      throw new CollabError({ code: 'authority-integrity-error' });
    }
    this.#bindingIdentity = binding.identity;
    return binding.kind;
  }

  #guard(): void {
    if (this.#abort.signal.aborted) throw new CollabError({ code: 'cancelled' });
  }

  #invalidResult(): CollabError {
    return new CollabError({ code: 'operation-failed' });
  }
}
