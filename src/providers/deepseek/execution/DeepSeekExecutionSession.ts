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
import { buildSystemPrompt } from '@/core/prompt/mainAgent';
import { appendLinkedContent, appendLinkedContentBody, appendSelectionContexts, appendSessionReferences, captureSelectionSnapshots } from '@/core/prompt/promptContext';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import { getActionDescription } from '@/core/security/approvalRules';
import type { SlashCommand } from '@/core/types';

import { readDeepSeekCommands } from '../commands/DeepSeekCommandCatalog';
import { materializeDeepSeekToolImages } from '../history/DeepSeekImages';
import { readDeepSeekJournal, readDeepSeekProjection } from '../history/DeepSeekJournal';
import { decodeDeepSeekModelId } from '../models';
import { DeepSeekOutput, type DeepSeekOutputEvent, DeepSeekReplayError, deepseekText, type DeepSeekToolCall, deepseekToolName } from '../normalization/DeepSeekOutput';
import { DeepSeekSubagents } from '../normalization/DeepSeekSubagents';
import { DeepSeekRemoteError, isRecord } from '../remote/DeepSeekRemoteClient';
import type { DeepSeekHost, DeepSeekHostLease } from '../runtime/DeepSeekHost';
import { assertDeepSeekModelAvailable } from '../runtime/DeepSeekModels';
import { getDeepSeekProviderSettings } from '../settings';
import { bindDeepSeekState, decodeDeepSeekState, type DeepSeekPreset, type DeepSeekProviderState, encodeDeepSeekCheckpoint, isDeepSeekPreset } from '../types';
import { applyDeepSeekPermission, type DeepSeekPermission, readDeepSeekPermission } from './DeepSeekPermissions';
import { DeepSeekSessionObserver } from './DeepSeekSessionObserver';

interface Request {
  readonly channel: RequestedRunChannel;
  readonly input: ProviderExecutionRequest;
  readonly abort: AbortController;
  delivery: 'unsent' | 'sending' | 'queued' | 'claimed';
  cancellation?: Promise<void>;
  admission?: Promise<void>;
  command?: boolean;
}
interface Turn {
  readonly native: number;
  readonly id: string;
  readonly startedAt: number;
  readonly output: DeepSeekOutput;
  readonly buffered: DeepSeekOutputEvent[];
  owner?: RequestedRunChannel | 'background';
  sequence: number;
  nativeUserId?: string;
}

class AdmissionError extends Error {}

// Bounds how long a native interaction waits for its owner and call details.
const INTERACTION_DEADLINE_MS = 10_000;
// Covers the graceful exit of a Host left by a reloaded Claudian instance.
const WRITER_HANDOFF_MS = 5_000;

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
  private readonly childTurns = new Map<string, { native: number; id: string; sequence: number; interactionScope: boolean }>();
  /** Native interactions awaiting ownership or call details, each with its own reconciliation deadline. */
  private readonly pendingNativeInteractions = new Map<string, { readonly value: Record<string, unknown>; readonly deadline: number }>();
  private interactionTimer?: number;
  private lastSequence = -1;
  private offLease: Array<() => void> = [];
  private generation = 0;
  private stopTask?: Promise<void>;
  private disposal?: Promise<void>;
  private detaching?: Promise<void>;
  // Only transcript divergence prevents rebinding after a failure.
  private reloadError?: DeepSeekReplayError;
  private publishedWork = false;
  private commands?: SlashCommand[];
  private permission?: DeepSeekPermission;
  private followQueue: Promise<void> = Promise.resolve();
  private readonly subagents = new DeepSeekSubagents(subagent => this.snapshots.emit({ type: 'subagent_updated', subagent }));

  constructor(
    private readonly host: ProviderHost,
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
      await requested.admission;
      if (this.requested !== requested) return;
      this.requested = undefined;
      if (this.snapshots.status !== 'invalidated' && this.snapshots.status !== 'disposed') this.snapshots.setStatus('idle');
      this.publish();
    });
    requested.admission = (previous?.admission ?? Promise.resolve()).then(() => this.admit(requested)).catch(error => {
      if (channel.isTerminal) return;
      if (channel.isCancellationRequested && requested.delivery === 'unsent') { channel.finish({ type: 'cancelled' }); return; }
      if (error instanceof AdmissionError) {
        channel.finish({ type: 'execution_error', category: 'configuration', recoverable: true, message: error.message });
      } else void this.fail(error, error instanceof DeepSeekRemoteError && error.code === 'session/missing' ? 'provider-session-missing' : requested.delivery === 'unsent' ? 'configuration' : 'transport');
    });
    return channel;
  }

  cancel(): void {
    if (this.requested) { this.requested.channel.cancel(); return; }
    if (this.stopTask || !this.observer || this.lifetime.signal.aborted) return;
    this.snapshots.setStatus('cancelling');
    const task = this.stopBackground(this.lifetime.signal).catch(error => this.fail(error, 'transport')).finally(() => {
      if (this.stopTask === task) this.stopTask = undefined;
      if (this.snapshots.status === 'cancelling') this.snapshots.setStatus('idle');
      this.publish();
    });
    this.stopTask = task; this.publish();
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.lifetime.abort(); this.requested?.abort.abort(); this.requested?.channel.finish({ type: 'cancelled' });
      this.interactions.dismissAll('session-disposed');
      this.snapshots.setStatus('disposed');
      // Leaving the conversation stops its native work.
      this.disposal = this.detach(true).finally(() => this.snapshots.clearListeners());
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
      if (input.input.some(block => block.type === 'image') || input.context?.linkedContent || input.context?.sessionReferences?.length || captureSelectionSnapshots(input.context).length) throw new AdmissionError('DeepSeek /compact does not accept attachments or linked context.');
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
    await lease.writePrompt(this.binding!.preset, prompt);
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

  /** Binds this conversation to its native session in the shared Host; returns the preset's literal prompt. */
  private async bind(requested: Request): Promise<string> {
    const settings = this.host.settings;
    const input = requested.input;
    const policy: DeepSeekPreset | undefined = input.toolPolicy.kind === 'passive' ? 'claudian-passive' : input.toolPolicy.kind === 'read-only' ? 'claudian-read-only' : undefined;
    const prompt = input.configuration.systemInstructions.kind === 'explicit' ? input.configuration.systemInstructions.instructions
      : buildSystemPrompt({ customPrompt: settings.systemPrompt, mediaFolder: settings.mediaFolder, userName: settings.userName, vaultPath: this.config.vaultWorkingDirectory });
    if (!this.lease) await this.attach(requested, policy);
    const preset = this.binding!.preset;
    if ((policy && preset !== policy) || (!policy && (preset === 'claudian-passive' || preset === 'claudian-read-only'))) {
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
      if (saved && saved.home !== lease.home) throw new AdmissionError('DeepSeek native history belongs to a different store. Restore its native store or select the original DeepSeek environment before continuing.');
      this.binding = bindDeepSeekState(saved, { home: lease.home, codeMode: getDeepSeekProviderSettings(this.host.settings).codeMode, preset: policy });
      // The Host retires a lost process, which ends all of its native work.
      this.offLease.push(lease.onLost((loss, error) => { if (generation === this.generation) void this.fail(error, loss, false); }));
      this.offLease.push(lease.roster.onReset(() => { if (generation === this.generation) this.voidInteractions('superseded'); }));
      const deliver = (event: Record<string, unknown>): void => { if (generation === this.generation) this.remoteEvent(event); };
      if (this.nativeId) lease.claim(this.nativeId, deliver);
      const existingId = this.nativeId ?? this.binding.pendingFork?.sessionId;
      if (existingId) {
        const projection = await readDeepSeekProjection(lease.client, existingId);
        const nativePreset = projection.values.agentPreset;
        if (!isDeepSeekPreset(nativePreset)) throw new Error('DeepSeek native preset is missing or unsupported. The original conversation binding was retained.');
        if (saved && saved.preset !== nativePreset) throw new Error('DeepSeek native preset differs from the saved conversation binding. Restore the original native preset before continuing.');
        if (policy ? nativePreset !== policy : nativePreset === 'claudian-passive' || nativePreset === 'claudian-read-only') throw new Error('DeepSeek native tool policy differs from the requested conversation policy.');
        this.binding = { ...this.binding, preset: nativePreset };
        this.permission = await readDeepSeekPermission(lease.client, existingId);
        this.assertRequest(requested);
      }
      if (this.binding.pendingFork) {
        const fork = await lease.client.call('session/fork', { request: this.binding.pendingFork });
        if (!isRecord(fork) || typeof fork.sessionId !== 'string') throw new Error('Malformed DeepSeek fork response.');
        this.nativeId = fork.sessionId; this.permission = undefined;
        lease.claim(this.nativeId, deliver);
        this.binding = { ...this.binding, pendingFork: undefined };
        this.snapshots.deleteProviderStateValue('pendingFork');
      } else {
        const created = await this.createNative(lease, signal);
        if (!this.nativeId) lease.claim(created, deliver);
        this.nativeId = created;
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

  /** Creates or resumes the native session; a reloaded Claudian may still be releasing its writer. */
  private async createNative(lease: DeepSeekHostLease, signal: AbortSignal): Promise<string> {
    const request = { cwd: this.config.vaultWorkingDirectory, agentPreset: this.binding!.preset, ...(this.nativeId ? { sessionId: this.nativeId } : {}) };
    const deadline = Date.now() + WRITER_HANDOFF_MS;
    for (let delay = 100; ; delay = Math.min(delay * 2, 1_000)) {
      try {
        const created = await lease.client.call('session/create', { request }, { signal });
        if (!isRecord(created) || typeof created.sessionId !== 'string' || (this.nativeId && this.nativeId !== created.sessionId)) throw new Error('DeepSeek session identity changed during resume.');
        return created.sessionId;
      } catch (error) {
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
    try { assertDeepSeekModelAvailable(this.host.settings, model); } catch (error) { throw new AdmissionError(error instanceof Error ? error.message : 'DeepSeek model is unavailable.'); }
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
      const preferred = getDeepSeekProviderSettings(this.host.settings).preferredReasoningByModel[model];
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
    if (event.type === 'turn/start') {
      if (this.turn) throw new Error('DeepSeek opened overlapping native turns.');
      if (typeof data.turn !== 'number') throw new Error('Missing DeepSeek turn identity.');
      const turn: Turn = { native: data.turn, id: randomUUID(), startedAt: typeof event.time === 'number' ? event.time : Date.now(),
        buffered: [], sequence: 0, output: new DeepSeekOutput(value => this.output(turn, value)),
      };
      this.turn = turn;
      return;
    }
    const turn = this.turn;
    if (!turn) return;
    if (event.type === 'user/message') {
      const source = isRecord(data.source) ? data.source : {};
      const requested = this.requested;
      if (source.kind === 'user' && requested && requested.channel.executionId === source.rpcId) {
        if (turn.owner && turn.owner !== requested.channel) throw new Error('DeepSeek request was claimed after output ownership was assigned.');
        requested.delivery = 'claimed'; turn.owner = requested.channel;
        turn.nativeUserId = typeof data.id === 'string' ? data.id : undefined;
        turn.owner.emit({ type: 'turn_started', accepted: true, nativeTurnId: String(turn.native), nativeUserMessageId: turn.nativeUserId });
        turn.owner.emit({ type: 'session_state_changed', snapshot: this.getSnapshot() });
        this.flush(turn);
      } else if (source.kind === 'tool-jobs' || source.kind === 'subagent-settled') {
        this.output(turn, { type: 'task_notification', content: deepseekText(data.content) });
      }
      return;
    }
    if (event.type === 'turn/end') {
      const reason = isRecord(data.reason) ? data.reason : {};
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
      this.classify();
      const checkpoint = encodeDeepSeekCheckpoint(event.seq);
      this.binding = { ...this.binding!, checkpointSeq: event.seq }; this.saveBinding();
      if (turn.owner instanceof RequestedRunChannel) {
        turn.owner.emit({ type: 'session_state_changed', snapshot: this.getSnapshot() });
        turn.owner.finish(turn.owner.isCancellationRequested || reason.kind === 'aborted' || reason.kind === 'cancelled' ? { type: 'cancelled' } : {
          type: 'turn_completed', reason: completion, nativeUserMessageId: turn.nativeUserId,
          nativeAssistantId: checkpoint, nativeCheckpointId: checkpoint,
          turnStats: { outputTokens: turn.output.outputTokens, durationMs: Math.max(0, (typeof event.time === 'number' ? event.time : Date.now()) - turn.startedAt) },
        });
      } else this.background(turn, { type: 'background_turn_completed', reason: completion, nativeAssistantId: checkpoint, nativeCheckpointId: checkpoint, providerSessionId: this.nativeId, snapshotRevision: this.snapshots.revision });
      this.turn = undefined; this.publish();
      if (reason.kind === 'aborted' || reason.kind === 'cancelled') this.recoverAfterAutomaticTurn(turn, 'an automatic turn was stopped');
      return;
    }
    if (event.type.startsWith('assistant/') || event.type.startsWith('tool/')) this.classify();
    turn.output.record(event);
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

  private background(turn: Turn, event: WithoutEventScope<ProviderSessionEvent> | DeepSeekOutputEvent): void {
    this.snapshots.notify({ ...event, scope: { kind: 'background', sessionInstanceId: this.sessionInstanceId, turnId: turn.id, sequence: ++turn.sequence } } as ProviderSessionEvent);
  }

  private childFollow(id: string, frame: Record<string, unknown>): void {
    this.subagents.child(id, frame);
    const records = frame.type === 'snapshot' && Array.isArray(frame.records)
      ? frame.records.filter(isRecord).map(record => record.event).filter(isRecord)
      : frame.type === 'event' && isRecord(frame.event) ? [frame.event] : [];
    for (const event of records) {
      if (!isRecord(event.data)) continue;
      if (event.type === 'turn/start' && typeof event.data.turn === 'number') {
        const previous = this.childTurns.get(id);
        if (previous?.native === event.data.turn) continue;
        this.childTurns.set(id, { native: event.data.turn, id: randomUUID(), sequence: 0, interactionScope: false });
      } else if (event.type === 'turn/end') {
        const turn = this.childTurns.get(id);
        if (!turn || turn.native !== event.data.turn) continue;
        if (turn.interactionScope) this.snapshots.notify({ type: 'background_turn_completed', reason: 'completed',
          scope: { kind: 'background', sessionInstanceId: this.sessionInstanceId, turnId: turn.id, sequence: ++turn.sequence } });
        this.childTurns.delete(id);
      }
    }
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
      const child = root ? undefined : this.childTurns.get(agentId);
      if (root ? !this.turn || (!this.turn.owner && this.requested) : !child) continue;
      // Approvals and tool calls arrive on separate streams; wait for the call until the deadline.
      const callId = value.event === 'approval/request' && isRecord(value.request) && typeof value.request.callId === 'string' ? value.request.callId : undefined;
      const call = callId === undefined ? undefined : root ? this.turn!.output.call(callId) : this.subagents.call(agentId, callId);
      if (callId !== undefined && !call && (now === undefined || deadline > now)) continue;
      let turnId: string;
      if (child) {
        if (!child.interactionScope) {
          child.interactionScope = true;
          this.snapshots.notify({ type: 'background_turn_started', nativeTurnId: String(child.native),
            scope: { kind: 'background', sessionInstanceId: this.sessionInstanceId, turnId: child.id, sequence: ++child.sequence } });
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
    const reason = localizedReason(nativeRequest, this.host.settings.locale);
    const presentation = call
      ? { toolName: call.name, input: { ...call.input }, description: getActionDescription(call.name, call.input), ...(reason ? { decisionReason: reason } : {}) }
      : { toolName: typeof nativeRequest.toolName === 'string' ? deepseekToolName(nativeRequest.toolName) : 'DeepSeek tool', input: {}, description: reason ?? 'DeepSeek requests permission.' };
    const response = value.event === 'approval/request'
      ? this.config.interactionPort.requestApproval({ ...identity, kind: 'approval', ...presentation, decisionOptions: [{ label: 'Allow once', value: 'allow', decision: 'allow' }, { label: 'Deny', value: 'deny', decision: 'deny' }] }, pending.signal).then(answer => ({ answer, value: answer.decision === 'allow' || answer.decision === 'allow-always' ? 'allowed-once' : answer.decision === 'cancel' ? 'cancelled' : 'rejected' }))
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
    if (requested.cancellation || requested.channel.isTerminal) return;
    if (requested.delivery === 'unsent' || requested.command) {
      requested.abort.abort(); requested.channel.finish({ type: 'cancelled' }); return;
    }
    this.withdraw(requested);
  }

  /**
   * The single withdrawal of a sent request, shared by Stop and recovery after a failed automatic turn.
   * Only confirmed native removal makes it definitely unsent; a claimed request runs unless Stop was requested.
   */
  private withdraw(requested: Request, unsent?: string): void {
    if (requested.cancellation || requested.channel.isTerminal) return;
    const operation = (async () => {
      const observer = this.observer!;
      const queued = () => observer.queuedItems(this.nativeId!).find(item => item.source?.rpcId === requested.channel.executionId);
      await observer.waitUntil(() => requested.channel.isTerminal || requested.delivery === 'claimed' || !!queued(), 10_000, this.lifetime.signal);
      if (requested.channel.isTerminal) return;
      if (requested.delivery !== 'claimed') {
        const item = queued();
        if (item) {
          try {
            await this.lease!.client.call('session/updateQueue', { request: { sessionId: this.nativeId, itemId: item.id, action: { kind: 'remove' } } });
            requested.channel.finish(unsent && !requested.channel.isCancellationRequested
              ? { type: 'execution_error', category: 'configuration', recoverable: true, message: unsent } : { type: 'cancelled' });
            return;
          } catch (error) {
            if (!(error instanceof DeepSeekRemoteError) || error.code !== 'session/queue-item-not-found') throw error;
            await observer.waitUntil(() => requested.delivery === 'claimed' || requested.channel.isTerminal, 10_000, this.lifetime.signal);
          }
        }
      }
      if (requested.channel.isTerminal) return;
      if (!requested.channel.isCancellationRequested) {
        // Recovery yields to the claim; release the slot so a later Stop starts its own withdrawal.
        requested.cancellation = undefined; return;
      }
      if (this.turn?.owner !== requested.channel) throw new Error('DeepSeek could not reconcile cancellation ownership.');
      await this.lease!.client.call('session/cancel', { request: { sessionId: this.nativeId } });
      await observer.waitUntil(() => requested.channel.isTerminal, 10_000, this.lifetime.signal);
    })().catch(error => { if (this.requested === requested && !requested.channel.isTerminal) return this.fail(error, 'transport'); });
    requested.cancellation = operation;
  }

  private async stopBackground(signal: AbortSignal): Promise<void> {
    const observer = this.observer!;
    const deadline = Date.now() + 10_000;
    const options = { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) };
    const killed = new Set<string>();
    while (observer.hasWork()) {
      if (Date.now() >= deadline) throw new Error('DeepSeek background Stop did not settle. Reopen the conversation to recover its native state.');
      const agents = [...observer.activeAgents()].reverse();
      for (const agent of agents) {
        if (agent.running && (!agent.parent || agent.mode === 'continuable')) await this.lease!.client.call(agent.parent ? 'subagents/interruptByParent' : 'session/cancel', agent.parent
          ? { childSessionId: agent.id, parentSessionId: agent.parent, mode: 'continuable' }
          : { request: { sessionId: agent.id } }, options);
        for (const item of observer.queuedItems(agent.id)) {
          try { await this.lease!.client.call('session/updateQueue', { request: { sessionId: agent.id, itemId: item.id, action: { kind: 'remove' } } }, options); }
          catch (error) { if (!(error instanceof DeepSeekRemoteError) || error.code !== 'session/queue-item-not-found') throw error; }
        }
      }
      for (const job of observer.ownedJobs()) {
        const key = `${job.owner}:${job.id}`;
        if (killed.has(key)) continue;
        await this.lease!.client.call('job/kill', { request: { sessionId: job.owner, jobId: job.id } }, options); killed.add(key);
      }
      if (!observer.hasWork()) break;
      // Yield until authoritative native updates arrive; the deadline bounds stalled producers.
      await new Promise<void>(resolve => {
        const finish = (): void => { window.clearTimeout(timer); off(); resolve(); };
        const off = observer.onChange(finish);
        const timer = window.setTimeout(finish, Math.min(100, Math.max(1, deadline - Date.now())));
      });
    }
    this.interactions.dismissAll('cancelled');
  }

  private async fail(error: unknown, category: 'configuration' | 'transport' | 'process-exited' | 'provider-session-missing', stopWork = true): Promise<void> {
    if (this.snapshots.status === 'disposed' || this.snapshots.status === 'invalidated') return;
    if (error instanceof DeepSeekReplayError) this.reloadError = error;
    const message = error instanceof Error ? error.message : 'DeepSeek execution failed.';
    this.requested?.channel.finish({ type: 'execution_error', category, message, recoverable: true, ...(category === 'provider-session-missing' ? { missingProviderSessionId: this.nativeId } : {}) });
    this.snapshots.invalidate({ reason: category === 'process-exited' ? 'process-exited' : category === 'provider-session-missing' ? 'provider-session-missing' : 'transport-closed', recoverable: true, message });
    this.snapshots.emit({ type: 'session_error', category, message, recoverable: true });
    this.interactions.dismissAll('native-rejected');
    // The shared Host stays up for other conversations; stop this one's native work when still observable.
    await this.detach(stopWork);
  }

  private detach(stopWork: boolean): Promise<void> {
    if (this.detaching) return this.detaching;
    const observer = this.observer;
    const task = (async () => {
      if (!stopWork || !observer) return;
      try {
        // Job rows refresh after every turn; decide only on reconciled state.
        await observer.waitUntil(() => observer.isReady(), 5_000);
        if (observer.hasWork()) await this.stopBackground(AbortSignal.timeout(10_000));
      } catch {
        // Unconfirmed native work ends with the shared Host; the session is already retired.
      }
    })().finally(() => {
      if (this.detaching === task) this.detaching = undefined;
      this.unbind();
    });
    this.detaching = task;
    this.publish();
    return task;
  }

  private unbind(): void {
    ++this.generation;
    if (this.turn?.owner === 'background') this.background(this.turn, { type: 'background_turn_completed', reason: 'provider-ended' });
    for (const turn of this.childTurns.values()) {
      if (turn.interactionScope) this.snapshots.notify({ type: 'background_turn_completed', reason: 'provider-ended',
        scope: { kind: 'background', sessionInstanceId: this.sessionInstanceId, turnId: turn.id, sequence: ++turn.sequence } });
    }
    this.turn = undefined; this.permission = undefined; this.lastSequence = -1; this.followQueue = Promise.resolve();
    this.childTurns.clear(); this.subagents.clear();
    this.voidInteractions();
    for (const off of this.offLease.splice(0)) off();
    this.observer?.dispose(); this.observer = undefined;
    this.lease?.release(); this.lease = undefined;
    if (this.commands) { this.commands = undefined; this.snapshots.emit({ type: 'commands_changed' }); }
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
  let text = input.input.filter(block => block.type === 'text').map(block => block.text).join('\n');
  const linked = input.context?.linkedContent;
  if (linked) text = linked.content === undefined ? appendLinkedContent(text, linked.path) : appendLinkedContentBody(text, linked.path, linked.content);
  text = appendSessionReferences(appendSelectionContexts(text, input.context), input.context?.sessionReferences);
  return [{ type: 'text', text }, ...input.input.flatMap(block => block.type === 'image' ? [{ type: 'image', mediaType: block.image.mediaType, data: block.image.data, name: block.image.name }] : [])];
}

/** Native localized explanation: configured locale, its base language, English, then the raw reason. */
function localizedReason(request: Record<string, unknown>, locale: string): string | undefined {
  const display = isRecord(request.displayReason) ? request.displayReason : {};
  const text = [locale, locale.split('-')[0], 'en'].map(key => display[key]).find(value => typeof value === 'string' && value);
  return typeof text === 'string' ? text : typeof request.reason === 'string' && request.reason ? request.reason : undefined;
}

function questionAnswers(request: Record<string, unknown>, answers: Record<string, string | string[]> | null): unknown {
  return { answers: Array.isArray(request.questions) ? request.questions.filter(isRecord).map(question => {
    const id = typeof question.id === 'string' ? question.id : '';
    const value = answers?.[id] ?? (typeof question.question === 'string' ? answers?.[question.question] : undefined);
    const values = Array.isArray(value) ? value : value ? [value] : [];
    const options = Array.isArray(question.options) ? question.options.filter(isRecord).map(option => option.label) : [];
    const selected = values.filter(value => options.includes(value));
    const custom = values.filter(value => !options.includes(value)).join('\n');
    return { id, selected, ...(custom ? { custom } : {}) };
  }) : [] };
}
