import { randomUUID } from 'node:crypto';

import { parseCompactCommand } from '@/core/commands/compactCommand';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
} from '@/core/prompt/historyContext';
import { appendExecutionContext } from '@/core/prompt/promptContext';
import { invokeSessionTool } from '@/core/session-tools/invokeSessionTool';
import { SESSION_TOOL_ROUTE_HEADER, type SessionToolRoute } from '@/core/session-tools/SessionToolEndpoint';
import { SESSION_TOOL_MCP_SERVER_NAME } from '@/core/session-tools/sessionToolMCP';
import { isSessionTool } from '@/core/tools/toolNames';
import {
  type ACPContentBlock,
  type ACPCreateElicitationRequest,
  type ACPCreateElicitationResponse,
  ACPInteractionController,
  type ACPMCPServer,
  type ACPPromptResponse,
  ACPRequestedTurn,
  type ACPRequestPermissionRequest,
  type ACPRequestPermissionResponse,
  type ACPSessionConfigOption,
  type ACPSessionModelState,
  type ACPSessionNotification,
  buildACPUsageInfo,
  mapACPApprovalDecision,
  normalizeACPAvailableCommands,
} from '@/providers/acp';

import {
  type ProviderExecutionRequest,
  type ProviderExecutionRun,
  type ProviderExecutionSession,
  type ProviderSessionConfig,
  type ProviderSessionEvent,
  type ProviderSessionInvalidation,
  type ProviderSessionSnapshot,
  type ProviderSessionStatus,
  RequestedRunChannel,
  SessionSnapshotState,
  type SteerableExecutionSession,
} from '../../../core/execution';
import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import type { ChatMessage, SlashCommand } from '../../../core/types';
import { filterAntigravityCommands } from '../commands/AntigravityCommandCatalog';
import { resolveAntigravityStoreRoot } from '../history/AntigravityHistoryPaths';
import { readAntigravityContextTokens } from '../history/AntigravityHistoryStore';
import {
  ANTIGRAVITY_MODE_CONFIG_ID,
  ANTIGRAVITY_MODEL_CONFIG_ID,
  ANTIGRAVITY_REASONING_CONFIG_ID,
  type AntigravityModel,
  decodeAntigravityModelId,
  readAntigravityConfigValue,
  readAntigravitySessionModels,
  readAntigravityThinkingLevels,
} from '../models';
import {
  createAntigravityToolStreamAdapter,
  normalizeAntigravityToolName,
  withAntigravityToolTitle,
} from '../normalization/antigravityToolNormalization';
import {
  resolveAntigravityNativeMode,
  shouldAutoApproveAntigravityPermission,
} from '../permissionModes';
import {
  ANTIGRAVITY_INLINE_EDIT_TOOLS,
  ANTIGRAVITY_MAIN_TOOLS,
  prepareAntigravityAgentFile,
} from '../runtime/AntigravityAgentFiles';
import { resolveAntigravityLaunchSpec } from '../runtime/AntigravityExecutionContext';
import { parseAntigravityProviderState } from '../types';
import { ANTIGRAVITY_ACP_ARGS, AntigravityNativeConnection } from './AntigravityNativeConnection';
import { AntigravityQuestionRouter } from './AntigravityQuestionRouter';

export interface AntigravityLiveModelSink {
  mergeLiveModels(models: AntigravityModel[], defaultModelId: string | null): Promise<unknown>;
}

export interface AntigravityExecutionSessionOptions {
  readonly modelSink?: AntigravityLiveModelSink;
}

interface PendingSteer {
  applied: boolean;
  /** Echo prefixes that identify this steer; agy strips a leading slash-command name. */
  readonly echoPrefixes: readonly string[];
  readonly resolveEcho: () => void;
  readonly text: string;
}

/** One `session/prompt` request; a rejected steer's slot is reused by a new record. */
interface PromptRecord {
  readonly response: Promise<ACPPromptResponse>;
  /** Superseded prompts settle when agy hands their turn to the next one. */
  settled: boolean;
}

interface ActiveExecution {
  readonly abortController: AbortController;
  /** Set once the run starts native work; cancelling before any prompt then retires the process. */
  nativeTouched: boolean;
  /** Prompts sent for this run; only the latest one's response ends it (earlier ones hand off). */
  latestPrompt: number;
  readonly prompts: Map<number, PromptRecord>;
  readonly request: ProviderExecutionRequest;
  readonly run: RequestedRunChannel;
  readonly steers: PendingSteer[];
  readonly turn: ACPRequestedTurn;
}

interface NativeOwner {
  /** Latest filtered `available_commands_update` per native session; it can precede session capture. */
  readonly commandsBySession: Map<string, SlashCommand[]>;
  configOptions: ACPSessionConfigOption[];
  initialized: boolean;
  loadedSessionId: string | null;
  /** Agent selected by this process, checked only when creating a native session. */
  readonly creationAgentName?: string;
  readonly native: AntigravityNativeConnection;
  unsubscribe: () => void;
}

const CANCEL_SETTLE_TIMEOUT_MS = 2_000;

const PASSIVE_TOOL_INSTRUCTION = [
  'Do not use any tools for this request.',
  'Answer only from information supplied directly in the prompt.',
].join(' ');

export class AntigravityExecutionSession implements ProviderExecutionSession, SteerableExecutionSession {
  readonly providerId = 'antigravity' as const;
  readonly sessionInstanceId = randomUUID();

  private active: ActiveExecution | null = null;
  private cancellationFlight: Promise<void> | null = null;
  private disposalFlight: Promise<void> | null = null;
  private disposed = false;
  private nativeConversationContextEstablished: boolean;
  private nativeOwner: NativeOwner | null = null;
  private nativeStartupFlight: Promise<NativeOwner> | null = null;
  private providerSessionId: string | undefined;
  private sessionToolRoute: Promise<SessionToolRoute> | null = null;
  private readonly interactionController: ACPInteractionController;
  private readonly questionRouter: AntigravityQuestionRouter;
  private readonly state: SessionSnapshotState;

  constructor(
    private readonly host: ProviderRuntimeHost,
    private readonly config: ProviderSessionConfig,
    private readonly options: AntigravityExecutionSessionOptions = {},
  ) {
    this.providerSessionId = config.resumeSeed?.providerSessionId;
    const providerState = parseAntigravityProviderState(config.resumeSeed?.providerState);
    this.state = new SessionSnapshotState({
      providerId: this.providerId,
      providerState: { ...providerState },
      readProviderSessionId: () => this.providerSessionId,
      sessionInstanceId: this.sessionInstanceId,
    });
    this.nativeConversationContextEstablished = Boolean(
      this.providerSessionId && providerState.nativeConversationContextEstablished !== false,
    );
    this.interactionController = new ACPInteractionController({
      getTurnId: () => this.active?.run.turnId ?? null,
      interactionPort: config.interactionPort,
      presentPermission: request => {
        const name = normalizeAntigravityToolName(readNativeToolName(request) ?? request.toolCall.title ?? 'tool', request.toolCall.rawInput);
        return { description: request.toolCall.title || name, toolName: name };
      },
      sessionInstanceId: this.sessionInstanceId,
    });
    this.questionRouter = new AntigravityQuestionRouter(
      config.interactionPort,
      this.sessionInstanceId,
      () => this.active?.run.turnId ?? null,
      () => this.providerSessionId,
    );
  }

  execute(request: ProviderExecutionRequest): ProviderExecutionRun {
    if (this.disposed) throw new Error('Antigravity execution session is disposed.');
    if (this.active) throw new Error('Antigravity execution session is already executing.');
    const run = new RequestedRunChannel({
      onCancel: source => { void this.#cancelRun(run, source === 'abort-signal' ? 'aborted' : 'cancelled'); },
      sessionInstanceId: this.sessionInstanceId,
    });
    const active: ActiveExecution = {
      abortController: new AbortController(),
      latestPrompt: 0,
      nativeTouched: false,
      prompts: new Map(),
      request,
      run,
      steers: [],
      turn: new ACPRequestedTurn({
        onAccept: () => {
          if (this.nativeConversationContextEstablished) return;
          this.#setNativeConversationContextEstablished(true);
          this.#updateSnapshot('executing');
          this.#emitCurrentSnapshot();
        },
        run,
        toolStreamAdapter: createAntigravityToolStreamAdapter(toolCallId => this.questionRouter.takeAnswers(toolCallId)),
      }),
    };
    this.active = active;
    this.#updateSnapshot('executing');
    this.#emitCurrentSnapshot();
    run.attachAbortSignal(request.signal);
    if (!run.isCancellationRequested) void this.#performExecution(active);
    return run;
  }

  cancel(): void {
    this.active?.run.cancel();
  }

  getCommandSnapshot(): readonly SlashCommand[] | undefined {
    const sessionId = this.providerSessionId;
    const commands = sessionId ? this.nativeOwner?.commandsBySession.get(sessionId) : undefined;
    return commands?.map(command => ({ ...command }));
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.state.getSnapshot();
  }

  getStatus(): ProviderSessionStatus {
    return this.state.status;
  }

  onEvent(listener: (event: ProviderSessionEvent) => void): () => void {
    return this.state.onEvent(listener);
  }

  dispose(): Promise<void> {
    if (this.disposalFlight) return this.disposalFlight;
    this.disposed = true;
    this.disposalFlight = (async () => {
      try {
        const active = this.active;
        if (active) await this.#cancelRun(active.run, 'session-disposed');
        if (this.cancellationFlight) await this.cancellationFlight;
        await this.#shutdownNative();
      } finally {
        const route = await this.sessionToolRoute?.catch(() => null);
        route?.dispose();
        this.interactionController.dispose();
        this.questionRouter.dismissAll('session-disposed');
        this.state.clearListeners();
        this.#updateSnapshot('disposed');
      }
    })();
    return this.disposalFlight;
  }

  /**
   * agy steers by accepting another prompt during a running turn: the earlier prompt request
   * resolves at once and the turn continues under the new one. The steer is accepted when agy
   * echoes it into the turn, or when the turn it joined completes; it was definitely not handed
   * off only if agy rejects it while the earlier prompt is still running.
   */
  async steer(request: ProviderExecutionRequest): Promise<boolean> {
    const active = this.active;
    const owner = this.nativeOwner;
    const sessionId = this.providerSessionId;
    if (
      !active || this.#isCancellationRequested(active) || request.signal.aborted
      || active.latestPrompt === 0 || !owner?.initialized || owner.loadedSessionId !== sessionId || !sessionId
      // A settled latest prompt has ended the native turn; the run is only finishing its usage read.
      || active.prompts.get(active.latestPrompt)!.settled
    ) return false;
    const previous = active.prompts.get(active.latestPrompt)!;
    const text = getInputText(request);
    let resolveEcho!: () => void;
    const echoed = new Promise<'echo'>(resolve => { resolveEcho = () => resolve('echo'); });
    const steer: PendingSteer = { applied: false, echoPrefixes: buildSteerEchoPrefixes(text), resolveEcho, text };
    active.steers.push(steer);
    const index = this.#sendPrompt(active, owner.native, sessionId, buildPromptBlocks(request));
    const ownPrompt = active.prompts.get(index)!.response;
    try {
      const ownRejection = ownPrompt.then(() => new Promise<never>(() => {}));
      const outcome = await Promise.race([echoed, ownRejection, this.#waitForLatestPrompt(active)]);
      if (outcome !== 'echo' && outcome.stopReason === 'cancelled' && !steer.applied) {
        throw new Error('The Antigravity turn was cancelled before the steer was confirmed.');
      }
      return true;
    } catch (error) {
      const rejectedBeforeHandoff = !steer.applied && !previous.settled
        && await ownPrompt.then(() => false, () => true);
      if (!rejectedBeforeHandoff) throw error;
      active.steers.splice(active.steers.indexOf(steer), 1);
      return false;
    }
  }

  async #performExecution(active: ActiveExecution): Promise<void> {
    if (active.request.toolPolicy.kind === 'allow-list') {
      this.#failUnrecoverable(active, 'Antigravity does not support exact tool allow-lists.');
      return;
    }
    let unsubscribeClose: (() => void) | undefined;
    try {
      if (this.cancellationFlight) await this.cancellationFlight;
      if (this.#isCancellationRequested(active)) return;
      active.nativeTouched = true;
      const owner = await this.#ensureSession(active);
      if (this.#isCancellationRequested(active)) return;
      await this.#applyConfiguration(owner, active);
      if (this.#isCancellationRequested(active)) return;
      const sessionId = this.providerSessionId!;
      const compact = parseCompactCommand(getInputText(active.request));
      if (compact && !this.nativeConversationContextEstablished && active.request.conversationHistory?.length) {
        throw new Error('Send a normal message to restore the native conversation before using /compact.');
      }
      active.turn.beginLiveOutput();
      const closed = new Promise<never>((_resolve, reject) => {
        unsubscribeClose = owner.native.onClose(error => reject(new Error('Antigravity transport closed', { cause: error })));
      });
      const blocks = compact
        ? [{ text: `/compact${compact.instructions ? ` ${compact.instructions}` : ''}`, type: 'text' as const }]
        : buildPromptBlocks(active.request, !this.nativeConversationContextEstablished);
      const promptIndex = this.#sendPrompt(active, owner.native, sessionId, blocks);
      // Consumers treat the first user boundary as the turn's own input; only later ones mark steers. agy's
      // echo of this prompt is not a reliable boundary (`/compact` and images are not echoed).
      active.run.emit({ content: getInputText(active.request), type: 'user_message_started' });
      const response = await Promise.race([closed, this.#waitForLatestPrompt(active)]);
      if (this.#isCancellationRequested(active)) return;
      // agy reports compaction only in its transcript; a completed `/compact` prompt (not a steer that took
      // over its turn) has compacted the context.
      if (compact && response.stopReason === 'end_turn' && active.latestPrompt === promptIndex) {
        active.run.emit({ type: 'context_compacted' });
      }
      // Completion confirms steers agy never echoed (image-only input), so they still need their boundary.
      if (response.stopReason !== 'cancelled') {
        for (const steer of active.steers) {
          if (steer.applied) continue;
          steer.applied = true;
          active.run.emit({ content: steer.text, type: 'user_message_started' });
        }
      }
      const contextTokens = await this.#readContextTokens(owner, response);
      if (this.#isCancellationRequested(active)) return;
      this.#finishCompleted(active, response, contextTokens);
    } catch (error) {
      if (this.#isCancellationRequested(active)) return;
      this.#failRecoverable(active, error);
    } finally {
      unsubscribeClose?.();
      // Answers whose tool result never arrived have no consumer once the run ends; a later run owns its own.
      if (!this.active || this.active === active) this.questionRouter.clearAnswers();
    }
  }

  #sendPrompt(
    active: ActiveExecution,
    native: AntigravityNativeConnection,
    sessionId: string,
    prompt: ACPContentBlock[],
  ): number {
    const index = active.latestPrompt + 1;
    active.latestPrompt = index;
    const response = native.prompt({ prompt, sessionId });
    const record: PromptRecord = { response, settled: false };
    const markSettled = () => { record.settled = true; };
    response.then(markSettled, markSettled);
    active.prompts.set(index, record);
    return index;
  }

  /**
   * Resolves with the response of whichever prompt is latest when it settles. A steer prompt rejected while the
   * prompt it would take over is still running was never handed off, so completion follows that prompt again.
   */
  async #waitForLatestPrompt(active: ActiveExecution): Promise<ACPPromptResponse> {
    for (;;) {
      const index = active.latestPrompt;
      try {
        const response = await active.prompts.get(index)!.response;
        if (index === active.latestPrompt) return response;
      } catch (error) {
        if (index !== active.latestPrompt) continue;
        const previous = Math.max(0, ...[...active.prompts.keys()].filter(key => key < index));
        if (previous === 0 || active.prompts.get(previous)!.settled) throw error;
        active.prompts.delete(index);
        active.latestPrompt = previous;
      }
    }
  }

  async #ensureNative(active: ActiveExecution, creationAgentName?: string): Promise<NativeOwner> {
    const owner = this.nativeOwner;
    if (!this.nativeStartupFlight && owner?.initialized && owner.native.isAlive()
      && (creationAgentName === undefined || owner.creationAgentName === creationAgentName)) return owner;
    let flight = this.nativeStartupFlight;
    if (!flight) {
      flight = this.#startNative(active, creationAgentName);
      this.nativeStartupFlight = flight;
      const clear = () => { if (this.nativeStartupFlight === flight) this.nativeStartupFlight = null; };
      flight.then(clear, clear);
    }
    const started = await flight;
    this.#throwIfCancellationRequested(active);
    return started;
  }

  async #startNative(active: ActiveExecution, creationAgentName?: string): Promise<NativeOwner> {
    const previous = this.nativeOwner;
    if (previous) await this.#shutdownNativeOwner(previous);
    const args = creationAgentName ? [...ANTIGRAVITY_ACP_ARGS, '--agent', creationAgentName] : ANTIGRAVITY_ACP_ARGS;
    const launch = await resolveAntigravityLaunchSpec(this.host, args, this.config.workingDirectory);
    // A run cancelled during CLI lookup must not spawn a process that cancellation then waits on.
    this.#throwIfCancellationRequested(active);
    const native = new AntigravityNativeConnection({
      createElicitation: request => this.#handleElicitation(request),
      launch,
      requestPermission: request => this.#handlePermission(request),
      version: this.host.clientVersion ?? '0.0.0',
    });
    const owner: NativeOwner = {
      commandsBySession: new Map(),
      configOptions: [],
      initialized: false,
      loadedSessionId: null,
      creationAgentName,
      native,
      unsubscribe: () => {},
    };
    this.nativeOwner = owner;
    try {
      owner.unsubscribe = native.onNotification(notification => {
        if (this.#isCurrentOwner(owner)) this.#handleNotification(owner, notification);
      });
      await native.initialize();
      if (this.disposed || !this.#isCurrentOwner(owner)) throw new AntigravityExecutionCancellationError();
      owner.initialized = true;
      return owner;
    } catch (error) {
      await this.#shutdownNativeOwner(owner).catch(() => undefined);
      throw error;
    }
  }

  async #ensureSession(active: ActiveExecution): Promise<NativeOwner> {
    let owner: NativeOwner;
    if (this.providerSessionId) {
      // The saved session owns its agent. Restoration must not require or inspect any agent file.
      owner = await this.#ensureNative(active);
      if (owner.loadedSessionId === this.providerSessionId) return owner;
    } else {
      const instructions = active.request.configuration.systemInstructions;
      const main = instructions.kind === 'main-agent';
      const name = main
        ? instructions.projectId ? `claudian-project-${instructions.projectId}` : 'claudian-main'
        : `claudian-${instructions.purpose}`;
      const tools = main ? ANTIGRAVITY_MAIN_TOOLS
        : instructions.purpose === 'inline-edit' ? ANTIGRAVITY_INLINE_EDIT_TOOLS : [];
      const body = active.request.toolPolicy.kind === 'passive'
        ? `${instructions.instructions}\n\n${PASSIVE_TOOL_INSTRUCTION}` : instructions.instructions;
      await prepareAntigravityAgentFile(this.config.workingDirectory, name, body, tools);
      this.#throwIfCancellationRequested(active);
      owner = await this.#ensureNative(active, name);
    }
    const mcpServers = await this.#getMCPServers();
    this.#throwIfCancellationRequested(active);
    const request = { cwd: owner.native.launch.targetCwd, mcpServers };
    const creating = !this.providerSessionId;
    if (creating) {
      const response = await owner.native.newSession(request);
      // Publish the recoverable locator before MCP readiness, including when cancellation won the race.
      this.#captureSessionId(response.sessionId);
      this.#setNativeConversationContextEstablished(false);
      this.#emitCurrentSnapshot();
      this.#throwIfCancellationRequested(active);
    }
    // New custom agents need a same-process resume to install ACP MCP servers before the first prompt.
    // Never use session/load: agy accepts unknown ids there and fails on their next prompt.
    let response;
    try {
      response = await owner.native.resumeSession({ ...request, sessionId: this.providerSessionId! });
    } catch (error) {
      if (creating) throw new AntigravitySessionPreparationError(error);
      throw error;
    }
    this.#throwIfCancellationRequested(active);
    this.#captureSessionId(response.sessionId ?? this.providerSessionId!);
    owner.loadedSessionId = this.providerSessionId!;
    this.#adoptConfigOptions(owner, response.configOptions, response.models);
    this.#updateSnapshot(this.active ? 'executing' : 'idle');
    this.#emitCurrentSnapshot();
    return owner;
  }

  #captureSessionId(sessionId: string): void {
    this.providerSessionId = sessionId;
    if ('historySessionId' in this.state.providerState) this.state.deleteProviderStateValue('historySessionId');
  }

  async #applyConfiguration(owner: NativeOwner, active: ActiveExecution): Promise<void> {
    const sessionId = this.providerSessionId!;
    const { configuration } = active.request;
    const rawModel = configuration.model ? decodeAntigravityModelId(configuration.model) : null;
    if (rawModel) {
      const { models } = readAntigravitySessionModels(owner.configOptions);
      if (models.length > 0 && !models.some(model => model.rawId === rawModel)) {
        throw new Error(`Antigravity model "${rawModel}" is not available in this session.`);
      }
      await this.#setConfigOption(owner, active, sessionId, ANTIGRAVITY_MODEL_CONFIG_ID, rawModel);
    }
    const reasoning = configuration.reasoning?.trim();
    // agy offers no thinking level for fixed-effort models (GPT-OSS runs at medium).
    const efforts = readAntigravityThinkingLevels(owner.configOptions);
    if (reasoning && efforts.length > 0) {
      if (!efforts.some(effort => effort.value === reasoning)) {
        throw new Error(`Antigravity does not support thinking level "${reasoning}".`);
      }
      await this.#setConfigOption(owner, active, sessionId, ANTIGRAVITY_REASONING_CONFIG_ID, reasoning);
    }
    await this.#setConfigOption(
      owner, active, sessionId, ANTIGRAVITY_MODE_CONFIG_ID, resolveAntigravityNativeMode(configuration.permissionMode),
    );
  }

  async #setConfigOption(
    owner: NativeOwner,
    active: ActiveExecution,
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    if (readAntigravityConfigValue(owner.configOptions, configId) === value) return;
    const response = await owner.native.setConfigOption({ configId, sessionId, value });
    this.#throwIfCancellationRequested(active);
    this.#adoptConfigOptions(owner, response.configOptions);
  }

  /** Only session/new and resume responses carry the full model list (`sessionModels`), so only they report it. */
  #adoptConfigOptions(
    owner: NativeOwner,
    configOptions: ACPSessionConfigOption[] | null | undefined,
    sessionModels?: ACPSessionModelState | null,
  ): void {
    if (!configOptions?.length) return;
    owner.configOptions = configOptions;
    if (!sessionModels) return;
    const { currentModelId, models } = readAntigravitySessionModels(configOptions, sessionModels);
    if (models.length > 0) {
      void this.options.modelSink?.mergeLiveModels(models, currentModelId).catch(() => undefined);
    }
  }

  async #getMCPServers(): Promise<ACPMCPServer[]> {
    if (!this.config.sessionTools) return [];
    this.sessionToolRoute ??= this.host.sessionToolEndpoint.registerMCPRoute(call => {
      // Capture ownership before dispatch: a pending call must never adopt a later run.
      const active = this.active;
      return invokeSessionTool(call.name, call.args, {
        port: this.config.sessionTools,
        signal: active ? AbortSignal.any([active.abortController.signal, call.signal]) : AbortSignal.abort(),
        toolPolicy: active?.request.toolPolicy,
      });
    }).then(route => {
      if (this.disposed) {
        route.dispose();
        throw new AntigravityExecutionCancellationError();
      }
      return route;
    }).catch(error => {
      this.sessionToolRoute = null;
      throw error;
    });
    const route = await this.sessionToolRoute;
    return [{
      headers: [{ name: SESSION_TOOL_ROUTE_HEADER, value: route.routeId }],
      name: SESSION_TOOL_MCP_SERVER_NAME,
      type: 'http',
      url: route.url,
    }];
  }

  #handlePermission(request: ACPRequestPermissionRequest): Promise<ACPRequestPermissionResponse> {
    const active = this.active;
    const cancelled: ACPRequestPermissionResponse = { outcome: { outcome: 'cancelled' } };
    if (!active || this.#isCancellationRequested(active) || request.sessionId !== this.providerSessionId) {
      return Promise.resolve(cancelled);
    }
    const toolName = normalizeAntigravityToolName(readNativeToolName(request) ?? request.toolCall.title ?? '', request.toolCall.rawInput);
    const policy = active.request.toolPolicy.kind;
    if (policy === 'passive') return Promise.resolve(cancelled);
    if (policy === 'read-only') {
      return Promise.resolve(readNativeToolName(request) === 'run_command'
        ? mapACPApprovalDecision('allow', request.options) : cancelled);
    }
    if (isSessionTool(toolName)) {
      return Promise.resolve(this.config.sessionTools ? mapACPApprovalDecision('allow', request.options) : cancelled);
    }
    if (policy === 'unrestricted' || shouldAutoApproveAntigravityPermission(active.request.configuration.permissionMode)) {
      return Promise.resolve(mapACPApprovalDecision('allow', request.options));
    }
    return this.interactionController.requestPermission(request, active.abortController.signal);
  }

  #handleElicitation(request: ACPCreateElicitationRequest): Promise<ACPCreateElicitationResponse> {
    const active = this.active;
    if (!active || this.#isCancellationRequested(active)) return Promise.resolve({ action: 'cancel' });
    return this.questionRouter.handle(request, active.abortController.signal);
  }

  #handleNotification(owner: NativeOwner, notification: ACPSessionNotification): void {
    if (notification.update.sessionUpdate === 'available_commands_update') {
      owner.commandsBySession.set(
        notification.sessionId,
        filterAntigravityCommands(normalizeACPAvailableCommands(notification.update.availableCommands)),
      );
      if (notification.sessionId === this.providerSessionId) this.state.emit({ type: 'commands_changed' });
      return;
    }
    const active = this.active;
    if (!active || this.#isCancellationRequested(active) || notification.sessionId !== this.providerSessionId) return;
    const update = notification.update as ACPSessionNotification['update'] & { name?: unknown };
    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        // agy echoes prompts it accepts; only a steer's echo marks a new user message (the turn's own
        // boundary is emitted when its prompt is sent).
        if (active.turn.acceptingLiveOutput) active.turn.accept();
        this.#applySteerEcho(active, update.content);
        return;
      case 'session_info_update':
        // Claudian owns conversation titles.
        return;
      case 'tool_call':
      case 'tool_call_update': {
        active.turn.handleUpdate(withAntigravityToolTitle(update));
        return;
      }
      default: {
        const metadata = active.turn.handleUpdate(update);
        if (metadata?.type === 'config_options') this.#adoptConfigOptions(owner, metadata.configOptions);
      }
    }
  }

  #applySteerEcho(active: ActiveExecution, content: ACPContentBlock): void {
    const text = content.type === 'text' ? content.text.trim() : '';
    const steer = active.steers.find(entry => !entry.applied && entry.echoPrefixes.some(prefix => (
      prefix ? text.startsWith(prefix) : !text
    )));
    if (!steer) return;
    steer.applied = true;
    steer.resolveEcho();
    active.run.emit({ content: steer.text, type: 'user_message_started' });
  }

  /** The response's usage sums every model call in the turn; the transcript's latest call measures the context. */
  async #readContextTokens(owner: NativeOwner, response: ACPPromptResponse): Promise<number | null> {
    if (!response.usage) return null;
    const storeRoot = resolveAntigravityStoreRoot(owner.native.launch.env, process.platform);
    return storeRoot ? readAntigravityContextTokens(storeRoot, this.providerSessionId!) : null;
  }

  #finishCompleted(active: ActiveExecution, response: ACPPromptResponse, contextTokens: number | null): void {
    // A successful response proves acceptance even when agy streamed no output for it.
    active.turn.accept();
    if (response.usage) {
      const model = active.request.configuration.model
        ? decodeAntigravityModelId(active.request.configuration.model) ?? undefined
        : undefined;
      const windowSize = getAntigravityContextWindowWorkaround(model);
      const usage = buildACPUsageInfo({
        // An unmeasured context reports none, which hides the meter rather than showing the turn's summed usage.
        contextWindow: { size: windowSize ?? 0, used: contextTokens ?? 0 },
        model,
        promptUsage: response.usage,
      });
      if (usage) active.run.emit({ type: 'usage_updated', usage });
    }
    this.#updateSnapshot('idle');
    this.#emitCurrentSnapshot();
    active.abortController.abort();
    active.run.finish({
      providerPayload: response,
      reason: response.stopReason === 'max_tokens' ? 'max-tokens' : response.stopReason === 'end_turn' ? 'completed' : 'provider-ended',
      type: 'turn_completed',
    });
    active.turn.dispose();
    this.active = null;
  }

  #failUnrecoverable(active: ActiveExecution, message: string): void {
    this.#updateSnapshot('invalidated', { message, reason: 'configuration-changed', recoverable: false });
    this.#emitCurrentSnapshot();
    active.abortController.abort();
    active.run.finish({ category: 'configuration', message, recoverable: false, type: 'execution_error' });
    active.turn.dispose();
    if (this.active === active) this.active = null;
  }

  #failRecoverable(active: ActiveExecution, error: unknown): void {
    const message = describeError(error);
    const category = classifyError(error);
    this.#updateSnapshot('invalidated', {
      message,
      reason: category === 'provider-session-missing'
        ? 'provider-session-missing'
        : category === 'transport' ? 'transport-closed' : 'provider-error',
      recoverable: true,
    });
    this.#emitCurrentSnapshot();
    active.abortController.abort();
    active.run.finish({
      category,
      message,
      ...(category === 'provider-session-missing' && this.providerSessionId
        ? { missingProviderSessionId: this.providerSessionId }
        : {}),
      recoverable: true,
      type: 'execution_error',
    });
    active.turn.dispose();
    if (this.active === active) this.active = null;
  }

  async #cancelRun(run: RequestedRunChannel, reason: string): Promise<void> {
    const active = this.active;
    if (!active || active.run !== run || run.isTerminal) return;
    if (this.cancellationFlight) return this.cancellationFlight;
    this.#updateSnapshot('cancelling');
    this.#emitCurrentSnapshot();
    active.abortController.abort();
    this.interactionController.dismissAll('cancelled');
    this.questionRouter.dismissAll('cancelled');
    const owner = this.nativeOwner;
    const sessionId = this.providerSessionId;
    this.cancellationFlight = (async () => {
      try {
        const latest = active.prompts.get(active.latestPrompt)?.response;
        if (owner && sessionId && latest) {
          owner.native.cancel(sessionId);
          // agy settles a cancelled prompt at once; a process that does not is replaced.
          const settled = await settleWithin(latest, CANCEL_SETTLE_TIMEOUT_MS);
          if (!settled) await this.#shutdownNative();
        } else if (active.nativeTouched) {
          // Startup, resume or configuration was interrupted; its native outcome is unknown.
          await this.#shutdownNative();
        }
      } catch {
        // Teardown failure cannot replace the already-requested cancellation terminal.
      } finally {
        if (!this.disposed) {
          this.#updateSnapshot('idle');
          this.#emitCurrentSnapshot();
        }
        active.run.finish({ reason, type: 'cancelled' });
        active.turn.dispose();
        if (this.active === active) this.active = null;
      }
    })().finally(() => { this.cancellationFlight = null; });
    return this.cancellationFlight;
  }

  #isCancellationRequested(active: ActiveExecution): boolean {
    return this.disposed || active.run.isCancellationRequested || this.active !== active || active.run.isTerminal;
  }

  #throwIfCancellationRequested(active: ActiveExecution): void {
    if (this.#isCancellationRequested(active)) throw new AntigravityExecutionCancellationError();
  }

  async #shutdownNative(): Promise<void> {
    const flight = this.nativeStartupFlight;
    const owner = this.nativeOwner;
    if (owner) await this.#shutdownNativeOwner(owner);
    if (flight) await flight.catch(() => undefined);
    const remaining = this.nativeOwner;
    if (remaining) await this.#shutdownNativeOwner(remaining);
  }

  async #shutdownNativeOwner(owner: NativeOwner): Promise<void> {
    if (this.nativeOwner === owner) {
      this.nativeOwner = null;
      owner.unsubscribe();
    }
    await owner.native.shutdown();
  }

  #isCurrentOwner(owner: NativeOwner): boolean {
    return !this.disposed && this.nativeOwner === owner;
  }

  #setNativeConversationContextEstablished(established: boolean): void {
    this.nativeConversationContextEstablished = established;
    this.state.setProviderStateValue('nativeConversationContextEstablished', established);
  }

  #updateSnapshot(status: ProviderSessionStatus, invalidation?: ProviderSessionInvalidation): void {
    if (status === 'invalidated') this.state.invalidate(invalidation!);
    else this.state.setStatus(status);
  }

  #emitCurrentSnapshot(): void {
    const active = this.active;
    const event = { snapshot: this.state.getSnapshot(), type: 'session_state_changed' as const };
    if (active && !active.run.isTerminal) {
      active.run.emit(event);
      return;
    }
    this.state.emit(event);
  }
}

class AntigravitySessionPreparationError extends Error {
  constructor(cause: unknown) {
    super(`Could not prepare the new Antigravity session: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/**
 * Workaround: agy 1.5.1 reports no context window over ACP and auto-compacts Gemini's 1,048,576-token models at a
 * fixed 256,000 tokens (google-antigravity/antigravity-cli#1432), so Gemini models measure against that point
 * and other models leave the context meter hidden. Remove this once agy reports the limit.
 */
const GEMINI_CONTEXT_WINDOW_WORKAROUND = 256_000;

function getAntigravityContextWindowWorkaround(model: string | undefined): number | null {
  return model?.startsWith('gemini-') ? GEMINI_CONTEXT_WINDOW_WORKAROUND : null;
}

class AntigravityExecutionCancellationError extends Error {
  constructor() {
    super('Antigravity execution was cancelled.');
    this.name = 'AntigravityExecutionCancellationError';
  }
}

function readNativeToolName(request: ACPRequestPermissionRequest): string | undefined {
  const name = (request.toolCall as { name?: unknown }).name;
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

function buildSteerEchoPrefixes(text: string): string[] {
  const trimmed = text.trim();
  const withoutCommand = trimmed.replace(/^\/\S+\s*/, '');
  return withoutCommand === trimmed ? [trimmed] : [trimmed, withoutCommand];
}

function getInputText(request: ProviderExecutionRequest): string {
  return request.input.filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function buildPromptBlocks(request: ProviderExecutionRequest, replayConversationHistory = false): ACPContentBlock[] {
  const blocks: ACPContentBlock[] = [];
  let text = appendExecutionContext(getInputText(request), request.context);
  if (replayConversationHistory && request.conversationHistory?.length) {
    const history = [...request.conversationHistory] as ChatMessage[];
    text = buildPromptWithHistoryContext(buildContextFromHistory(history), text, text, history);
  }
  if (text) blocks.push({ text, type: 'text' });
  for (const block of request.input) {
    if (block.type === 'image' && block.image.data) {
      blocks.push({ data: block.image.data, mimeType: block.image.mediaType, type: 'image' });
    }
  }
  return blocks;
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: number | undefined;
  const timeout = new Promise<false>(resolve => { timer = window.setTimeout(() => resolve(false), timeoutMs); });
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    window.clearTimeout(timer);
  }
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /auth|sign[ -]?in|log[ -]?in|credential/i.test(message)
    ? `${message}\nSign in by running \`agy acp --login\` in a terminal.`
    : message;
}

function classifyError(
  error: unknown,
): 'authentication' | 'configuration' | 'provider-session-missing' | 'transport' | 'unknown' {
  if (error instanceof AntigravitySessionPreparationError) return 'unknown';
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (/auth|sign[ -]?in|log[ -]?in|credential/.test(message)) return 'authentication';
  if (message.includes('failed to read session')
    || (message.includes('session') && (message.includes('not found') || message.includes('missing')))) {
    return 'provider-session-missing';
  }
  if (message.includes('transport') || message.includes('closed')) return 'transport';
  if (message.includes('model') || message.includes('thinking level') || message.includes('config')) return 'configuration';
  return 'unknown';
}
