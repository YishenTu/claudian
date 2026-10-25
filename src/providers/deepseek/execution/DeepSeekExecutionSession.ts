import { randomUUID } from 'node:crypto';

import {
  PendingInteractionLedger,
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  RequestedRunChannel,
  SessionSnapshotState,
  type WithoutEventScope,
} from '@/core/execution';
import { isSessionToolPolicyAllowed } from '@/core/execution/ProviderSessionToolPort';
import { appendExecutionContext } from '@/core/prompt/promptContext';
import type { ProviderRuntimeHost } from '@/core/providers/ProviderRuntimeHost';
import { getActionDescription } from '@/core/security/approvalRules';
import { invokeSessionTool } from '@/core/session-tools/invokeSessionTool';
import type { SessionToolRoutedCallRequest } from '@/core/session-tools/SessionToolEndpoint';
import { SESSION_TOOL_SPECS, type SessionToolResult } from '@/core/session-tools/sessionToolSpecs';
import type { SlashCommand } from '@/core/types';
import { t } from '@/i18n/i18n';

import { readDeepSeekCommands } from '../commands/DeepSeekCommandCatalog';
import { decodeDeepSeekConfig } from '../config';
import { materializeDeepSeekToolImages } from '../history/DeepSeekImages';
import { readDeepSeekJournal, readDeepSeekProjection } from '../history/DeepSeekJournal';
import { decodeDeepSeekModelId } from '../models';
import { DeepSeekOutput, type DeepSeekOutputEvent, DeepSeekReplayError, deepseekText, type DeepSeekToolCall, deepseekToolName } from '../normalization/DeepSeekOutput';
import { DeepSeekSubagents } from '../normalization/DeepSeekSubagents';
import { DeepSeekRemoteError, isRecord } from '../remote/DeepSeekRemoteClient';
import { isSameDeepSeekHome } from '../runtime/DeepSeekHome';
import type { DeepSeekHost, DeepSeekHostLease } from '../runtime/DeepSeekHost';
import { assertDeepSeekModelAvailable } from '../runtime/DeepSeekModels';
import type { DeepSeekSessionToolAdmission } from '../runtime/DeepSeekRoster';
import { decodeDeepSeekState, type DeepSeekPreset, type DeepSeekProviderState, encodeDeepSeekCheckpoint, isDeepSeekAuxiliaryPreset, isDeepSeekPreset } from '../types';
import { applyDeepSeekPermission, type DeepSeekPermission, readDeepSeekPermission } from './DeepSeekPermissions';
import { DeepSeekSessionObserver } from './DeepSeekSessionObserver';

interface Request {
  readonly channel: RequestedRunChannel;
  readonly input: ProviderExecutionRequest;
  readonly abort: AbortController;
  delivery: 'unsent' | 'sending' | 'queued' | 'claimed';
  withdrawing?: boolean;
  admission?: Promise<void>;
  command?: boolean;
}
interface Turn {
  readonly native: number;
  readonly id: string;
  readonly startedAt: number;
  readonly output: DeepSeekOutput;
  readonly buffered: DeepSeekOutputEvent[];
  readonly sessionCalls: Map<string, string>;
  owner?: RequestedRunChannel | 'background';
  sequence: number;
  nativeUserId?: string;
  /** The request native claimed into this turn; prompt hooks can still end the turn before echoing it. */
  claimed?: Request;
}

interface ChildState {
  /** Set once from its parent's native creation catalog, never from whichever root turn happens to be running. */
  origin?: { readonly request: Request | undefined } | { readonly parent: ChildState };
  lastSeq: number;
  turn?: { native: number; id: string; sequence: number; interactionScope: boolean; abort: AbortController; sessionCalls: Map<string, string> };
}

/**
 * Input steered into the running requested turn. Native takes it into its next-step inbox; it joins the turn only when a
 * step boundary claims it, so the claim, not the acknowledgement, is acceptance.
 */
interface Steer {
  readonly id: string;
  readonly inputId?: string;
  readonly owner: RequestedRunChannel;
  /** The caller's answer; an unknown native disposition rejects it while tracking continues. */
  readonly answered: Promise<boolean>;
  answer(accepted: boolean | Error): void;
  /** Resolves once native disposition is known (claimed or removed) or the binding ends. */
  readonly released: Promise<void>;
  release(): void;
  withdrawal?: Promise<void>;
  /** The turn native claimed it into; prompt hooks can still end that turn before echoing it. */
  claimedBy?: Turn;
}

class AdmissionError extends Error {}

// Bounds how long a native interaction waits for its owner and call details.
const INTERACTION_DEADLINE_MS = 10_000;
// Covers the graceful exit of a Host left by a reloaded Claudian instance.
const WRITER_HANDOFF_MS = 5_000;
const EPHEMERAL_ENDED = 'This temporary DeepSeek session ended when DeepSeek restarted. Start a new one to continue.';

/** One claimed native session in the shared Host, one requested channel, and independently scoped automatic work. */
export class DeepSeekExecutionSession implements ProviderExecutionSession {
  readonly providerId = 'deepseek';
  readonly sessionInstanceId = randomUUID();
  private readonly snapshots: SessionSnapshotState;
  private readonly interactions: PendingInteractionLedger;
  private readonly lifetime = new AbortController();
  private lease?: DeepSeekHostLease;
  private observer?: DeepSeekSessionObserver;
  private nativeId?: string;
  private binding?: DeepSeekProviderState;
  private requested?: Request;
  private turn?: Turn;
  private readonly children = new Map<string, ChildState>();
  /** Native interactions awaiting ownership or call details, each with its own reconciliation deadline. */
  private readonly pendingNativeInteractions = new Map<string, { readonly value: Record<string, unknown>; readonly deadline: number }>();
  private interactionTimer?: number;
  private lastSequence = -1;
  private offLease: Array<() => void> = [];
  private generation = 0;
  private stopTask?: Promise<void>;
  private disposal?: Promise<void>;
  private detaching?: Promise<void>;
  /** A failed binding kept only so a Stop or closing can still end the native work the live process keeps. */
  private retained = false;
  // Only transcript divergence prevents rebinding after a failure.
  private reloadError?: DeepSeekReplayError;
  private publishedWork = false;
  private commands?: SlashCommand[];
  private permission?: DeepSeekPermission;
  private followQueue: Promise<void> = Promise.resolve();
  private readonly steers = new Map<string, Steer>();
  /** Inbox places of requested and steered input by request ID, followed through journal splices until native takes them out. */
  private readonly inboxPlaces = new Map<string, { readonly target: unknown; index: number }>();
  /** Native generation holding this session's in-memory identity; unset for sessions native stores. */
  private ephemeralGeneration?: number;
  private readonly subagents = new DeepSeekSubagents(subagent => this.snapshots.emit({ type: 'subagent_updated', subagent }));

  constructor(
    private readonly host: ProviderRuntimeHost,
    private readonly config: ProviderSessionConfig,
    private readonly deepseek: DeepSeekHost,
  ) {
    this.nativeId = config.resumeSeed?.providerSessionId;
    this.snapshots = new SessionSnapshotState({ providerId: this.providerId, sessionInstanceId: this.sessionInstanceId,
      providerState: config.resumeSeed?.providerState, readProviderSessionId: () => this.nativeId,
    });
    this.interactions = new PendingInteractionLedger(config.interactionPort);
  }

  getCommandSnapshot(): readonly SlashCommand[] | undefined { return this.commands?.map(command => ({ ...command })); }
  getSnapshot() { return this.snapshots.getSnapshot(); }
  getStatus() { return this.snapshots.status; }
  onEvent(listener: (event: ProviderSessionEvent) => void): () => void { return this.snapshots.onEvent(listener); }
  hasBackgroundWork(): boolean { return !!this.stopTask || !!this.detaching || (this.observer?.hasWork() ?? false); }

  execute(input: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.lifetime.signal.aborted) throw new Error('DeepSeek session is unavailable.');
    // A terminal request releases its slot after its admission settles; the next admission waits for that instead.
    const previous = this.requested;
    if (previous && !previous.channel.isTerminal) throw new Error('DeepSeek already has a requested execution.');
    const channel = new RequestedRunChannel({ sessionInstanceId: this.sessionInstanceId, onCancel: () => {
      const requested = this.requested;
      if (requested?.channel === channel) this.cancelRequest(requested);
    } });
    const requested: Request = { channel, input, abort: new AbortController(), delivery: 'unsent' };
    this.requested = requested;
    if (!this.reloadError) this.snapshots.setStatus('executing');
    channel.attachAbortSignal(input.signal);
    void channel.terminated.then(async () => {
      requested.abort.abort();
      await requested.admission;
      if (this.requested !== requested) return;
      this.requested = undefined;
      if (this.snapshots.status !== 'invalidated' && this.snapshots.status !== 'disposed') this.snapshots.setStatus(this.stopTask ? 'cancelling' : 'idle');
      this.publish();
    });
    requested.admission = (previous?.admission ?? Promise.resolve()).then(() => this.admit(requested)).catch(error => {
      if (channel.isTerminal) return;
      if (channel.isCancellationRequested && requested.delivery === 'unsent') { channel.finish({ type: 'cancelled' }); return; }
      if (error instanceof AdmissionError) {
        channel.finish({ type: 'execution_error', category: 'configuration', recoverable: true, message: error.message });
      } else void this.fail(error, isMissingSession(error) ? 'provider-session-missing' : requested.delivery === 'unsent' ? 'configuration' : 'transport');
    });
    return channel;
  }

  cancel(): void {
    // A finished request keeps its slot until its prompt is acknowledged; Stop then targets the work it started.
    if (this.requested && !this.requested.channel.isTerminal) { this.requested.channel.cancel(); return; }
    if (this.stopTask || !this.observer || this.lifetime.signal.aborted) return;
    // Stopping retained work does not revive a failed conversation.
    if (this.snapshots.status !== 'invalidated') this.snapshots.setStatus('cancelling');
    const task = this.stopBackground(this.lifetime.signal).catch(error => this.fail(error, 'transport')).finally(() => {
      if (this.stopTask === task) this.stopTask = undefined;
      if (this.snapshots.status === 'cancelling') this.snapshots.setStatus('idle');
      this.publish();
    });
    this.stopTask = task; this.publish();
  }

  /**
   * Steers input into the running requested turn. True once native claims it into that turn, or into its own turn when
   * the requested one ended first; false when it was never sent or native refused or gave it back.
   */
  async steer(input: ProviderExecutionRequest): Promise<boolean> {
    const requested = this.requested;
    const lease = this.lease;
    // Native would start a new turn for a steer that finds none running, so only a claimed, live request is steerable.
    if (input.signal.aborted || !requested || requested.command || requested.channel.isTerminal
      || requested.channel.isCancellationRequested || this.turn?.owner !== requested.channel || this.stopTask || this.detaching
      || !lease || !this.nativeId) return false;
    const steer = this.trackSteer(requested.channel, input.inputId);
    // The caller may give up at any point until native settles it, whatever the acknowledgement says.
    const abandon = (): void => { void this.withdrawSteer(steer); };
    input.signal.addEventListener('abort', abandon, { once: true });
    void steer.released.then(() => input.signal.removeEventListener('abort', abandon));
    try {
      const response = await lease.client.call('session/prompt', { request: {
        sessionId: this.nativeId, requestId: steer.id, mode: 'steer', content: encodeInput(input),
      } });
      if (!isRecord(response) || response.accepted !== true) throw new Error('DeepSeek did not acknowledge the steered message.');
    } catch (error) {
      // Only a native verdict proves the input never reached the inbox. Otherwise it may still be claimed or need
      // withdrawing, so tracking outlives the caller's unknown answer.
      if (error instanceof DeepSeekRemoteError && error.code !== undefined) { steer.answer(false); steer.release(); }
      else steer.answer(error instanceof Error ? error : new Error('DeepSeek steering failed.'));
    }
    if (input.signal.aborted || requested.channel.isTerminal || requested.channel.isCancellationRequested) void this.withdrawSteer(steer);
    return steer.answered;
  }

  /** Tracks one steer from its send until native claims or removes it, or the binding ends. */
  private trackSteer(owner: RequestedRunChannel, inputId?: string): Steer {
    let answer!: (accepted: boolean | Error) => void;
    // Only the first answer counts; the promise ignores later ones.
    const answered = new Promise<boolean>((resolve, reject) => {
      answer = accepted => { if (accepted instanceof Error) reject(accepted); else resolve(accepted); };
    });
    // The answer can precede the acknowledgement; callers observe it through the returned promise.
    answered.catch(() => undefined);
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const steer: Steer = { id: `steer-${randomUUID()}`, inputId, owner, answered, answer, released, release: () => { this.steers.delete(steer.id); release(); } };
    this.steers.set(steer.id, steer);
    // A turn that ends without claiming a steer gives it back.
    void owner.terminated.then(() => { if (this.steers.has(steer.id)) void this.withdrawSteer(steer); });
    return steer;
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.lifetime.abort(); this.requested?.abort.abort(); this.requested?.channel.finish({ type: 'cancelled' });
      this.interactions.dismissAll('session-disposed');
      this.snapshots.setStatus('disposed');
      // Leaving the conversation stops its native work.
      this.disposal = this.detach('stop').finally(() => this.snapshots.clearListeners());
    }
    return this.disposal;
  }

  private async admit(requested: Request): Promise<void> {
    await this.detaching;
    if (this.reloadError) throw new AdmissionError(this.reloadError.message);
    this.assertRequest(requested);
    const input = requested.input;
    if (input.toolPolicy.kind === 'allow-list') throw new AdmissionError('DeepSeek does not support arbitrary tool allow-lists.');
    if (this.stopTask) throw new AdmissionError('DeepSeek is stopping background work. Wait for Stop to finish before sending.');
    const prompt = await this.bind(requested);
    this.assertRequest(requested);
    const lease = this.lease!;
    const observer = this.observer!;
    // A transport reconnect rebaselines native state before any admission decision.
    await observer.waitUntil(() => observer.isReady(), 15_000, requested.abort.signal);
    this.assertRequest(requested);
    const oldQueue = observer.queuedItems(this.nativeId!).filter(item => item.source?.kind === 'user' && item.source.rpcId !== requested.channel.executionId);
    if (oldQueue.length) {
      const excerpts = oldQueue.slice(0, 3).map(item => deepseekText(item.content).replace(/\s+/g, ' ').slice(0, 160)).join('; ');
      throw new AdmissionError(`DeepSeek has ${oldQueue.length} pending message${oldQueue.length === 1 ? '' : 's'} from an earlier session: ${excerpts}. Use Escape or Stop to discard these ${oldQueue.length} pending messages, then resend your draft.`);
    }
    const desired = permissionFor(input);
    const current = this.permission ??= await readDeepSeekPermission(lease.client, this.nativeId!);
    if (current !== desired) {
      const assertBoundary = (): void => {
        this.assertRequest(requested);
        if (!observer.permissionBoundaryAvailable()) throw new AdmissionError('DeepSeek cannot change permissions while a turn, tool, or question is active. Use Stop, then resend your draft.');
      };
      assertBoundary();
      this.permission = await applyDeepSeekPermission(lease.client, this.nativeId!, desired, assertBoundary);
      this.snapshots.bumpRevision();
      requested.channel.emit({ type: 'permission_mode_changed', permissionMode: desired, snapshot: this.getSnapshot() });
    }
    this.assertRequest(requested);
    await this.selectModel(input);
    this.assertRequest(requested);
    const text = input.input.filter(block => block.type === 'text').map(block => block.text).join('\n');
    if (/^\/compact(?:\s|$)/.test(text) && this.commands?.some(command => command.kind === 'command' && command.name === 'compact')) {
      if (input.input.some(block => block.type === 'image') || input.context?.linkedContent || input.context?.sessionReferences?.length || input.context?.selections?.length) throw new AdmissionError('DeepSeek /compact does not accept attachments or linked context.');
      if (!observer.permissionBoundaryAvailable()) throw new AdmissionError('Use Stop before compacting an active DeepSeek conversation.');
      requested.command = true;
      requested.delivery = 'claimed';
      requested.channel.emit({ type: 'turn_started', accepted: true });
      // Native returns only after the model summary; aborting the HTTP request cancels it.
      const result = await lease.client.call('commands/execute', { agentId: this.nativeId, line: text, submittedAttachments: [] }, { signal: requested.abort.signal, timeoutMs: 'none' });
      if (!isRecord(result) || !isRecord(result.result) || result.result.kind !== 'success') {
        const message = isRecord(result) && isRecord(result.result) && typeof result.result.text === 'string' ? result.result.text : 'DeepSeek compaction failed.';
        requested.channel.finish({ type: 'execution_error', category: 'provider', recoverable: true, message });
      } else {
        requested.channel.emit({ type: 'text_delta', text: typeof result.result.text === 'string' ? result.result.text : 'Compaction completed.' });
        requested.channel.finish({ type: 'turn_completed', reason: 'provider-ended' });
      }
      return;
    }
    await lease.writePrompt(this.nativeId!, prompt);
    if (!isDeepSeekAuxiliaryPreset(this.binding!.preset)) await lease.writeCodeMode(decodeDeepSeekConfig(this.host.config).codeMode);
    this.assertRequest(requested);
    requested.delivery = 'sending';
    const response = await lease.client.call('session/prompt', { request: {
      sessionId: this.nativeId, requestId: requested.channel.executionId, mode: 'queue', content: encodeInput(input),
    } }).catch(error => {
      // rc.2 validates image support and attachment contents before admitting the message.
      if (error instanceof DeepSeekRemoteError && error.code === 'session/attachment-invalid' && requested.delivery === 'sending') {
        requested.delivery = 'unsent';
        throw new AdmissionError(error.message);
      }
      throw error;
    });
    if (!isRecord(response) || response.accepted !== true) throw new Error('DeepSeek did not acknowledge prompt admission. The request was not retried.');
    if (requested.delivery === 'sending') requested.delivery = 'queued';
  }

  /** Binds this conversation to its native session in the shared Host; returns the session's literal prompt. */
  private async bind(requested: Request): Promise<string> {
    const input = requested.input;
    const policy: DeepSeekPreset | undefined = input.toolPolicy.kind === 'passive' ? 'claudian-passive' : input.toolPolicy.kind === 'read-only' ? 'claudian-read-only' : undefined;
    const prompt = input.configuration.systemInstructions.instructions;
    // A retained binding only serves Stop and closing; sending rebinds with fresh native baselines. Its conversation
    // state already ended with the failure, so releasing it leaves this request alone.
    if (this.retained) this.release();
    if (!this.lease) await this.attach(requested, policy);
    const preset = this.binding!.preset;
    if ((policy && preset !== policy) || (!policy && isDeepSeekAuxiliaryPreset(preset))) {
      throw new AdmissionError('DeepSeek auxiliary tool policy cannot change within a session. Start a new auxiliary session.');
    }
    return prompt;
  }

  private async attach(requested: Request, policy: DeepSeekPreset | undefined): Promise<void> {
    const signal = AbortSignal.any([this.lifetime.signal, requested.abort.signal]);
    let lease: DeepSeekHostLease;
    // Nothing is bound yet: a failed startup ends this request only, and the next send starts again.
    try { lease = await this.deepseek.attach(signal); } catch (error) { throw new AdmissionError(error instanceof Error ? error.message : 'DeepSeek could not start.'); }
    const generation = ++this.generation;
    this.lease = lease;
    try {
      this.assertRequest(requested);
      const saved = this.binding ?? decodeDeepSeekState(this.config.resumeSeed?.providerState);
      if (saved && !isSameDeepSeekHome(saved.home, lease.home)) throw new AdmissionError('DeepSeek native history belongs to a different store. Restore its native store or select the original DeepSeek environment before continuing.');
      this.binding = saved ?? { schemaVersion: 1, home: lease.home, profile: lease.profile, preset: policy ?? 'claudian' };
      if (this.ephemeralGeneration !== undefined && this.ephemeralGeneration !== lease.generation) throw new AdmissionError(EPHEMERAL_ENDED);
      // The Host retires a lost process, which ends all of its native work; a retained binding has nothing left to stop.
      this.offLease.push(lease.onLost((loss, error) => {
        if (generation === this.generation) void this.fail(error, loss, true);
        else if (this.retained && this.lease === lease) this.release();
      }));
      this.offLease.push(lease.roster.onReset(() => { if (generation === this.generation) this.voidInteractions('superseded'); }));
      const deliver = (event: Record<string, unknown>): void => { if (generation === this.generation) this.remoteEvent(event); };
      if (this.nativeId) lease.claim(this.nativeId, deliver, (call, deadline) => this.captureSessionTool(call, deadline));
      const existingId = this.nativeId ?? this.binding.pendingFork?.sessionId;
      if (existingId) {
        const projection = await readDeepSeekProjection(lease.client, existingId);
        const nativePreset = projection.values.agentPreset;
        if (!isDeepSeekPreset(nativePreset)) throw new Error('DeepSeek native preset is missing or unsupported. The original conversation binding was retained.');
        if (saved && saved.preset !== nativePreset) throw new Error('DeepSeek native preset differs from the saved conversation binding. Restore the original native preset before continuing.');
        if (policy ? nativePreset !== policy : isDeepSeekAuxiliaryPreset(nativePreset)) throw new Error('DeepSeek native tool policy differs from the requested conversation policy.');
        this.binding = { ...this.binding, preset: nativePreset };
        this.permission = await readDeepSeekPermission(lease.client, existingId);
        // Claudian archive state is authoritative: a native archive left by a failed restore or dsh web would gate every turn.
        // A pending fork's source is another conversation, and its fork is an independent native root.
        // Native never archives an ephemeral session.
        if (this.nativeId && this.ephemeralGeneration === undefined) {
          await this.assertNativeDirectory(lease, this.nativeId, signal);
          await lease.client.call('workspace/unarchiveSession', { request: { sessionId: this.nativeId } });
        }
        this.assertRequest(requested);
      }
      // A new ephemeral identity is chosen once; without the Host's plugin it falls back to a stored session.
      const ephemeral = !this.nativeId && this.config.lifecycle === 'ephemeral' && this.config.nativePersistence !== 'enabled' && lease.ephemeral;
      if (this.binding.pendingFork) {
        // Leaving an ephemeral fork orphans only memory; a durable fork keeps the wait so it is never forked twice.
        this.nativeId = await lease.fork(this.binding.pendingFork, ephemeral, ephemeral ? signal : undefined); this.permission = undefined;
        if (ephemeral) this.ephemeralGeneration = lease.generation;
        lease.claim(this.nativeId, deliver, (call, deadline) => this.captureSessionTool(call, deadline));
        this.binding = { ...this.binding, pendingFork: undefined };
        this.snapshots.deleteProviderStateValue('pendingFork');
      } else {
        const created = await this.createNative(lease, signal, ephemeral ? lease.ephemeralSessionId() : undefined);
        if (!this.nativeId) lease.claim(created, deliver, (call, deadline) => this.captureSessionTool(call, deadline));
        this.nativeId = created;
        if (ephemeral) this.ephemeralGeneration = lease.generation;
      }
      this.saveBinding();
      this.observer = new DeepSeekSessionObserver(lease.client, lease.roster, this.nativeId, (id, frame) => {
        // Detaching ends this generation, so its frames are never applied; the observer then notifies at once for its own state.
        if (generation !== this.generation || this.detaching) return;
        return this.followQueue = this.followQueue.then(async () => {
          if (generation !== this.generation) return;
          if (id === this.nativeId) {
            if (frame.type === 'snapshot' && typeof frame.cursor === 'number' && this.lastSequence >= 0 && frame.cursor > this.lastSequence) {
              const missed = [];
              for await (const page of readDeepSeekJournal(lease.client, id, frame.cursor)) {
                missed.unshift(...page.filter(event => event.seq > this.lastSequence));
                if (page.some(event => event.seq <= this.lastSequence)) break;
              }
              if (generation !== this.generation) return;
              for (const event of missed) {
                const materialized = await materializeDeepSeekToolImages(lease.client, id, event);
                if (generation !== this.generation) return;
                this.record(materialized as unknown as Record<string, unknown>);
              }
            }
          }
          const materialized = await this.materializeFrame(id, frame);
          if (generation !== this.generation) return;
          if (id === this.nativeId) this.follow(materialized); else this.childFollow(id, materialized);
        }).catch(error => { if (generation === this.generation) return this.fail(error, 'transport'); });
      }, error => { if (generation === this.generation) void this.fail(error, 'transport'); });
      this.offLease.push(this.observer.onChange(() => { this.publish(); this.drainInteractions(); }));
      await this.observer.start(signal);
      await this.followQueue;
      this.commands = await readDeepSeekCommands(lease.client, this.nativeId);
      this.snapshots.emit({ type: 'commands_changed' });
      this.assertRequest(requested);
    } catch (error) {
      if (this.lease === lease) this.unbind();
      throw error;
    }
  }

  /** Native resumes a saved session in its own directory, so one copied with another vault must not run here. */
  private async assertNativeDirectory(lease: DeepSeekHostLease, sessionId: string, signal: AbortSignal): Promise<void> {
    const listed = await lease.client.call('session/list', { _request: {} }, { signal });
    if (!isRecord(listed) || !Array.isArray(listed.items)) throw new Error('Malformed DeepSeek session roster.');
    const cwd = listed.items.filter(isRecord).find(item => item.sessionId === sessionId)?.cwd;
    if (cwd !== this.config.workingDirectory) {
      throw new AdmissionError(`This DeepSeek conversation belongs to ${typeof cwd === 'string' ? `another directory (${cwd})` : 'an unknown directory'}. Open it from that vault, or start a new conversation.`);
    }
  }

  /** Creates or resumes the native session; a reloaded Claudian may still be releasing its writer. */
  private async createNative(lease: DeepSeekHostLease, signal: AbortSignal, ephemeralId?: string): Promise<string> {
    const resumed = this.nativeId;
    const request = { cwd: this.config.workingDirectory, agentPreset: this.binding!.preset, ...(ephemeralId ? { sessionId: ephemeralId } : {}) };
    const deadline = Date.now() + WRITER_HANDOFF_MS;
    for (let delay = 100; ; delay = Math.min(delay * 2, 1_000)) {
      try {
        // Native create reuses a named session only while it is blank; any call addressing a saved session resumes it.
        if (resumed) {
          await lease.client.call('commands/list', { agentId: resumed }, { signal });
          return resumed;
        }
        const created = await lease.client.call('session/create', { request }, { signal });
        if (!isRecord(created) || typeof created.sessionId !== 'string' || (ephemeralId && ephemeralId !== created.sessionId)) throw new Error('DeepSeek session identity changed during creation.');
        return created.sessionId;
      } catch (error) {
        // Only chat presets carry the user's additional rows; anything else native cannot mount is Claudian's own fault.
        if (error instanceof DeepSeekRemoteError && error.code === 'agent-preset/invalid' && !isDeepSeekAuxiliaryPreset(this.binding!.preset)
          && decodeDeepSeekConfig(this.host.config).presetPlugins.trim()) {
          throw new AdmissionError(`DeepSeek could not load its chat preset: ${error.message}. Check Additional preset plugins in the DeepSeek settings.`);
        }
        if (!(error instanceof DeepSeekRemoteError) || error.code !== 'session/writer-held') throw error;
        if (Date.now() + delay > deadline) throw new AdmissionError('This DeepSeek conversation is open in another DeepSeek Harness process, such as dsh web. Close it there, then resend your draft.');
        await new Promise(resolve => window.setTimeout(resolve, delay));
        signal.throwIfAborted();
      }
    }
  }

  private async selectModel(input: ProviderExecutionRequest): Promise<void> {
    const model = input.configuration.model;
    if (!model) {
      if (input.configuration.reasoning) throw new AdmissionError('Select a DeepSeek model before choosing reasoning effort.');
      return;
    }
    try { assertDeepSeekModelAvailable(this.host, model); } catch (error) { throw new AdmissionError(error instanceof Error ? error.message : 'DeepSeek model is unavailable.'); }
    const selection = decodeDeepSeekModelId(model);
    if (!selection) throw new AdmissionError('The selected model does not belong to DeepSeek Harness.');
    let effort = input.configuration.reasoning ?? undefined;
    if (input.configuration.reasoning === undefined) {
      // Omitted reasoning permits a default: a saved preference the native model still offers, else High, else native's own.
      const catalog = await this.lease!.client.call('session/modelCatalog');
      const groups = isRecord(catalog) && Array.isArray(catalog.groups) ? catalog.groups.filter(isRecord) : [];
      const group = groups.find(group => group.id === selection.provider);
      const native = Array.isArray(group?.models) ? group.models.filter(isRecord).find(item => item.id === selection.model) : undefined;
      const reasoning = isRecord(native?.reasoning) ? native.reasoning : undefined;
      const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts.filter(isRecord).map(item => item.id) : [];
      const preferred = decodeDeepSeekConfig(this.host.config).preferredReasoningByModel[model];
      effort = preferred && efforts.includes(preferred) ? preferred : efforts.includes('high') ? 'high' : undefined;
    }
    const response = await this.lease!.client.call('session/selectModel', { request: { sessionId: this.nativeId, ...selection, ...(effort ? { reasoningEffort: effort } : {}) } }).catch(error => {
      // rc.2 validates the selection before installing it, so this rejection leaves the session unchanged.
      if (error instanceof DeepSeekRemoteError && error.code === 'session/model-unavailable') throw new AdmissionError(error.message);
      throw error;
    });
    if (!isRecord(response) || !isRecord(response.selected) || response.selected.provider !== selection.provider || response.selected.model !== selection.model
      || (effort && response.selected.reasoningEffort !== effort)) throw new AdmissionError('DeepSeek could not honor the selected model and reasoning effort.');
  }

  private async materializeFrame(id: string, frame: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = this.lease!.client;
    if (frame.type === 'event' && isRecord(frame.event)) return { ...frame, event: await materializeDeepSeekToolImages(client, id, frame.event) };
    if (frame.type === 'snapshot' && Array.isArray(frame.records)) {
      const records = [];
      for (const record of frame.records) records.push(isRecord(record) && isRecord(record.event)
        ? { ...record, event: await materializeDeepSeekToolImages(client, id, record.event) } : record);
      return { ...frame, records };
    }
    return frame;
  }

  private follow(frame: Record<string, unknown>): void {
    if (frame.type === 'snapshot') {
      if (typeof frame.cursor !== 'number' || !Array.isArray(frame.records)) throw new Error('Malformed DeepSeek follow snapshot.');
      for (const record of frame.records) if (isRecord(record) && isRecord(record.event)) this.subagents.parent(record.event);
      if (this.lastSequence < 0) {
        // History hydration is a separate cold reader. Admit only an unfinished live turn here.
        const records = frame.records.filter(isRecord).map(record => record.event).filter(isRecord);
        const start = records.findLastIndex(event => event.type === 'turn/start');
        if (start >= 0 && !records.slice(start).some(event => event.type === 'turn/end')) {
          for (const event of records.slice(start)) this.record(event);
        }
        this.lastSequence = Math.max(this.lastSequence, frame.cursor);
      } else {
        for (const record of frame.records) if (isRecord(record) && isRecord(record.event)) this.record(record.event);
      }
      if (this.turn && frame.assistantStream !== undefined) { this.classify(); this.turn.output.baseline(frame.assistantStream); }
    } else if (frame.type === 'event' && isRecord(frame.event)) this.record(frame.event);
    else if (frame.type === 'assistant-stream') {
      this.classify();
      this.turn?.output.frame(frame.frame);
    }
  }

  private record(event: Record<string, unknown>): void {
    if (typeof event.seq !== 'number' || typeof event.type !== 'string' || !isRecord(event.data)) throw new Error('Malformed DeepSeek session event.');
    if (event.seq <= this.lastSequence) return;
    this.lastSequence = event.seq;
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') return;
    const data = event.data;
    // Native policy events invalidate the verified proof; ordinary turns need no history scan.
    if (event.type === 'sandbox/mode' || event.type === 'approval/policy') this.permission = undefined;
    this.subagents.parent(event);
    this.claimChild(event, { request: this.turn?.claimed });
    if (event.type === 'agent/inbox/spliced') { this.trackInbox(data); return; }
    if (event.type === 'turn/start') {
      if (this.turn) throw new Error('DeepSeek opened overlapping native turns.');
      if (typeof data.turn !== 'number') throw new Error('Missing DeepSeek turn identity.');
      const turn: Turn = { native: data.turn, id: randomUUID(), startedAt: typeof event.time === 'number' ? event.time : Date.now(),
        buffered: [], sequence: 0, sessionCalls: new Map(), output: new DeepSeekOutput(value => this.output(turn, value)),
      };
      this.turn = turn;
      return;
    }
    const turn = this.turn;
    if (!turn) return;
    if (event.type === 'user/message') {
      const source = isRecord(data.source) ? data.source : {};
      const requested = this.requested;
      const steer = source.kind === 'user' && typeof source.rpcId === 'string' ? this.steers.get(source.rpcId) : undefined;
      if (steer) {
        const message = { type: 'user_message_started' as const, inputId: steer.inputId, content: deepseekText(data.content), nativeUserMessageId: typeof data.id === 'string' ? data.id : undefined };
        // Native can claim an old steer alongside a newer request. Buffer until that turn's owner is known.
        this.output(turn, message);
        steer.answer(true); steer.release();
      } else if (source.kind === 'user' && requested && requested.channel.executionId === source.rpcId) {
        if (turn.owner && turn.owner !== requested.channel) throw new Error('DeepSeek request was claimed after output ownership was assigned.');
        requested.delivery = 'claimed'; turn.owner = requested.channel; turn.claimed = requested;
        turn.nativeUserId = typeof data.id === 'string' ? data.id : undefined;
        turn.owner.emit({ type: 'turn_started', accepted: true, nativeTurnId: String(turn.native), nativeUserMessageId: turn.nativeUserId });
        // Core treats the first echo as the submitted input; later ones are steers.
        turn.owner.emit({ type: 'user_message_started', content: deepseekText(data.content), nativeUserMessageId: turn.nativeUserId });
        turn.owner.emit({ type: 'session_state_changed', snapshot: this.getSnapshot() });
        this.flush(turn);
      } else if (source.kind === 'tool-jobs' || source.kind === 'subagent-settled') {
        this.output(turn, { type: 'task_notification', content: deepseekText(data.content) });
      }
      return;
    }
    if (event.type === 'turn/end') {
      const reason = isRecord(data.reason) ? data.reason : {};
      // Input the turn claimed but never echoed was discarded unrun.
      for (const steer of [...this.steers.values()]) if (steer.claimedBy === turn) { steer.answer(false); steer.release(); }
      if (!turn.owner && turn.claimed && turn.claimed === this.requested) { this.endUnechoed(turn, turn.claimed, reason); return; }
      if (reason.kind === 'error' || reason.kind === 'blocked') {
        const detail = isRecord(reason.error) && typeof reason.error.message === 'string' ? reason.error.message
          : 'DeepSeek could not complete the turn because the model response was blocked.';
        this.classify();
        if (turn.owner instanceof RequestedRunChannel) {
          turn.owner.finish({ type: 'execution_error', category: 'provider', recoverable: true, message: detail });
        } else {
          this.background(turn, { type: 'background_turn_completed', reason: 'provider-ended' });
          this.snapshots.emit({ type: 'session_error', category: 'provider', recoverable: true, message: detail });
        }
        this.turn = undefined; this.publish();
        this.recoverAfterAutomaticTurn(turn, `an automatic turn failed (${detail})`);
        return;
      }
      const completion = reason.kind === 'max-tokens' ? 'max-tokens' : reason.kind === 'completed' ? 'completed' : 'provider-ended';
      // A stopped turn is interrupted, as its journal's `turn/end` replays it.
      const stopped = reason.kind === 'aborted' || reason.kind === 'cancelled';
      this.classify();
      const checkpoint = encodeDeepSeekCheckpoint(event.seq);
      this.binding = { ...this.binding!, checkpointSeq: event.seq }; this.saveBinding();
      if (turn.owner instanceof RequestedRunChannel) {
        turn.owner.emit({ type: 'session_state_changed', snapshot: this.getSnapshot() });
        turn.owner.finish(turn.owner.isCancellationRequested || stopped ? { type: 'cancelled' } : {
          type: 'turn_completed', reason: completion, nativeUserMessageId: turn.nativeUserId,
          nativeAssistantId: checkpoint, nativeCheckpointId: checkpoint,
          turnStats: { outputTokens: turn.output.outputTokens, durationMs: Math.max(0, (typeof event.time === 'number' ? event.time : Date.now()) - turn.startedAt) },
        });
      } else this.background(turn, { type: 'background_turn_completed', reason: stopped ? 'interrupted' : completion, nativeAssistantId: checkpoint, nativeCheckpointId: checkpoint, providerSessionId: this.nativeId, snapshotRevision: this.snapshots.revision });
      this.turn = undefined; this.publish();
      if (stopped) this.recoverAfterAutomaticTurn(turn, 'an automatic turn was stopped');
      return;
    }
    if (event.type.startsWith('assistant/') || event.type.startsWith('tool/')) this.classify();
    this.trackSessionCall(turn.sessionCalls, event);
    turn.output.record(event);
  }

  /** Follows requested and steered input through one native inbox splice; removal without cancellation claims it into the open turn. */
  private trackInbox(splice: Record<string, unknown>): void {
    const start = splice.start;
    if (typeof start !== 'number') return;
    const inserted = Array.isArray(splice.inserted) ? splice.inserted : [];
    const removed = typeof splice.removedCount === 'number' ? splice.removedCount : 0;
    for (const [rpcId, place] of this.inboxPlaces) {
      if (place.target !== splice.target || start > place.index) continue;
      if (start + removed <= place.index) { place.index += inserted.length - removed; continue; }
      this.inboxPlaces.delete(rpcId);
      if (splice.outcome === 'canceled' || !this.turn) continue;
      const steer = this.steers.get(rpcId);
      if (steer) steer.claimedBy = this.turn;
      else if (this.requested?.channel.executionId === rpcId) this.turn.claimed = this.requested;
    }
    inserted.forEach((message, offset) => {
      const rpcId = isRecord(message) && isRecord(message.source) && message.source.kind === 'user' ? message.source.rpcId : undefined;
      if (typeof rpcId === 'string' && (this.steers.has(rpcId) || this.requested?.channel.executionId === rpcId)) {
        this.inboxPlaces.set(rpcId, { target: splice.target, index: start + offset });
      }
    });
  }

  /** Native discards input whose turn ends before echoing it, as when a prompt hook rejects it; its draft returns. */
  private endUnechoed(turn: Turn, requested: Request, reason: Record<string, unknown>): void {
    const detail = isRecord(reason.error) && typeof reason.error.message === 'string' ? reason.error.message : undefined;
    requested.channel.finish(requested.channel.isCancellationRequested || reason.kind === 'aborted' || reason.kind === 'cancelled' ? { type: 'cancelled' } : {
      type: 'execution_error', category: 'configuration', recoverable: true,
      message: detail ? `DeepSeek could not start your message: ${detail}. It was not sent; resend your draft.`
        : 'DeepSeek declined your message before running it, for example through a prompt hook. It was not sent; resend your draft.',
    });
    if (this.turn === turn) { this.turn = undefined; this.publish(); }
  }

  /** Native pauses with pending input retained after an automatic turn fails or is stopped; withdraw a waiting request so its draft returns. */
  private recoverAfterAutomaticTurn(turn: Turn, cause: string): void {
    const requested = this.requested;
    if (turn.owner !== 'background' || !requested || requested.command || (requested.delivery !== 'sending' && requested.delivery !== 'queued')) return;
    this.withdraw(requested, `DeepSeek paused after ${cause}. Your message was not sent; resend your draft.`);
  }

  private classify(): void {
    const turn = this.turn;
    if (!turn || turn.owner) return;
    turn.owner = 'background';
    this.background(turn, { type: 'background_turn_started', nativeTurnId: String(turn.native), providerSessionId: this.nativeId, snapshotRevision: this.snapshots.revision });
    this.flush(turn);
  }

  private flush(turn: Turn): void { for (const event of turn.buffered.splice(0)) this.output(turn, event); }

  private output(turn: Turn, event: DeepSeekOutputEvent): void {
    if (!turn.owner) { turn.buffered.push(event); return; }
    if (turn.owner instanceof RequestedRunChannel) turn.owner.emit(event);
    else this.background(turn, event);
  }

  private background(turn: Pick<Turn, 'id' | 'sequence'>, event: WithoutEventScope<ProviderSessionEvent> | DeepSeekOutputEvent): void {
    this.snapshots.notify({ ...event, scope: { kind: 'background', sessionInstanceId: this.sessionInstanceId, turnId: turn.id, sequence: ++turn.sequence } } as ProviderSessionEvent);
  }

  private child(id: string): ChildState {
    let child = this.children.get(id);
    if (!child) { child = { lastSeq: -1 }; this.children.set(id, child); }
    return child;
  }

  private claimChild(event: Record<string, unknown>, origin: NonNullable<ChildState['origin']>): void {
    if (event.type !== 'subagent/catalog' || !isRecord(event.data) || typeof event.data.childId !== 'string') return;
    const child = this.child(event.data.childId);
    // Keep the creating parent's identity even when its own catalog has not arrived on the independent stream.
    child.origin ??= origin;
  }

  private childFollow(id: string, frame: Record<string, unknown>): void {
    this.subagents.child(id, frame);
    const child = this.child(id);
    const records = frame.type === 'snapshot' && Array.isArray(frame.records)
      ? frame.records.filter(isRecord).map(record => record.event).filter(isRecord)
      : frame.type === 'event' && isRecord(frame.event) ? [frame.event] : [];
    for (const event of records) {
      if (typeof event.seq !== 'number' || event.seq <= child.lastSeq || !isRecord(event.data)) continue;
      child.lastSeq = event.seq;
      if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue;
      this.claimChild(event, { parent: child });
      if (event.type === 'turn/start' && typeof event.data.turn === 'number') {
        child.turn?.abort.abort();
        child.turn = { native: event.data.turn, id: randomUUID(), sequence: 0, interactionScope: false, abort: new AbortController(), sessionCalls: new Map() };
      } else if (event.type === 'turn/end') {
        const turn = child.turn;
        if (!turn || turn.native !== event.data.turn) continue;
        if (turn.interactionScope) this.background(turn, { type: 'background_turn_completed', reason: 'completed' });
        turn.abort.abort();
        child.turn = undefined;
      }
      if (child.turn) this.trackSessionCall(child.turn.sessionCalls, event);
    }
  }

  private childRequest(child: ChildState | undefined): Request | undefined {
    const seen = new Set<ChildState>();
    while (child && !seen.has(child)) {
      seen.add(child);
      const origin = child.origin;
      if (!origin) return undefined;
      if ('request' in origin) return origin.request;
      child = origin.parent;
    }
    return undefined;
  }

  /** Only calls still executing in this native turn can authorize the independent HTTP invocation. */
  private trackSessionCall(calls: Map<string, string>, event: Record<string, unknown>): void {
    const data = event.data;
    if (!isRecord(data)) return;
    const id = event.type === 'tool/call' ? data.callId : event.type === 'tool/ptc-dispatch-start' ? data.subCallId : undefined;
    if (typeof id === 'string' && typeof data.name === 'string' && SESSION_TOOL_SPECS.some(spec => spec.name === data.name)) calls.set(id, data.name);
    if (event.type === 'tool/result' && isRecord(data.message) && typeof data.message.toolCallId === 'string') calls.delete(data.message.toolCallId);
    if (event.type === 'tool/ptc-dispatch' && typeof data.subCallId === 'string') calls.delete(data.subCallId);
  }

  private captureSessionTool(call: SessionToolRoutedCallRequest, deadline: number): DeepSeekSessionToolAdmission | undefined {
    const requested = this.requested;
    if (!requested || !this.config.sessionTools || !this.observer || this.detaching
      || requested.channel.isTerminal || requested.channel.isCancellationRequested || !isSessionToolPolicyAllowed(requested.input.toolPolicy)) return undefined;
    const signal = AbortSignal.any([call.signal, this.lifetime.signal, requested.abort.signal, requested.input.signal]);
    if (signal.aborted) return undefined;
    return { signal, invoke: () => this.callSessionTool(call, requested, signal, deadline) };
  }

  private async callSessionTool(call: SessionToolRoutedCallRequest, requested: Request, signal: AbortSignal, deadline: number): Promise<SessionToolResult> {
    const envelope = call.args;
    if (!isRecord(envelope) || typeof envelope.callId !== 'string' || !envelope.callId) {
      return { isError: true, text: 'Missing DeepSeek session tool call identity.' };
    }
    const callId = envelope.callId;
    // The roster captured this request before discovery; matching native call/turn evidence must still prove ownership.
    const denied = (): Promise<SessionToolResult> => invokeSessionTool(call.name, envelope.args, { port: this.config.sessionTools, toolPolicy: undefined, signal });
    if (!this.observer) return denied();
    const isRoot = call.callerNativeId === this.nativeId;
    const readTurn = () => isRoot ? this.turn : this.children.get(call.callerNativeId)?.turn;
    let turn: ReturnType<typeof readTurn>;
    const active = () => Date.now() < deadline && !signal.aborted && !requested.channel.isTerminal && !requested.channel.isCancellationRequested && !this.detaching;
    const matches = () => {
      const current = readTurn();
      const declared = current?.sessionCalls.get(callId) === call.name;
      if (declared) turn ??= current;
      const owner = isRoot ? this.turn?.claimed : this.childRequest(this.children.get(call.callerNativeId));
      return { current, owner, declared };
    };
    try {
      await this.observer.waitUntil(() => {
        const { current, owner, declared } = matches();
        return !active() || (turn !== undefined && current !== turn) || (owner !== undefined && owner !== requested) || (owner === requested && declared);
      }, Math.max(0, deadline - Date.now()), signal);
    } catch {
      return { isError: true, text: 'DeepSeek session tool call ended or did not reconcile before the deadline.' };
    }
    const { current, owner, declared } = matches();
    if (!active() || !current || current !== turn || owner !== requested || !declared) return denied();
    const childTurn = isRoot ? undefined : this.children.get(call.callerNativeId)?.turn;
    return invokeSessionTool(call.name, envelope.args, {
      port: this.config.sessionTools, toolPolicy: requested.input.toolPolicy,
      signal: childTurn ? AbortSignal.any([signal, childTurn.abort.signal]) : signal,
    });
  }

  private remoteEvent(value: unknown): void {
    if (!isRecord(value) || typeof value.eventId !== 'string') return;
    if (value.type === 'cancel') {
      this.pendingNativeInteractions.delete(value.eventId);
      this.interactions.abort(value.eventId, 'cancelled'); this.observer?.setInteraction(value.eventId, undefined); return;
    }
    if (value.type !== 'waterfall' || typeof value.agentId !== 'string' || !isRecord(value.request)) return;
    if (value.event !== 'approval/request' && value.event !== 'user-questions/request') return;
    // The roster resolved ownership; the owning turn is known only once the follow channel catches up.
    this.pendingNativeInteractions.set(value.eventId, { value, deadline: Date.now() + INTERACTION_DEADLINE_MS });
    this.drainInteractions();
    this.armInteractionDeadline();
  }

  private armInteractionDeadline(): void {
    if (this.interactionTimer !== undefined || !this.pendingNativeInteractions.size) return;
    const next = Math.min(...[...this.pendingNativeInteractions.values()].map(pending => pending.deadline));
    this.interactionTimer = window.setTimeout(() => {
      this.interactionTimer = undefined;
      const now = Date.now();
      // Owned approvals whose call details never arrived fall back to their reason; unresolved ownership fails.
      this.drainInteractions(now);
      if ([...this.pendingNativeInteractions.values()].some(pending => pending.deadline <= now)) {
        void this.fail(new Error('DeepSeek interaction ownership did not reconcile before the deadline.'), 'transport');
      } else this.armInteractionDeadline();
    }, Math.max(0, next - Date.now()));
  }

  /** Presents interactions whose owner is known; `now` expires waits for call details that reached their deadline. */
  private drainInteractions(now?: number): void {
    for (const [id, { value, deadline }] of this.pendingNativeInteractions) {
      const agentId = value.agentId as string;
      if (!this.observer?.owns(agentId)) continue;
      const root = agentId === this.nativeId;
      if (!root && value.event === 'approval/request') {
        // Subagents keep the permission scope they started with (native approval policy `never`); decline instead of prompting.
        this.pendingNativeInteractions.delete(id);
        this.declineApproval(id);
        continue;
      }
      const child = root ? undefined : this.children.get(agentId)?.turn;
      if (root ? !this.turn || (!this.turn.owner && this.requested) : !child) continue;
      // Approvals and tool calls arrive on separate streams; wait for the call until the deadline.
      const callId = value.event === 'approval/request' && isRecord(value.request) && typeof value.request.callId === 'string' ? value.request.callId : undefined;
      const call = callId === undefined ? undefined : this.turn!.output.call(callId);
      if (callId !== undefined && !call && (now === undefined || deadline > now)) continue;
      let turnId: string;
      if (child) {
        if (!child.interactionScope) {
          child.interactionScope = true;
          this.background(child, { type: 'background_turn_started', nativeTurnId: String(child.native) });
        }
        turnId = child.id;
      } else {
        this.classify();
        turnId = this.turn!.owner instanceof RequestedRunChannel ? this.turn!.owner.turnId : this.turn!.id;
      }
      this.pendingNativeInteractions.delete(id);
      this.requestInteraction(value, turnId, call);
    }
    if (!this.pendingNativeInteractions.size && this.interactionTimer !== undefined) {
      window.clearTimeout(this.interactionTimer); this.interactionTimer = undefined;
    }
  }

  private declineApproval(eventId: string): void {
    const generation = this.generation;
    void this.lease!.client.call('$events/result', { clientId: this.lease!.client.clientId, eventId, outcome: { kind: 'result', value: 'rejected' } })
      .catch(error => { if (generation === this.generation) void this.fail(error, 'transport'); });
  }

  private requestInteraction(value: Record<string, unknown>, turnId: string, call?: DeepSeekToolCall): void {
    const eventId = value.eventId as string;
    const agentId = value.agentId as string;
    const pending = this.interactions.begin(eventId, this.lifetime.signal);
    if (!pending) return;
    this.observer!.setInteraction(eventId, agentId);
    const identity = { interactionId: eventId, sessionInstanceId: this.sessionInstanceId, turnId };
    const generation = this.generation;
    const nativeRequest = value.request as Record<string, unknown>;
    const questionInput = { ...nativeRequest,
      questions: Array.isArray(nativeRequest.questions) ? nativeRequest.questions.filter(isRecord).map(question => ({
        ...question, ...(!Array.isArray(question.options) || !question.options.length ? { isOther: true } : {}),
      })) : [],
    };
    const reason = localizedReason(nativeRequest, this.host.locale);
    const presentation = call
      ? { toolName: call.name, input: { ...call.input }, description: getActionDescription(call.name, call.input), ...(reason ? { decisionReason: reason } : {}) }
      : { toolName: typeof nativeRequest.toolName === 'string' ? deepseekToolName(nativeRequest.toolName) : 'DeepSeek tool', input: {}, description: reason ?? t('chat.approval.deepseekRequest') };
    const response = value.event === 'approval/request'
      ? this.config.interactionPort.requestApproval({ ...identity, kind: 'approval', ...presentation, decisionOptions: [{ label: t('chat.approval.allowOnce'), value: 'allow', decision: 'allow' }, { label: t('chat.approval.deny'), value: 'deny', decision: 'deny' }] }, pending.signal).then(answer => ({ answer, value: answer.decision === 'allow' || answer.decision === 'allow-always' ? 'allowed-once' : answer.decision === 'cancel' ? 'cancelled' : 'rejected' }))
      : this.config.interactionPort.askUserQuestion({ ...identity, kind: 'question', input: questionInput }, pending.signal).then(answer => ({ answer, value: questionAnswers(nativeRequest, answer.answers) }));
    void response.then(async ({ answer, value: result }) => {
      if (generation !== this.generation || this.interactions.isStaleResponse(pending, answer)) return;
      await this.lease!.client.call('$events/result', { clientId: this.lease!.client.clientId, eventId: pending.interactionId, outcome: { kind: 'result', value: result } });
      if (generation === this.generation) this.interactions.settle(pending, 'resolved');
    }).catch(error => { if (!pending.signal.aborted && generation === this.generation) void this.fail(error, 'transport'); }).finally(() => {
      if (generation === this.generation) this.observer?.setInteraction(pending.interactionId, undefined);
    });
  }

  private cancelRequest(requested: Request): void {
    requested.abort.abort();
    if (requested.delivery === 'unsent' || requested.command) {
      requested.channel.finish({ type: 'cancelled' }); return;
    }
    this.withdraw(requested);
  }

  /**
   * The single withdrawal of a sent request, shared by Stop and recovery after a failed automatic turn.
   * Only confirmed native removal makes it definitely unsent; a claimed request runs unless Stop was requested.
   */
  private withdraw(requested: Request, unsent?: string): void {
    if (requested.withdrawing || requested.channel.isTerminal) return;
    requested.withdrawing = true;
    void (async () => {
      const observer = this.observer!;
      const queued = () => observer.queuedItems(this.nativeId!).find(item => item.source?.rpcId === requested.channel.executionId);
      await observer.waitUntil(() => requested.channel.isTerminal || requested.delivery === 'claimed' || !!queued(), 10_000, this.lifetime.signal);
      if (requested.channel.isTerminal) return;
      if (requested.delivery !== 'claimed') {
        const item = queued();
        if (item) {
          if (await this.removeQueued(this.nativeId!, item.id)) {
            requested.channel.finish(unsent && !requested.channel.isCancellationRequested
              ? { type: 'execution_error', category: 'configuration', recoverable: true, message: unsent } : { type: 'cancelled' });
            return;
          }
          await observer.waitUntil(() => requested.delivery === 'claimed' || requested.channel.isTerminal, 10_000, this.lifetime.signal);
        }
      }
      if (requested.channel.isTerminal) return;
      if (!requested.channel.isCancellationRequested) {
        // Recovery yields to the claim; release the slot so a later Stop starts its own withdrawal.
        requested.withdrawing = false; return;
      }
      if (this.turn?.owner !== requested.channel) throw new Error('DeepSeek could not reconcile cancellation ownership.');
      // Cancel keeps native's inbox, so unclaimed steers would prefix the next prompt; they leave it first.
      await Promise.all([...this.steers.values()].filter(steer => steer.owner === requested.channel).map(steer => this.withdrawSteer(steer)));
      // The withdrawal can outlast the stopped turn; a later turn is not this Stop's to cancel.
      if (requested.channel.isTerminal || this.requested !== requested || this.turn?.owner !== requested.channel) return;
      await this.lease!.client.call('session/cancel', { request: { sessionId: this.nativeId } });
      await observer.waitUntil(() => requested.channel.isTerminal, 10_000, this.lifetime.signal);
    })().catch(error => { if (this.requested === requested && !requested.channel.isTerminal) return this.fail(error, 'transport'); });
  }

  /** Removes one pending native queue item; false when native no longer holds it, having claimed it first. */
  private async removeQueued(sessionId: string, itemId: string, options?: { signal: AbortSignal }): Promise<boolean> {
    try {
      const removal = await this.lease!.client.call('session/updateQueue', { request: { sessionId, itemId, action: { kind: 'remove' } } }, options);
      if (!isRecord(removal) || removal.accepted !== true) throw new Error('DeepSeek did not confirm removing the queued message.');
      return true;
    } catch (error) {
      if (error instanceof DeepSeekRemoteError && error.code === 'session/queue-item-not-found') return false;
      throw error;
    }
  }

  /**
   * The single withdrawal of an unclaimed steer, shared by its caller, Stop and its ended turn. Only native's confirmed
   * removal gives it back; anything unconfirmed answers unknown and keeps it tracked for a later claim or withdrawal.
   */
  private withdrawSteer(steer: Steer): Promise<void> {
    const tracked = (): boolean => this.steers.get(steer.id) === steer;
    if (!tracked()) return Promise.resolve();
    steer.withdrawal ??= (async () => {
      const observer = this.observer;
      if (!observer || !this.lease) throw new Error('DeepSeek connection ended before the steered message was confirmed.');
      const queued = () => observer.queuedItems(this.nativeId!).find(item => item.source?.rpcId === steer.id);
      await Promise.race([steer.released, observer.waitUntil(() => !tracked() || !!steer.claimedBy || !!queued(), 10_000, this.lifetime.signal)]);
      if (!tracked()) return;
      if (!steer.claimedBy) {
        const item = queued();
        if (!item) throw new Error('DeepSeek could not find the steered message to withdraw.');
        if (await this.removeQueued(this.nativeId!, item.id)) { steer.answer(false); steer.release(); return; }
      }
      // Native claimed it first; its echo or its turn's end releases the steer.
      await Promise.race([steer.released, new Promise<void>(resolve => window.setTimeout(resolve, 10_000))]);
      if (tracked()) throw new Error('DeepSeek steered message was neither withdrawn nor claimed.');
    })().catch(error => {
      steer.answer(error instanceof Error ? error : new Error('DeepSeek could not withdraw the steered message.'));
      // A later Stop or claim may still settle it.
      steer.withdrawal = undefined;
    });
    return steer.withdrawal;
  }

  private async stopBackground(signal?: AbortSignal): Promise<void> {
    const observer = this.observer!;
    const roster = this.lease!.roster;
    // Host recovery pauses Stop's deadline: the Host either reconnects, so Stop resumes, or retires
    // the process, which ends its work.
    const remaining = observer.connectedBudget(10_000);
    const options = (): { signal: AbortSignal } => ({ signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    const killed = new Set<string>();
    while (observer.hasWork()) {
      if (roster.disposed) throw new Error('DeepSeek process ended before background Stop settled.');
      if (remaining() <= 0) throw new Error('DeepSeek background Stop did not settle. Reopen the conversation to recover its native state.');
      const agents = [...observer.activeAgents()].reverse();
      for (const agent of agents) {
        if (agent.running && (!agent.parent || agent.mode === 'continuable')) await this.lease!.client.call(agent.parent ? 'subagents/interruptByParent' : 'session/cancel', agent.parent
          ? { childSessionId: agent.id, parentSessionId: agent.parent, mode: 'continuable' }
          : { request: { sessionId: agent.id } }, options());
        for (const item of observer.queuedItems(agent.id)) {
          const steer = agent.id === this.nativeId && item.source?.rpcId ? this.steers.get(item.source.rpcId) : undefined;
          if (steer) { await this.withdrawSteer(steer); continue; }
          await this.removeQueued(agent.id, item.id, options());
        }
      }
      for (const job of observer.ownedJobs()) {
        const key = `${job.owner}:${job.id}`;
        if (killed.has(key)) continue;
        await this.lease!.client.call('job/kill', { request: { sessionId: job.owner, jobId: job.id } }, options()); killed.add(key);
      }
      if (!observer.hasWork()) break;
      // Yield until authoritative native updates arrive; the deadline bounds stalled producers.
      await new Promise<void>(resolve => {
        const finish = (): void => { window.clearTimeout(timer); off(); resolve(); };
        const off = observer.onChange(finish);
        const timer = window.setTimeout(finish, Math.min(100, Math.max(1, remaining())));
      });
    }
    this.interactions.dismissAll('cancelled');
  }

  /**
   * Failing ends this conversation's binding, never its native work: the live process keeps that work and rebinding
   * observes it again. Only the user's intent stops work: a Stop still in progress here, or closing the conversation.
   */
  private async fail(error: unknown, category: 'configuration' | 'transport' | 'process-exited' | 'provider-session-missing', processEnded = false): Promise<void> {
    if (this.snapshots.status === 'disposed' || this.snapshots.status === 'invalidated') return;
    // Decided before finishing the requested run, whose pending Stop is part of the intent.
    const mode = processEnded || this.observer?.failed ? 'release' : this.stopInProgress() ? 'stop' : 'retain';
    if (error instanceof DeepSeekReplayError) this.reloadError = error;
    const message = error instanceof Error ? error.message : 'DeepSeek execution failed.';
    this.requested?.channel.finish({ type: 'execution_error', category, message, recoverable: true, ...(category === 'provider-session-missing' ? { missingProviderSessionId: this.nativeId } : {}) });
    this.snapshots.invalidate({ reason: category === 'process-exited' ? 'process-exited' : category === 'provider-session-missing' ? 'provider-session-missing' : 'transport-closed', recoverable: true, message });
    this.snapshots.emit({ type: 'session_error', category, message, recoverable: true });
    this.interactions.dismissAll('native-rejected');
    await this.detach(mode);
  }

  /** A background Stop, or a Stop of the requested run that has not ended; a cancelled request that already ended authorizes nothing. */
  private stopInProgress(): boolean {
    const channel = this.requested?.channel;
    return !!this.stopTask || (!!channel && channel.isCancellationRequested && !channel.isTerminal);
  }

  /**
   * Ends this binding. `stop` first stops its native work; `retain` keeps the lease, claim and observer so a later Stop or
   * closing can; `release` lets go of a binding with nothing left to stop.
   */
  private detach(mode: 'stop' | 'retain' | 'release'): Promise<void> {
    if (this.detaching) return this.detaching;
    const observer = this.observer;
    const task = (async () => {
      if (mode !== 'stop' || !observer) return;
      try {
        // Job rows refresh after every turn; decide only on reconciled state.
        await observer.waitUntil(() => observer.isReady(), 5_000);
        if (observer.hasWork()) await this.stopBackground();
      } catch {
        // Unconfirmed native work ends with the shared Host; the session is already retired.
      }
    })().finally(() => {
      if (this.detaching === task) this.detaching = undefined;
      if (mode === 'retain' && this.lease) { this.endBinding(); this.retained = true; } else this.unbind();
    });
    this.detaching = task;
    this.publish();
    return task;
  }

  private unbind(): void {
    this.endBinding();
    this.release();
  }

  /** Lets go of the lease, claim and observer. */
  private release(): void {
    this.retained = false;
    for (const off of this.offLease.splice(0)) off();
    this.observer?.dispose(); this.observer = undefined;
    this.lease?.release(); this.lease = undefined;
    if (this.commands) { this.commands = undefined; this.snapshots.emit({ type: 'commands_changed' }); }
    this.publish();
  }

  /** Ends this conversation's view of the binding; the observer keeps tracking native work while it is retained. */
  private endBinding(): void {
    ++this.generation;
    this.requested?.abort.abort();
    for (const steer of [...this.steers.values()]) { steer.answer(new Error('DeepSeek connection ended before the steered message was confirmed.')); steer.release(); }
    if (this.turn?.owner === 'background') this.background(this.turn, { type: 'background_turn_completed', reason: 'provider-ended' });
    for (const child of this.children.values()) {
      child.turn?.abort.abort();
      if (child.turn?.interactionScope) this.background(child.turn, { type: 'background_turn_completed', reason: 'provider-ended' });
    }
    this.turn = undefined; this.permission = undefined; this.lastSequence = -1; this.followQueue = Promise.resolve();
    this.children.clear(); this.subagents.clear(); this.inboxPlaces.clear();
    this.voidInteractions();
    this.observer?.clearInteractions();
    this.publish();
  }

  /** Native interactions are void once their transport or binding is gone. */
  private voidInteractions(reason?: 'superseded'): void {
    this.pendingNativeInteractions.clear();
    if (this.interactionTimer !== undefined) window.clearTimeout(this.interactionTimer);
    this.interactionTimer = undefined;
    if (reason) this.interactions.dismissAll(reason);
  }

  private assertRequest(requested: Request): void {
    if (this.requested !== requested || requested.channel.isTerminal || requested.channel.isCancellationRequested || this.lifetime.signal.aborted) throw new Error('DeepSeek request cancelled before admission.');
  }

  private saveBinding(): void {
    for (const [key, value] of Object.entries(this.binding!)) if (value !== undefined) this.snapshots.setProviderStateValue(key, value);
    this.snapshots.bumpRevision(); this.publish();
  }

  private publish(): void {
    const work = this.hasBackgroundWork();
    if (work !== this.publishedWork) { this.publishedWork = work; this.snapshots.bumpRevision(); }
    this.snapshots.emit({ type: 'session_state_changed', snapshot: this.getSnapshot() });
  }
}

function permissionFor(input: ProviderExecutionRequest): DeepSeekPermission {
  if (input.toolPolicy.kind === 'unrestricted') return 'yolo';
  if (input.toolPolicy.kind === 'read-only' || input.toolPolicy.kind === 'passive') return 'read-only';
  const mode = input.configuration.permissionMode ?? 'normal';
  if (mode !== 'normal' && mode !== 'yolo') throw new AdmissionError('Unsupported DeepSeek permission mode. Choose Workspace write or Full access.');
  return mode;
}

function encodeInput(input: ProviderExecutionRequest): unknown[] {
  const text = appendExecutionContext(input.input.filter(block => block.type === 'text').map(block => block.text).join('\n'), input.context);
  return [{ type: 'text', text }, ...input.input.flatMap(block => block.type === 'image' ? [{ type: 'image', mediaType: block.image.mediaType, data: block.image.data, name: block.image.name }] : [])];
}

/** Native localized explanation: configured locale, its base language, English, then the raw reason. */
function localizedReason(request: Record<string, unknown>, locale: string): string | undefined {
  const display = isRecord(request.displayReason) ? request.displayReason : {};
  // Native `zh` is Simplified Chinese, so Traditional Chinese never falls back to it.
  const keys = locale === 'zh-TW' ? [locale, 'zh-Hant', 'en'] : [locale, locale.split('-')[0], 'en'];
  const text = keys.map(key => display[key]).find(value => typeof value === 'string' && value);
  return typeof text === 'string' ? text : typeof request.reason === 'string' && request.reason ? request.reason : undefined;
}

function questionAnswers(request: Record<string, unknown>, answers: Record<string, string | string[]> | null): unknown {
  return { answers: Array.isArray(request.questions) ? request.questions.filter(isRecord).map(question => {
    const id = typeof question.id === 'string' ? question.id : '';
    const text = typeof question.question === 'string' ? question.question : '';
    // Own-key reads keep inherited entries out; the string check and ?? retain the
    // original question-text fallback, including an own empty-string text key.
    const value = (answers && Object.hasOwn(answers, id) ? answers[id] : undefined)
      ?? (answers && typeof question.question === 'string' && Object.hasOwn(answers, text) ? answers[text] : undefined);
    const values = Array.isArray(value) ? value : value ? [value] : [];
    const options = Array.isArray(question.options) ? question.options.filter(isRecord).map(option => option.label) : [];
    const selected = values.filter(value => options.includes(value));
    const custom = values.filter(value => !options.includes(value)).join('\n');
    return { id, selected, ...(custom ? { custom } : {}) };
  }) : [] };
}

/** Projections report a missing session as `session/missing`; resolving one to resume it reports `session/not-found`. */
function isMissingSession(error: unknown): boolean {
  return error instanceof DeepSeekRemoteError && (error.code === 'session/missing' || error.code === 'session/not-found');
}
