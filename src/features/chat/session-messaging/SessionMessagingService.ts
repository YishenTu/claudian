import type { ProviderSessionToolPort } from '@/core/execution';
import {
  findProviderModelOption,
  resolveConversationModel,
  resolveNewConversationModel,
} from '@/core/providers/conversationModel';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import type { ProviderId } from '@/core/providers/types';
import type {
  SessionToolDestinations,
  SessionToolListDestinationsArgs,
  SessionToolProviderDestination,
  SessionToolReadSessionArgs,
  SessionToolReadSessionResult,
  SessionToolReasoningDestination,
  SessionToolSendMessageArgs,
  SessionToolSendMessageResult,
  SessionToolSendMode,
  SessionToolSendStatus,
  SessionToolSessionStatus,
  SessionToolSessionSummary,
} from '@/core/session-tools/sessionToolSpecs';
import type { AskUserAnswers, ChatMessage, Conversation, ConversationMeta } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { getChatSettingsSnapshot } from '@/features/chat/ChatSettings';
import type { PendingInteractionSnapshot } from '@/features/chat/interactions/SessionInteractions';
import { formatLastReply, formatSessionSnapshot } from '@/features/chat/session-messaging/formatSessionSnapshot';
import { setSessionReasoningSelection } from '@/features/chat/sessions/sessionSettings';
import { throwIfAborted } from '@/utils/abort';

interface NewSessionChoice {
  readonly providerId: ProviderId;
  readonly model: string;
  /** Explicit choice only; omitted reasoning keeps the new-tab default. */
  readonly reasoning?: string;
}

export interface ClientSendOptions {
  /** Required unless `mode` is `interrupt`, which without text only stops the session. */
  readonly text?: string;
  readonly mode?: 'queue' | SessionToolSendMode;
}

/** A listed session for outside clients: the list tool's row without the caller marker. */
export type ClientSessionSummary = Omit<SessionToolSessionSummary, 'self'>;

export interface ClientSessionList {
  readonly sessions: readonly ClientSessionSummary[];
  readonly truncated?: true;
}

const CLIENT_LIST_LIMIT_DEFAULT = 50;
const CLIENT_LIST_LIMIT_MAX = 200;

export interface SessionToolBinding {
  readonly port: ProviderSessionToolPort;
  dispose(): void;
}

/** Owns caller-bound tool and outside-client operations; recipient execution belongs to its session runtime. */
export class SessionMessagingService {
  private readonly shutdown = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly deps: {
    getHost(): ChatFeatureHost;
    getActiveConversationId(): string | null;
    /** Re-renders open model controls after a session's selection is switched. */
    refreshModelControls(providerId: ProviderId): void;
  }) {}

  bindSessionTools(conversationId: string): SessionToolBinding {
    const binding = new AbortController();
    const invoke = <T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> =>
      this.track(AbortSignal.any([signal, binding.signal]), operation);
    return {
      port: {
        list: (args, signal) => invoke(signal, current => this.list(conversationId, args, current)),
        send: (args, signal) => invoke(signal, current => this.send(conversationId, args, current)),
        read: (args, signal) => invoke(signal, current => this.read(args, current)),
      },
      dispose: () => binding.abort(new Error('The caller session binding was released')),
    };
  }

  getActiveSessionId(): string | null { return this.deps.getActiveConversationId(); }

  /** An outside client's send: plain user input, or a stop when an interrupt has no text. */
  sendAsUser(sessionId: string, options: ClientSendOptions): Promise<SessionToolSendStatus> {
    const { text, mode = 'queue' } = options;
    if (text === undefined ? mode !== 'interrupt' : typeof text !== 'string' || !text.trim()) {
      return Promise.reject(new Error('"text" is required unless mode is "interrupt"'));
    }
    return this.track(this.shutdown.signal, async signal => {
      const host = this.deps.getHost();
      if (!host.sessionRuntimes.get(sessionId)) await host.sessionRuntimes.awaitConversationCreations();
      const target = await this.resolve(sessionId, signal);
      const mailbox = host.sessionRuntimes.ensure({ conversationId: target.id, providerId: target.providerId, draftModel: null }).mailbox;
      if (!mailbox) throw new Error('The target session cannot receive messages');
      return mailbox.deliver({ message: text === undefined ? null : { text }, ...(mode === 'queue' ? {} : { mode }), signal });
    });
  }

  /** Sessions most recently active first, like the list tool; archived sessions are omitted. */
  listSessions(options: { limit?: number } = {}): Promise<ClientSessionList> {
    const limit = options.limit ?? CLIENT_LIST_LIMIT_DEFAULT;
    if (!Number.isInteger(limit) || limit < 1 || limit > CLIENT_LIST_LIMIT_MAX) {
      return Promise.reject(new Error(`"limit" must be an integer from 1 to ${CLIENT_LIST_LIMIT_MAX}.`));
    }
    return this.track(this.shutdown.signal, async () => {
      const { records, truncated } = this.recentSessions(this.deps.getHost().getConversationList(), limit);
      return { sessions: records.map(record => this.summarize(record)), ...(truncated ? { truncated } : {}) };
    });
  }

  /** Rejects when the session does not exist or is archived. */
  requireSession(sessionId: string): Promise<void> {
    return this.track(this.shutdown.signal, async signal => { await this.resolve(sessionId, signal); });
  }

  /** Requests awaiting the user in the session's main transcript; empty when none or not loaded. */
  getPendingInteractions(sessionId: string): PendingInteractionSnapshot[] {
    return this.liveModel(sessionId)?.inlinePrompts.listPending() ?? [];
  }

  answerInteraction(sessionId: string, interactionId: string, answers: AskUserAnswers): Promise<void> {
    const model = this.liveModel(sessionId);
    if (!model) return Promise.reject(new Error(`Interaction "${interactionId}" is not awaiting an answer`));
    return model.inlinePrompts.answer(interactionId, answers);
  }

  private liveModel(sessionId: string) {
    const runtime = this.deps.getHost().sessionRuntimes.get(sessionId);
    return runtime?.conversationId === sessionId ? runtime.peekModel : null;
  }

  /** The last finished turn's final reply as Markdown; empty when none has finished. */
  readLastReply(sessionId: string): Promise<string> {
    return this.track(this.shutdown.signal, async signal => {
      const transcript = await this.loadTranscript(sessionId, signal);
      return formatLastReply(transcript.messages, transcript.running);
    });
  }

  private track<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const combined = AbortSignal.any([signal, this.shutdown.signal]);
    const pending = Promise.resolve().then(() => {
      throwIfAborted(combined, 'Session tool call was cancelled');
      return operation(combined);
    });
    this.pending.add(pending);
    void pending.finally(() => this.pending.delete(pending)).catch(() => undefined);
    return pending;
  }

  beginShutdown(): void { this.shutdown.abort(new Error('Session messaging is shutting down')); }

  async dispose(): Promise<void> {
    this.beginShutdown();
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  private async resolve(id: string, signal: AbortSignal): Promise<ConversationMeta> {
    const host = this.deps.getHost();
    await host.ensureConversationMetadataLoaded([id]);
    throwIfAborted(signal, 'Session tool call was cancelled');
    const record = host.getConversationList().find(candidate => candidate.id === id && !candidate.isArchived);
    if (!record) throw new Error('The session does not exist or is archived');
    return record;
  }

  private async list(
    callerId: string,
    args: SessionToolListDestinationsArgs,
    signal: AbortSignal,
  ): Promise<SessionToolDestinations> {
    const caller = await this.resolve(callerId, signal);
    const host = this.deps.getHost();
    let candidates = host.getConversationList();
    if (args.project) {
      const project = host.projects.get(caller.projectId);
      if (!project) throw new Error('This session is not in a project.');
      candidates = candidates.filter(record => record.projectId === project.id);
    }
    const { records, truncated } = this.recentSessions(candidates, args.limit);
    const sessions = records.map((record): SessionToolSessionSummary => ({
      ...this.summarize(record),
      ...(record.id === callerId ? { self: true as const } : {}),
    }));
    return {
      sessions,
      ...(truncated ? { truncated } : {}),
      ...(args.includeProviders ? { providers: listProviderDestinations(host.getCommittedSettings()) } : {}),
    };
  }

  /** Archived sessions and the caller itself are readable: reading changes nothing. */
  private async read(args: SessionToolReadSessionArgs, signal: AbortSignal): Promise<SessionToolReadSessionResult> {
    const { conversation, messages, running } = await this.loadTranscript(args.sessionId, signal);
    const page = formatSessionSnapshot(conversation, messages, running,
      args.beforeTurn !== undefined ? { beforeTurn: args.beforeTurn } : {});
    return {
      sessionId: conversation.id,
      title: conversation.title,
      provider: conversation.providerId,
      status: this.status(conversation.id),
      ...page,
    };
  }

  private async loadTranscript(id: string, signal: AbortSignal): Promise<{
    conversation: Conversation; messages: readonly ChatMessage[]; running: boolean;
  }> {
    const host = this.deps.getHost();
    // Ids can come from earlier messages, before the deferred metadata scan admits them.
    await host.ensureConversationMetadataLoaded([id]);
    throwIfAborted(signal, 'Session tool call was cancelled');
    const conversation = await host.getConversationById(id);
    throwIfAborted(signal, 'Session tool call was cancelled');
    if (!conversation) throw new Error('The session does not exist');
    // A hydrated runtime holds turns storage may not have yet, including headless sessions.
    const runtime = host.sessionRuntimes.get(conversation.id);
    const model = runtime?.conversationId === conversation.id ? runtime.peekModel : null;
    const live = model?.hydrationState === 'ready' ? model.state : null;
    if (!model || !live) return { conversation, messages: conversation.messages, running: false };
    // The running turn's boundary also covers prompts steered into it; null until its submission is placed.
    const end = model.inputController.settledTranscriptEnd(live.messages);
    return end === null
      ? { conversation, messages: live.messages, running: live.isStreaming }
      : { conversation, messages: live.messages.slice(0, end), running: false };
  }

  private recentSessions(candidates: readonly ConversationMeta[], limit: number): { records: ConversationMeta[]; truncated?: true } {
    const records = candidates.filter(record => !record.isArchived).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return { records: records.slice(0, limit), ...(records.length > limit ? { truncated: true as const } : {}) };
  }

  private summarize(record: ConversationMeta): ClientSessionSummary {
    return {
      sessionId: record.id,
      title: record.title,
      provider: record.providerId,
      status: this.status(record.id),
      active: record.id === this.deps.getActiveConversationId(),
    };
  }

  private status(id: string): SessionToolSessionStatus {
    const runtime = this.deps.getHost().sessionRuntimes.get(id);
    return runtime?.statusAttention?.kind === 'action-required' ? 'awaiting-user'
      : runtime?.isWorking ? 'running' : 'idle';
  }

  private async send(callerId: string, args: SessionToolSendMessageArgs, signal: AbortSignal): Promise<SessionToolSendMessageResult> {
    const caller = await this.resolve(callerId, signal);
    const host = this.deps.getHost();
    if (args.sessionId === callerId) throw new Error('A session cannot send a message to itself');
    let target: ConversationMeta;
    let reasoning: string | undefined;
    if (args.sessionId) {
      target = await this.resolve(args.sessionId, signal);
    } else {
      const choice = resolveNewSessionChoice(args, host.getCommittedSettings());
      reasoning = choice.reasoning;
      throwIfAborted(signal, 'Session tool call was cancelled');
      // A spawned session joins the caller's project while it is live; creation drops a deleted one. Creation
      // publishes the shell; cancellation after this point never rolls it back.
      const created = await host.createConversation({
        providerId: choice.providerId,
        selectedModel: choice.model,
        ...(caller.projectId ? { projectId: caller.projectId } : {}),
      });
      throwIfAborted(signal, 'Session tool call was cancelled');
      target = await this.resolve(created.id, signal);
    }
    if (!host.sessionRuntimes.get(target.id)) {
      await host.sessionRuntimes.awaitConversationCreations();
      target = await this.resolve(target.id, signal);
    }
    // Validated against the destination before anything changes; a rejected send switches nothing.
    let model: string | undefined;
    if (args.sessionId) ({ model, reasoning } = resolveSessionSwitch(args, target, host));
    throwIfAborted(signal, 'Session tool call was cancelled');
    const runtime = host.sessionRuntimes.ensure({ conversationId: target.id, providerId: target.providerId, draftModel: null });
    const mailbox = runtime.mailbox;
    if (!mailbox) throw new Error('The target session cannot receive messages');
    const recipient = { sessionId: target.id, title: target.title, provider: target.providerId };
    const message = args.text === undefined ? null : { from: caller.title, sessionId: caller.id, text: args.text };
    // Applied like the user's own choice: a later choice wins, and a send that fails after it keeps the switch.
    if (model !== undefined) {
      await host.updateConversation(target.id, { selectedModel: model });
      throwIfAborted(signal, 'Session tool call was cancelled');
    }
    if (reasoning !== undefined) {
      const resultingModel = model ?? resolveConversationModel(host.getCommittedSettings(), target.providerId, target).model;
      setSessionReasoningSelection(runtime, target.providerId, resultingModel, reasoning);
    }
    if (args.sessionId && (model !== undefined || reasoning !== undefined)) {
      try { this.deps.refreshModelControls(target.providerId); } catch { /* The switch already committed. */ }
    }
    const status = await mailbox.deliver({ message, mode: args.mode, signal });
    return { ...recipient, status };
  }
}

/** The reasoning a new session with this model would carry; null when the model has no reasoning control. */
function resolveReasoningDestination(
  providerId: ProviderId,
  model: string,
  settings: Record<string, unknown>,
): SessionToolReasoningDestination | null {
  if (ProviderRegistry.getCapabilities(providerId).reasoningControl === 'none') return null;
  const snapshot = getChatSettingsSnapshot(settings, providerId, model);
  if (snapshot.reasoning === null) return null;
  const uiConfig = ProviderRegistry.getChatUIConfig(providerId);
  const options = uiConfig.getReasoningOptions(snapshot.model, snapshot).map(option => option.value);
  return {
    options,
    default: options.includes(snapshot.reasoning)
      ? snapshot.reasoning
      : uiConfig.getDefaultReasoningValue(snapshot.model, snapshot),
  };
}

function listProviderDestinations(settings: Record<string, unknown>): SessionToolProviderDestination[] {
  const defaults = resolveNewConversationModel(settings);
  return ProviderRegistry.getEnabledProviderIds(settings).map(providerId => {
    // Only the new-tab model is a default: an explicit provider always comes with a model.
    const defaultModel = providerId === defaults?.providerId ? defaults.model : null;
    const models = ProviderRegistry.getModelPolicy(providerId).getModelOptions(settings).map(option => {
      const reasoning = resolveReasoningDestination(providerId, option.value, settings);
      return {
        id: option.value,
        ...(option.value === defaultModel ? { default: true as const } : {}),
        ...(reasoning ? { reasoning } : {}),
      };
    });
    return { provider: providerId, ...(providerId === defaults?.providerId ? { default: true as const } : {}), models };
  });
}

/** Omitted values follow the new-tab policy; explicit values are validated and never substituted. */
function resolveNewSessionChoice(args: SessionToolSendMessageArgs, settings: Record<string, unknown>): NewSessionChoice {
  const defaults = resolveNewConversationModel(settings);
  const enabled = ProviderRegistry.getEnabledProviderIds(settings);
  const providerId = args.provider ?? defaults?.providerId;
  if (!providerId || !enabled.includes(providerId)) {
    throw new Error(args.provider
      ? `Unknown or disabled provider "${args.provider}". Available: ${formatOptions(enabled)}`
      : 'No provider is available for a new session');
  }
  let model: string | null;
  if (args.model) {
    model = findProviderModelOption(providerId, args.model, settings);
    if (!model) {
      const options = ProviderRegistry.getModelPolicy(providerId).getModelOptions(settings).map(option => option.value);
      throw new Error(`Unknown model "${args.model}" for ${providerId}. Available: ${formatOptions(options)}`);
    }
  } else {
    // Decoding rejects a provider without a model, so this is the new-tab choice.
    model = defaults?.model ?? null;
    if (!model) throw new Error(`No model is available for ${providerId}`);
  }
  if (args.reasoning !== undefined) validateReasoning(providerId, model, args.reasoning, settings);
  return { providerId, model, ...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}) };
}

/**
 * An existing session's switch, validated against its own provider and resulting model.
 * Model is omitted when it would not change; omitted reasoning keeps the session's selection.
 */
function resolveSessionSwitch(
  args: SessionToolSendMessageArgs,
  target: ConversationMeta,
  host: ChatFeatureHost,
): { model?: string; reasoning?: string } {
  if (args.model === undefined && args.reasoning === undefined) return {};
  const settings = host.getCommittedSettings();
  const providerId = target.providerId;
  const current = resolveConversationModel(settings, providerId, host.getConversationSummary(target.id) ?? target).model;
  let model = current;
  if (args.model !== undefined) {
    const selected = findProviderModelOption(providerId, args.model, settings);
    if (!selected) {
      const options = ProviderRegistry.getModelPolicy(providerId).getModelOptions(settings).map(option => option.value);
      throw new Error(`Unknown model "${args.model}" for ${providerId}. Available: ${formatOptions(options)}`);
    }
    model = selected;
  }
  if (args.reasoning !== undefined) validateReasoning(providerId, model, args.reasoning, settings);
  return {
    ...(model !== current ? { model } : {}),
    ...(args.reasoning !== undefined ? { reasoning: args.reasoning } : {}),
  };
}

function validateReasoning(providerId: ProviderId, model: string, value: string, settings: Record<string, unknown>): void {
  const reasoning = resolveReasoningDestination(providerId, model, settings);
  if (!reasoning) throw new Error(`Model ${model} for ${providerId} has no reasoning control.`);
  if (!reasoning.options.includes(value)) {
    throw new Error(`Unknown reasoning "${value}" for ${providerId} model ${model}. Available: ${formatOptions(reasoning.options)}`);
  }
}

function formatOptions(options: readonly string[]): string {
  return options.length > 0 ? options.join(', ') : 'none';
}
