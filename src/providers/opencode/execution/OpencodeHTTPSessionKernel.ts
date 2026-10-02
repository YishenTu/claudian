import { randomUUID } from 'node:crypto';

import { resolveTitleGenerationLocale } from '@/core/prompt/titleGeneration';
import type { ACPPromptRequest, ACPSessionConfigOption } from '@/providers/acp';

import { forkOpencodeHTTPSession } from '../history/OpencodeSessionFork';
import { isRecord, OpencodeHTTPError, type OpencodeHTTPEvent, pollOpencodeUntil } from '../http/OpencodeHTTPClient';
import { projectOpencodeFormQuestions } from '../http/OpencodeHTTPForms';
import type { OpencodeServerLease, OpencodeServerService } from '../http/OpencodeServerService';
import { OpencodeShellOutput } from '../http/OpencodeShellOutput';
import { normalizeOpencodeToolInput, normalizeOpencodeToolName, normalizeOpencodeToolResult, normalizeOpencodeToolUseResult } from '../normalization/opencodeToolNormalization';
import { AUX_AGENT_IDS, buildOpencodeSystemPrompt, getSystemPromptSettings, OPENCODE_BUILD_AGENT_ID } from '../runtime/OpencodeExecutionAgents';
import {
  type OpencodeKernelConnectOptions,
  type OpencodeNativeOutput,
  type OpencodeNativeSessionInfo,
  type OpencodeSessionKernel,
  type OpencodeSessionKernelOptions,
  OpencodeSessionMissingError,
} from './OpencodeSessionContract';
import type { OpencodeSessionPersistence } from './OpencodeSessionPersistence';

type PendingPrompt = { resolve: (value: { stopReason: 'end_turn' | 'cancelled'; userMessageId?: string }) => void; reject: (error: Error) => void; userMessageId?: string; inputId?: string; announced: boolean; started: boolean; steerable: boolean; idle: boolean };
/** A steer admitted to the native inbox stays owned by the prompt until delivered or recalled. */
interface PendingSteer { text: string; admission: Promise<SteerAdmission>; resolve: (delivered: boolean) => void; reject: (error: Error) => void; recall: Promise<void> | null }
type SteerAdmission = 'admitted' | 'refused' | 'unknown';
interface NativeModel { providerID: string; id: string; variant?: string }
interface NativeChild { outputSessionId: string; toolCallId: string; turnId: string; interactionTurnId: string; background: boolean; text: Map<string, string>; progress: { startedAt: number; toolUses: number; totalTokens: number; lastToolName?: string } }
interface NativeTool { name: string; input: Record<string, unknown>; sessionId: string; output: string | null; shell?: OpencodeShellOutput }

/** V2 uses native HTTP events and interactions; ACP is only the v1 wire protocol. */
export class OpencodeHTTPSessionKernel implements OpencodeSessionKernel {
  private client: OpencodeServerLease | null = null;
  private disposed = false;
  private autoApprove = false;
  private readonly controller = new AbortController();
  private sessionId: string | null = null;
  private databasePath: string | null = null;
  private model: NativeModel | null = null;
  private models: Array<Record<string, unknown> & { providerID: string; id: string; name: string }> = [];
  private commands = new Set<string>();
  private profile: OpencodeKernelConnectOptions['profile'] = 'managed';
  private readonly text = new Map<string, string>();
  private readonly children = new Map<string, NativeChild>();
  private readonly tools = new Map<string, NativeTool>();
  private readonly previewStops = new Map<string, 'cancelled' | 'ended'>();
  private readonly globalForms = new Map<string, { settled: boolean }>();
  private readonly interactions = new Map<string, AbortController>();
  private pending: PendingPrompt | null = null;
  private readonly steers = new Map<string, PendingSteer>();
  private cancellation: Promise<unknown> | null = null;

  private agents: Record<string, string> = {};
  constructor(private readonly options: OpencodeSessionKernelOptions, private readonly cliPath: string, private readonly environment: NodeJS.ProcessEnv, private readonly serverService: OpencodeServerService, private readonly persistence: OpencodeSessionPersistence) {}

  async connect(options: OpencodeKernelConnectOptions): Promise<void> {
    this.profile = options.profile;
    this.client = await this.serverService.acquire(this.cliPath, this.options.config.vaultWorkingDirectory, this.environment, this.controller.signal);
    if (this.disposed) await this.client.dispose();
    this.controller.signal.throwIfAborted();
    this.databasePath = this.client.databasePath;
    await this.client.subscribe(event => this.handleEvent(event), error => this.fail(error), () => !this.disposed && !!this.sessionId && !!this.options.openNativeInteraction);
    this.agents = await this.client.registerAgents(
      [options.profile === 'managed' ? OPENCODE_BUILD_AGENT_ID : AUX_AGENT_IDS[options.profile]],
      this.resolveSystemPrompt(options),
    );
    const client = this.client;
    await client.waitForActivation(this.controller.signal);
    this.models = await pollOpencodeUntil(
      async () => (await client.request<{ data: Array<Record<string, unknown>> }>('/api/model')).data.flatMap(model => model.enabled === true && typeof model.providerID === 'string' && typeof model.id === 'string'
        ? [{ ...model, providerID: model.providerID, id: model.id, name: typeof model.name === 'string' ? model.name : model.id }]
        : []),
      models => models.length > 0, 5000, this.controller.signal,
    );
    const catalog = await this.client.request<{ data: Array<{ name: string }> }>('/api/command');
    this.commands = new Set(catalog.data.map(command => command.name));
  }

  async openSession(resumeSessionId?: string): Promise<OpencodeNativeSessionInfo> {
    let sessionId: string;
    try {
      sessionId = await this.persistence.openSession(async () => {
        const client = this.requireClient();
        const fork = !resumeSessionId ? this.options.forkSource : undefined;
        if (fork) return forkOpencodeHTTPSession(client, fork.sessionId, fork.resumeAt);
        const { data } = await client.request<{ data: Record<string, unknown> }>(resumeSessionId ? `/api/session/${encodeURIComponent(resumeSessionId)}` : '/api/session',
          resumeSessionId ? {} : { method: 'POST', body: { location: { directory: this.options.config.vaultWorkingDirectory }, agent: this.agents[this.profile === 'managed' ? OPENCODE_BUILD_AGENT_ID : AUX_AGENT_IDS[this.profile]] } });
        if (typeof data.id !== 'string' || (resumeSessionId && data.id !== resumeSessionId)) throw new Error('Invalid OpenCode session response.');
        return data.id;
      }, () => this.serverService.acquire(this.cliPath, this.options.config.vaultWorkingDirectory, this.environment));
    } catch (error) {
      if (resumeSessionId && error instanceof OpencodeHTTPError && error.status === 404) throw new OpencodeSessionMissingError(resumeSessionId, error);
      throw error;
    }
    this.sessionId = sessionId;
    await this.requireClient().refreshGlobalForms();
    return { sessionId, nativeVersion: 2, databasePath: this.databasePath, models: { currentModelId: '', availableModels: this.models.map(model => ({ modelId: `${model.providerID}/${model.id}`, name: `${model.providerID}/${model.name}` })) } };
  }

  async setConfigOption(request: Record<string, unknown>): Promise<{ configOptions?: ACPSessionConfigOption[] }> {
    const route = `/api/session/${encodeURIComponent(String(request.sessionId))}`;
    const value = String(request.value);
    if (request.configId === 'mode') {
      await this.requireClient().request(`${route}/agent`, { method: 'POST', body: { agent: this.agents[value] ?? value } });
    } else if (request.configId === 'model') {
      const slash = value.indexOf('/');
      if (slash < 1) throw new Error('Invalid OpenCode model selection.');
      this.model = { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
      await this.requireClient().request(`${route}/model`, { method: 'POST', body: { model: this.model } });
    } else if (request.configId === 'effort' && this.model) {
      this.model = { providerID: this.model.providerID, id: this.model.id, ...(value === 'default' ? {} : { variant: value }) };
      await this.requireClient().request(`${route}/model`, { method: 'POST', body: { model: this.model } });
    }
    const selected = this.models.find(model => model.id === this.model?.id && model.providerID === this.model?.providerID);
    const variants = Array.isArray(selected?.variants) ? selected.variants.filter(isRecord).flatMap(variant => typeof variant.id === 'string' ? [variant.id] : []) : [];
    return { configOptions: [{ id: 'effort', category: 'thought_level', name: 'Effort', type: 'select', currentValue: this.model?.variant ?? 'default', options: [...new Set([...variants, 'default'])].map(value => ({ value, name: value })) }] };
  }

  setAutoApprove(enabled: boolean): void {
    this.autoApprove = this.profile === 'managed' && enabled;
  }

  async prompt(request: ACPPromptRequest): Promise<{ stopReason: 'end_turn' | 'cancelled'; userMessageId?: string }> {
    if (this.pending) throw new Error('OpenCode already has an active request.');
    const { text, files } = toNativeInput(request);
    const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text);
    const command = match && this.commands.has(match[1]) ? match : null;
    const previousMessage = command ? await this.latestMessage(request.sessionId) : undefined;
    let resolve!: PendingPrompt['resolve'];
    let reject!: PendingPrompt['reject'];
    const completion = new Promise<{ stopReason: 'end_turn' | 'cancelled'; userMessageId?: string }>((yes, no) => { resolve = yes; reject = no; });
    const pending: PendingPrompt = { resolve, reject, ...(command ? {} : { inputId: nativeMessageId() }), announced: false, started: false, steerable: false, idle: false };
    this.pending = pending;
    this.previewStops.delete(request.sessionId);
    // A native error may arrive before the admission request resolves.
    void completion.catch(() => undefined);
    try {
      const admitted = await this.requireClient().request<{ data?: { id?: string } }>(`/api/session/${encodeURIComponent(request.sessionId)}/${command ? 'command' : 'prompt'}`, {
        method: 'POST', ...(command ? { timeoutMs: 0 } : {}), body: { ...(command ? { name: command[1] } : { id: pending.inputId }), text: command ? command[2] ?? '' : text, ...(files.length ? { files } : {}) },
      });
      this.captureAdmission(admitted?.data?.id);
      // Steers queue behind an admitted prompt; commands have no native inbox item to steer.
      if (!command && this.pending === pending) pending.steerable = true;
      // A command can complete without starting an agent loop (for example a status command).
      if (command) {
        void this.requireClient().request(`/api/experimental/session/${encodeURIComponent(request.sessionId)}/wait`, { method: 'POST', timeoutMs: 0 })
          .then(async () => {
            if (this.pending !== pending || pending.started) return;
            // Idle HTTP responses can overtake SSE. A new assistant/idle message
            // means execution occurred: its terminal event must close the turn.
            const latest = await this.latestMessage(request.sessionId);
            if (this.pending !== pending || pending.started) return;
            if (latest?.id !== previousMessage?.id && ['assistant', 'idle', 'compaction'].includes(String(latest?.type))) return;
            this.finish();
          }).catch(error => { if (this.pending === pending) this.fail(error); });
      }
    } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    return completion;
  }

  /**
   * Native steers enter the session inbox and fold in at the next step
   * boundary. Delivery, not admission, is the acceptance signal: an admitted
   * steer is still recallable, and one left behind an interrupt would
   * otherwise leak into the next prompt.
   */
  async steer(request: ACPPromptRequest): Promise<boolean> {
    const pending = this.pending;
    if (!pending?.steerable || pending.idle || this.cancellation || this.disposed || request.sessionId !== this.sessionId) return false;
    const { text, files } = toNativeInput(request);
    const id = nativeMessageId();
    // Register before admission: delivery can be announced before the HTTP response.
    const admission = this.requireClient().request(`/api/session/${encodeURIComponent(request.sessionId)}/prompt`, {
      method: 'POST', body: { id, text, ...(files.length ? { files } : {}), delivery: 'steer' },
    }).then<SteerAdmission, SteerAdmission>(
      () => 'admitted',
      // A client error is a definite native refusal; anything else may have been admitted.
      error => error instanceof OpencodeHTTPError && error.status >= 400 && error.status < 500 ? 'refused' : 'unknown',
    );
    const delivery = new Promise<boolean>((resolve, reject) => { this.steers.set(id, { text, admission, resolve, reject, recall: null }); });
    const outcome = await admission;
    if (outcome === 'refused') this.settleSteer(id, false);
    else if (outcome === 'unknown' || this.pending !== pending) void this.recallSteers();
    return delivery;
  }

  cancel(sessionId: string): void {
    this.previewStops.set(sessionId, 'cancelled');
    for (const tool of this.tools.values()) {
      if (tool.sessionId === sessionId) {
        tool.shell?.stop();
        tool.output = null;
      }
    }
    this.cancellation ??= this.requireClient().request(`/api/session/${encodeURIComponent(sessionId)}/interrupt?resume=false`, { method: 'POST' })
      .catch(() => undefined).finally(() => { this.cancellation = null; });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    const interruptions = this.client?.isReusable()
      ? [...new Set([...(this.sessionId ? [this.sessionId] : []), ...this.children.keys()])]
        .map(id => this.client!.request(`/api/session/${encodeURIComponent(id)}/interrupt?resume=false`, { method: 'POST' }).catch(() => undefined))
      : [];
    // Interrupts leave undelivered steers queued in the persistent native inbox.
    const recalls = this.client?.isReusable() ? this.recallSteers() : undefined;
    this.disposed = true;
    this.stopTools();
    this.previewStops.clear();
    this.controller.abort();
    for (const [id, controller] of this.interactions) {
      controller.abort();
      this.options.config.interactionPort.dismissInteraction(id, 'session-disposed');
    }
    this.interactions.clear();
    this.pending?.reject(new Error('OpenCode session disposed.'));
    this.pending = null;
    await Promise.all([this.cancellation, ...interruptions, recalls]);
    for (const id of [...this.steers.keys()]) this.settleSteer(id, new Error('OpenCode session disposed before the steer was delivered.'));
    await this.persistence.settle();
    await this.client?.dispose();
  }

  private handleEvent(event: OpencodeHTTPEvent): void {
    if (this.disposed) return;
    const data = event.data;
    const form = isRecord(data.form) ? data.form : undefined;
    const nativeSessionId = String(form?.sessionID ?? data.sessionID);
    const child = this.children.get(nativeSessionId);
    if (['permission.replied', 'form.replied', 'form.cancelled'].includes(event.type)) {
      const id = String(data.requestID ?? data.id);
      const globalForm = nativeSessionId === 'global' ? this.globalForms.get(id) : undefined;
      if (globalForm) globalForm.settled = true;
      const controller = this.interactions.get(id);
      if (controller && (nativeSessionId === this.sessionId || child || (nativeSessionId === 'global' && this.globalForms.has(id)))) {
        controller.abort();
        this.interactions.delete(id);
        this.options.config.interactionPort.dismissInteraction(id, 'native-rejected');
      }
      return;
    }
    if (event.type === 'form.created' && nativeSessionId === 'global' && form) {
      void this.interactWithGlobalForm(form).catch(error => this.fail(error));
      return;
    }
    if (nativeSessionId !== this.sessionId && !child) return;
    if (event.type === 'session.execution.started' && this.previewStops.get(nativeSessionId) === 'ended') {
      this.previewStops.delete(nativeSessionId);
    }
    if (event.type.startsWith('session.execution.') && event.type !== 'session.execution.started') {
      this.previewStops.set(nativeSessionId, 'ended');
      this.stopTools(nativeSessionId);
    }
    const assistantMessageId = typeof data.assistantMessageID === 'string' ? data.assistantMessageID : undefined;
    const itemId = typeof data.id === 'string' ? data.id : undefined;
    const ordinal = typeof data.ordinal === 'number' ? data.ordinal : undefined;
    if ((event.type.startsWith('session.text.') || event.type.startsWith('session.reasoning.'))
      && (assistantMessageId === undefined || ordinal === undefined)) return;
    if (event.type.startsWith('session.tool.') && (assistantMessageId === undefined || itemId === undefined)) return;
    if (child) {
      if (event.type === 'session.text.ended') child.text.set(`${assistantMessageId}:${ordinal}`, String(data.text));
      if (event.type === 'session.step.ended') {
        child.progress.totalTokens += countTokens(data.tokens);
        this.emitChildProgress(child);
      }
      if (event.type.startsWith('session.execution.') && event.type !== 'session.execution.started') {
        if (child.background) this.options.onNativeTaskCompleted?.({
          type: 'async_subagent_completed', originatingTurnId: child.turnId, subagentId: nativeSessionId,
          status: event.type === 'session.execution.succeeded' ? 'completed' : 'error',
          result: [...child.text.values()].join('\n') || (data.error ? errorText(data.error) : undefined),
          providerSessionId: this.sessionId ?? undefined,
        });
        this.children.delete(nativeSessionId);
        this.previewStops.delete(nativeSessionId);
      }
      if (!event.type.startsWith('session.tool.') && event.type !== 'permission.asked' && event.type !== 'form.created') return;
    }
    const key = `${nativeSessionId}:${assistantMessageId}:${itemId}`;
    const identity = child
      ? { toolCallId: `${nativeSessionId}:${itemId}`, toolScope: { kind: 'subagent' as const, subagentId: child.toolCallId }, parentToolCallId: child.toolCallId }
      : { toolCallId: String(data.id), toolScope: { kind: 'main' as const } };
    switch (event.type) {
      case 'session.execution.started':
        if (this.pending) { this.pending.started = true; this.pending.idle = false; }
        this.options.onNativeTurn?.('started', undefined, !!this.pending);
        this.announcePrompt();
        break;
      case 'session.execution.succeeded':
        if (this.pending && this.steers.size > 0) this.pending.idle = true;
        else if (!this.pending || this.pending.started) this.finish();
        break;
      case 'session.inbox.delivered': {
        const id = String(data.inboxID);
        const steer = this.steers.get(id);
        if (!steer) break;
        this.announcePrompt();
        this.emit({ type: 'user_message_started', content: steer.text, nativeUserMessageId: id });
        this.settleSteer(id, true);
        break;
      }
      case 'session.inbox.cancelled': this.settleSteer(String(data.inboxID), false); break;
      case 'session.execution.interrupted': if (!this.pending || this.pending.started) this.finish('cancelled'); break;
      case 'session.execution.failed': this.fail(new Error(errorText(data.error))); break;
      case 'permission.asked': void this.interact(data, false, child?.interactionTurnId).catch(error => this.fail(error)); break;
      case 'form.created': if (form) void this.interact(form, true, child?.interactionTurnId).catch(error => this.fail(error)); break;
      case 'session.step.started': {
        const id = String(data.assistantMessageID);
        this.emit({ type: 'assistant_message_started', nativeAssistantId: id });
        break;
      }
      case 'session.text.delta': case 'session.reasoning.delta':
      case 'session.text.ended': case 'session.reasoning.ended': {
        const kind = event.type.includes('.reasoning.') ? 'thinking_delta' : 'text_delta';
        const key = `${assistantMessageId}:${ordinal}:${kind}`;
        const previous = this.text.get(key) ?? '';
        const text = typeof data.delta === 'string' ? data.delta : typeof data.text === 'string' ? data.text.slice(previous.length) : '';
        if (event.type.endsWith('.ended')) this.text.delete(key);
        else this.text.set(key, previous + text);
        if (text) this.emit({ type: kind, text });
        break;
      }
      case 'session.tool.input.started':
        this.tools.get(key)?.shell?.stop();
        this.tools.set(key, { name: String(data.name), input: {}, sessionId: nativeSessionId, output: '' });
        break;
      case 'session.tool.called': {
        const tool = this.tools.get(key);
        if (!tool) break;
        tool.input = normalizeOpencodeToolInput(tool.name, isRecord(data.input) ? data.input : {});
        const name = normalizeOpencodeToolName(tool.name);
        this.emit({ type: 'tool_started', ...identity, name, input: tool.input, providerPayload: { rawName: tool.name, rawInput: data.input } }, child?.outputSessionId);
        if (child) {
          child.progress.toolUses += 1;
          child.progress.lastToolName = name;
          this.emitChildProgress(child);
        }
        break;
      }
      case 'session.tool.progress': {
        const tool = this.tools.get(key);
        const metadata = isRecord(data.metadata) ? data.metadata : {};
        const turnId = child?.turnId ?? this.options.getActiveTurnId();
        if (tool?.name === 'subagent' && typeof metadata.sessionID === 'string' && turnId && !this.children.has(metadata.sessionID)) {
          const background = tool.input.run_in_background === true;
          const interactionTurnId = (background ? this.options.onNativeTaskStarted?.(metadata.sessionID, turnId) : undefined) ?? child?.interactionTurnId ?? turnId;
          this.children.set(metadata.sessionID, { outputSessionId: background ? metadata.sessionID : child?.outputSessionId ?? metadata.sessionID, toolCallId: identity.toolCallId, turnId, interactionTurnId, background, text: new Map(), progress: { startedAt: Date.now(), toolUses: 0, totalTokens: 0 } });
        }
        if (tool && !this.previewStops.has(nativeSessionId) && tool.output !== null && typeof metadata.shellID === 'string') {
          tool.shell ??= new OpencodeShellOutput(this.requireClient(), metadata.shellID, content => {
            if (!this.disposed && this.tools.get(key) === tool) {
              this.emit({ type: 'tool_output', ...identity, content }, child?.outputSessionId);
            }
          });
        } else if (tool && !this.previewStops.has(nativeSessionId) && !tool.shell && typeof metadata.output === 'string' && tool.output !== null) {
          if (metadata.output.startsWith(tool.output)) {
            const content = metadata.output.slice(tool.output.length);
            tool.output = metadata.output;
            if (content) this.emit({ type: 'tool_output', ...identity, content }, child?.outputSessionId);
          } else {
            // Rolling/replaced snapshots cannot be represented as append-only deltas.
            tool.output = null;
          }
        }
        break;
      }
      case 'session.tool.success': case 'session.tool.failed': {
        const tool = this.tools.get(key);
        tool?.shell?.stop();
        const content = Array.isArray(data.content) ? data.content.filter(isRecord).flatMap(item => typeof item.text === 'string' ? [item.text] : []).join('\n') : '';
        const result = normalizeOpencodeToolResult(tool?.name, content || (data.error ? errorText(data.error) : ''), { metadata: data.metadata });
        this.emit({ type: 'tool_completed', ...identity, content: result.content, isError: event.type.endsWith('.failed') || result.isError, providerPayload: { rawName: tool?.name, rawInput: tool?.input, rawOutput: { ...data, metadata: data.metadata } }, toolUseResult: tool ? normalizeOpencodeToolUseResult(tool.name, tool.input, { output: content, metadata: data.metadata }) : undefined }, child?.outputSessionId);
        this.tools.delete(key);
        break;
      }
      case 'session.step.ended': this.emitUsage(data.tokens); break;
      case 'session.compaction.ended': this.emit({ type: 'context_compacted' }); break;
    }
  }

  private async latestMessage(sessionId: string): Promise<Record<string, unknown> | undefined> {
    const response = await this.requireClient().request<{ data: Array<Record<string, unknown>> }>(`/api/session/${encodeURIComponent(sessionId)}/message?order=desc&limit=1`);
    return response.data[0];
  }

  private async interactWithGlobalForm(form: Record<string, unknown>): Promise<void> {
    if (!isRecord(form.metadata) || form.metadata.kind !== 'mcp-elicitation' || typeof form.id !== 'string' || this.globalForms.has(form.id)) return;
    const state = { settled: false };
    this.globalForms.set(form.id, state);
    let scope: ReturnType<NonNullable<OpencodeSessionKernelOptions['openNativeInteraction']>>;
    try {
      // V2 global events omit location. The location-scoped inventory establishes ownership
      // before the server-selected interaction owner attaches UI or an answer.
      const pending = await this.requireClient().request<{ data: Array<Record<string, unknown>> }>('/api/form');
      if (this.disposed || state.settled || !pending.data.some(candidate => candidate.id === form.id && candidate.sessionID === 'global')) return;
      scope = this.options.openNativeInteraction?.();
      if (!scope) throw new Error('OpenCode MCP form has no interaction owner.');
      await this.interact(form, true, scope.turnId);
    } finally {
      scope?.close();
      this.globalForms.delete(form.id);
    }
  }

  private async interact(data: Record<string, unknown>, question: boolean, childTurnId?: string): Promise<void> {
    const id = String(data.id);
    const turnId = childTurnId ?? this.options.getActiveTurnId();
    if (!turnId || this.interactions.has(id)) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, controller.signal]);
    this.interactions.set(id, controller);
    const identity = { interactionId: id, sessionInstanceId: this.options.sessionInstanceId, turnId };
    const route = `/api/session/${encodeURIComponent(String(data.sessionID))}/${question ? 'form' : 'permission'}/${encodeURIComponent(id)}`;
    let projectionError: unknown;
    try {
      if (question) {
        const fields = Array.isArray(data.fields) ? data.fields.filter(isRecord) : [];
        let questions;
        try { questions = projectOpencodeFormQuestions(data); }
        catch (error) {
          projectionError = error;
          await this.requireClient().request(route, { method: 'DELETE' });
          throw error;
        }
        const response = await this.options.config.interactionPort.askUserQuestion({
          ...identity, kind: 'question', input: { questions },
        }, signal);
        if (signal.aborted) return;
        if (response.interactionId !== id || !response.answers) {
          await this.requireClient().request(route, { method: 'DELETE' }); return;
        }
        const answer: Record<string, unknown> = {};
        for (const field of fields) {
          const value = response.answers[String(field.key)];
          if (value === undefined) continue;
          answer[String(field.key)] = Array.isArray(value) ? value : field.type === 'boolean' ? value.toLowerCase() === 'true' : field.type === 'number' || field.type === 'integer' ? Number(value) : value;
        }
        await this.requireClient().request(`${route}/reply`, { method: 'POST', body: { answer } });
      } else {
        if (this.autoApprove) {
          await this.requireClient().request(`${route}/reply`, { method: 'POST', body: { decision: 'once' } });
          return;
        }
        const response = await this.options.config.interactionPort.requestApproval({
          ...identity, kind: 'approval', toolName: data.action === 'shell' ? 'bash' : String(data.action), input: { resources: data.resources, ...(isRecord(data.metadata) ? data.metadata : {}) }, description: typeof data.message === 'string' ? data.message : `${typeof data.action === 'string' ? data.action : 'Unknown action'}: ${Array.isArray(data.resources) ? data.resources.join(', ') : ''}`,
        }, signal);
        if (signal.aborted) return;
        const reply = response.interactionId === id && response.decision === 'allow' ? 'once' : response.interactionId === id && response.decision === 'allow-always' ? 'always' : 'reject';
        await this.requireClient().request(`${route}/reply`, { method: 'POST', body: { decision: reply } });
      }
    } catch (error) {
      // Native cancellation acknowledges our DELETE before its HTTP response. It must
      // not suppress the explanation for rejecting an unsupported form.
      if (projectionError || !signal.aborted) throw projectionError ?? error;
    } finally {
      if (this.interactions.delete(id)) this.options.config.interactionPort.dismissInteraction(id, 'resolved');
    }
  }

  private emitUsage(value: unknown): void {
    if (!isRecord(value)) return;
    const cache = isRecord(value.cache) ? value.cache : {};
    const model = this.models.find(model => model.id === this.model?.id && model.providerID === this.model?.providerID);
    const contextWindow = isRecord(model?.limit) ? count(model.limit.context) : 0;
    const inputTokens = count(value.input);
    const cacheReadInputTokens = count(cache.read);
    const cacheCreationInputTokens = count(cache.write);
    const contextTokens = countTokens(value);
    this.emit({ type: 'usage_updated', usage: {
      model: this.model ? `${this.model.providerID}/${this.model.id}` : undefined,
      inputTokens, cacheReadInputTokens, cacheCreationInputTokens, contextTokens, contextWindow,
      percentage: contextWindow > 0 ? Math.min(100, Math.max(0, Math.round(contextTokens / contextWindow * 100))) : 0,
    } });
  }

  private captureAdmission(id?: string): void {
    if (this.pending) this.pending.userMessageId = id;
  }
  private emit(event: OpencodeNativeOutput, childSessionId?: string): void { this.options.onNativeOutput?.(event, childSessionId); }

  /** Child activity is display-only; the card owning the child's spawn tool shows it. */
  private emitChildProgress(child: NativeChild): void {
    const { startedAt, toolUses, totalTokens, lastToolName } = child.progress;
    this.options.onNativeSubagentProgress?.({
      toolCallId: child.toolCallId, toolUses, durationMs: Date.now() - startedAt,
      ...(lastToolName ? { lastToolName } : {}), ...(totalTokens > 0 ? { totalTokens } : {}),
    });
  }
  /** Consumers treat the first user boundary as the submitted prompt, so it must precede any steer's. */
  private announcePrompt(): void {
    const pending = this.pending;
    if (!pending?.inputId || pending.announced) return;
    pending.announced = true;
    this.emit({ type: 'user_message_started', nativeUserMessageId: pending.inputId });
  }
  private settleSteer(id: string, outcome: boolean | Error): void {
    const steer = this.steers.get(id);
    if (!steer) return;
    this.steers.delete(id);
    if (outcome instanceof Error) steer.reject(outcome);
    else steer.resolve(outcome);
    // A steer admitted as the native execution ended runs as another native execution of this prompt.
    if (this.pending?.idle && this.steers.size === 0) this.finish();
  }
  private recallSteers(): Promise<unknown> {
    const client = this.disposed ? null : this.client;
    // Recall waits for admission so a DELETE cannot overtake the POST and leave the steer queued.
    return Promise.all([...this.steers].map(([id, steer]) => steer.recall ??= steer.admission.then(outcome => {
      if (outcome !== 'refused') return this.recallSteer(id, client);
    })));
  }
  private async recallSteer(id: string, client: OpencodeServerLease | null): Promise<void> {
    try {
      if (!client) throw new Error('OpenCode HTTP session is not connected.');
      await client.request(`/api/session/${encodeURIComponent(this.sessionId!)}/inbox/${encodeURIComponent(id)}`, { method: 'DELETE' });
      this.settleSteer(id, false);
    } catch (error) {
      // A conflict means native delivery or cancellation won; its event settles the steer when observed.
      this.settleSteer(id, new Error('OpenCode steer delivery could not be confirmed.', { cause: error }));
    }
  }
  private stopTools(sessionId?: string): void {
    for (const [key, tool] of this.tools) {
      if (sessionId !== undefined && tool.sessionId !== sessionId) continue;
      tool.shell?.stop();
      this.tools.delete(key);
    }
  }

  private finish(stopReason: 'end_turn' | 'cancelled' = 'end_turn'): void {
    const pending = this.pending;
    this.pending = null;
    this.stopTools(this.sessionId ?? undefined);
    void this.recallSteers();
    pending?.resolve({ stopReason, userMessageId: pending.userMessageId });
    this.options.onNativeTurn?.('completed', undefined, !!pending);
  }
  private fail(cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (this.disposed) return;
    const pending = this.pending;
    this.pending = null;
    this.stopTools(this.sessionId ?? undefined);
    void this.recallSteers();
    pending?.reject(error);
    this.options.onNativeTurn?.('completed', error.message, !!pending);
    if (!pending) this.options.onClosed(error);
  }
  private requireClient(): OpencodeServerLease {
    if (!this.client || this.disposed) throw new Error('OpenCode HTTP session is not connected.');
    return this.client;
  }
  private resolveSystemPrompt({ profile, systemInstructions }: OpencodeKernelConnectOptions): string {
    if (systemInstructions.kind === 'explicit') return systemInstructions.instructions;
    const workspaceRoot = this.options.config.vaultWorkingDirectory;
    return buildOpencodeSystemPrompt(profile, {
      settings: getSystemPromptSettings(this.options.plugin, workspaceRoot),
      dynamicSections: systemInstructions.dynamicSections,
      titleLocale: resolveTitleGenerationLocale(this.options.plugin.settings),
      workspaceRoot,
    });
  }
}

function toNativeInput(request: ACPPromptRequest): { text: string; files: Array<{ uri: string }> } {
  return {
    text: request.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n'),
    files: request.prompt.flatMap(block => block.type === 'image' ? [{ uri: `data:${block.mimeType};base64,${block.data}` }] : []),
  };
}

function nativeMessageId(): string {
  return `msg_${randomUUID().replaceAll('-', '')}`;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Every token a native step processed, including cached input. */
function countTokens(value: unknown): number {
  if (!isRecord(value)) return 0;
  const cache = isRecord(value.cache) ? value.cache : {};
  return count(value.input) + count(cache.read) + count(cache.write) + count(value.output) + count(value.reasoning);
}

function errorText(error: unknown): string {
  return isRecord(error) && typeof error.message === 'string' ? error.message : typeof error === 'string' ? error : JSON.stringify(error) ?? 'OpenCode execution failed.';
}
