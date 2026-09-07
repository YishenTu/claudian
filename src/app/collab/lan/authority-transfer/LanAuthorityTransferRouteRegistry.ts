import { type CollabProjectId } from '@claudian-collab/protocol';

import type {
  LanAuthorityTransferRouteAccess,
  LanAuthorityTransferRouteAdmissionResult,
  LanAuthorityTransferRouteRegistration,
  LanAuthorityTransferRouteTransition,
} from '@/app/collab/lan/authority-transfer/LanAuthorityTransferRouter';
import { SerialTaskQueue } from '@/app/collab/SerialTaskQueue';
import { CollabError } from '@/core/collab/ClaudianCollabError';

function routeStateError(reason: string): CollabError {
  return new CollabError({
    code: 'durable-progress-recovery-required',
    recoveryActions: ['resume', 'open-diagnostics'],
    safeContext: { reason },
  });
}

function transferId(registration: LanAuthorityTransferRouteRegistration): string | null {
  return registration.state === 'source-active' ? null : registration.transferId;
}

function assertTransition(input: LanAuthorityTransferRouteTransition): void {
  const { expected, next, relinquishmentProof: proof } = input;
  const directionMatches = expected.state === 'source-active' && next.state === 'terminal-source'
    ? proof.sourceAuthority.kind === 'lan' && proof.targetAuthority.kind === 'cloud'
    : expected.state === 'target-only-staged' && next.state === 'target-active'
      ? proof.sourceAuthority.kind === 'cloud' && proof.targetAuthority.kind === 'lan'
      : false;
  if (
    !directionMatches
    || expected.projectId !== next.projectId
    || proof.projectId !== next.projectId
    || proof.transferId !== transferId(next)
    || (transferId(expected) !== null && transferId(expected) !== transferId(next))
  ) throw routeStateError('authority-transfer-route-transition-invalid');
}

export class LanAuthorityTransferRouteRegistry implements LanAuthorityTransferRouteAccess {
  private closed = false;
  private readonly queues = new Map<CollabProjectId, SerialTaskQueue>();
  private readonly registrations = new Map<
    CollabProjectId,
    LanAuthorityTransferRouteRegistration
  >();

  get size(): number {
    return this.registrations.size;
  }

  get pinsEndpoint(): boolean {
    return [...this.registrations.values()].some(
      registration => registration.state !== 'source-active'
        || registration.expectedEndpoint !== undefined,
    );
  }

  pinSourceActiveEndpoint(
    projectId: CollabProjectId,
    expectedEndpoint: string,
  ): LanAuthorityTransferRouteRegistration {
    if (this.closed) throw new Error('Authority-transfer routes are closed');
    const current = this.registrations.get(projectId);
    if (!current || current.state !== 'source-active') {
      throw routeStateError('authority-transfer-source-route-missing');
    }
    if (current.expectedEndpoint && current.expectedEndpoint !== expectedEndpoint) {
      throw routeStateError('authority-transfer-source-endpoint-conflict');
    }
    if (current.expectedEndpoint === expectedEndpoint) return current;
    const pinned = { ...current, expectedEndpoint };
    this.registrations.set(projectId, pinned);
    return pinned;
  }

  unpinSourceActiveEndpoint(projectId: CollabProjectId, expectedEndpoint: string): void {
    if (this.closed) return;
    const current = this.registrations.get(projectId);
    if (
      !current
      || current.state !== 'source-active'
      || current.expectedEndpoint !== expectedEndpoint
    ) return;
    const { expectedEndpoint: _removed, ...unpinned } = current;
    this.registrations.set(projectId, unpinned);
  }

  resolve(projectId: CollabProjectId): LanAuthorityTransferRouteRegistration | null {
    if (this.closed) return null;
    return this.registrations.get(projectId) ?? null;
  }

  runIfCurrent<T>(
    projectId: CollabProjectId,
    expected: LanAuthorityTransferRouteRegistration,
    operation: () => Promise<T>,
  ): Promise<LanAuthorityTransferRouteAdmissionResult<T>> {
    if (this.closed) return Promise.resolve({ admitted: false });
    return this.queue(projectId).run(async () => {
      if (this.closed || this.registrations.get(projectId) !== expected) {
        return { admitted: false };
      }
      return { admitted: true, value: await operation() };
    });
  }

  install(registration: LanAuthorityTransferRouteRegistration): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Authority-transfer routes are closed'));
    return this.queue(registration.projectId).run(async () => {
      if (this.closed) throw new Error('Authority-transfer routes are closed');
      const current = this.registrations.get(registration.projectId);
      if (current && current !== registration) {
        throw routeStateError('authority-transfer-route-conflict');
      }
      this.registrations.set(registration.projectId, registration);
    });
  }

  transition(input: LanAuthorityTransferRouteTransition): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Authority-transfer routes are closed'));
    assertTransition(input);
    return this.queue(input.next.projectId).run(async () => {
      if (this.closed) throw new Error('Authority-transfer routes are closed');
      if (this.registrations.get(input.next.projectId) !== input.expected) {
        throw routeStateError('authority-transfer-route-stale');
      }
      this.registrations.set(input.next.projectId, input.next);
    });
  }

  remove(
    projectId: CollabProjectId,
    expectedState?: LanAuthorityTransferRouteRegistration['state'],
  ): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    return this.queue(projectId).run(async () => {
      const current = this.registrations.get(projectId);
      if (!current || (expectedState && current.state !== expectedState)) return false;
      this.registrations.delete(projectId);
      return true;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.queues.values()].map(queue => queue.drain()));
    this.registrations.clear();
  }

  private queue(projectId: CollabProjectId): SerialTaskQueue {
    let queue = this.queues.get(projectId);
    if (!queue) {
      queue = new SerialTaskQueue();
      this.queues.set(projectId, queue);
    }
    return queue;
  }
}
