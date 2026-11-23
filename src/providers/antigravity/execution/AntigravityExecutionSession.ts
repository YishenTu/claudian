import { randomUUID } from 'node:crypto';

import { parseCompactCommand } from '@/core/commands/compactCommand';
import { buildTargetLaunchSpec } from '@/core/process/execution-target/TargetLaunchSpec';
import {
  buildContextFromHistory,
  buildPromptWithHistoryContext,
} from '@/core/prompt/historyContext';
import { appendExecutionContext } from '@/core/prompt/promptContext';
import { invokeSessionTool } from '@/core/session-tools/invokeSessionTool';
import { SESSION_TOOL_ROUTE_HEADER, type SessionToolRoute } from '@/core/session-tools/SessionToolEndpoint';
import { SESSION_TOOL_MCP_SERVER_NAME } from '@/core/session-tools/sessionToolMCP';
import { createWSLSessionToolRelay } from '@/core/session-tools/WSLSessionToolRelay';
import { isSessionTool } from '@/core/tools/toolNames';
import {
  type ACPContentBlock,
  type ACPCreateElicitationRequest,
  type ACPCreateElicitationResponse,
  ACPInteractionController,
  type ACPMCPServer,
  ACPNativeOwnerSlot,
  type ACPNormalizedUpdate,
  type ACPPromptResponse,
  ACPRequestedTurn,
  type ACPRequestPermissionRequest,
  type ACPRequestPermissionResponse,
  type ACPResumeSessionResponse,
  type ACPSessionConfigOption,
  type ACPSessionModelState,
  type ACPSessionNotification,
  allowACPPermission,
  buildACPUsageInfo,
  CANCELLED_ACP_PERMISSION_RESPONSE,
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
import { type AntigravityNativeStore, resolveAntigravityNativeStore } from '../history/AntigravityHistoryEnvironment';
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
import { mapAntigravityToolCallPaths } from '../normalization/antigravityNativePaths';
import {
  antigravityPermissionWarning,
  createAntigravityToolStreamAdapter,
  normalizeAntigravityToolName,
  presentAntigravityUpdate,
} from '../normalization/antigravityToolNormalization';
import {
  resolveAntigravityNativeMode,
  shouldAutoApproveAntigravityPermission,
} from '../permissionModes';
import { ANTIGRAVITY_INLINE_EDIT_TOOLS, prepareAntigravityAgentFile } from '../runtime/AntigravityAgentFiles';
import { resolveAntigravityExecutionContext } from '../runtime/AntigravityExecutionContext';
import { parseAntigravityProviderState } from '../types';
import { ANTIGRAVITY_REPLY_OUTPUT_KINDS, AntigravityBackgroundTurn } from './AntigravityBackgroundTurn';
import {
  ANTIGRAVITY_ACP_ARGS,
  ANTIGRAVITY_SKIP_PERMISSIONS_FLAG,
  AntigravityNativeConnection,
} from './AntigravityNativeConnection';
import { AntigravityQuestionRouter } from './AntigravityQuestionRouter';
import { AntigravitySubagentWatcher } from './AntigravitySubagentWatcher';

export interface AntigravityLiveModelSink {
  mergeLiveModels(models: AntigravityModel[], defaultModelId: string | null): Promise<unknown>;
}

export interface AntigravityExecutionSessionOptions {
  readonly modelSink?: AntigravityLiveModelSink;
}

/** What agy does on its own between runs. */
type LateWork =
  | { readonly phase: 'idle' }
  /**
   * agy is replying on its own. The turn keeps the updates it receives until the reply settles, even after a new run
   * starts: agy finishes that reply before it answers the new prompt.
   */
  | { readonly phase: 'replying'; readonly turn: AntigravityBackgroundTurn }
  /** After a Stop: agy then reports the calls its cancel ended, which open no turn, until the next run. */
  | { readonly phase: 'stopped' };

/** What decides agy's approvals: the run's tool policy and permission mode. */
interface ApprovalPolicy {
  readonly permissionMode: ProviderExecutionRequest['configuration']['permissionMode'];
  readonly toolPolicy: ProviderExecutionRequest['toolPolicy'];
}

interface PendingSteer {
  applied: boolean;
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
  /** Tool calls this run has streamed; see `presentAntigravityUpdate`. */
  readonly toolCallIds: Set<string>;
  readonly turn: ACPRequestedTurn;
}

/** The session ready for prompting in this process. */
interface LoadedNativeSession {
  readonly models: ACPSessionModelState | null | undefined;
  readonly sessionId: string;
  /** Main-agent prompt in effect; undefined for auxiliary sessions, whose prompt is their custom agent body. */
  readonly systemPromptAppend: string | undefined;
}

/** How the process must be launched for this run. */
interface NativeLaunchRequirement {
  /** Only for session/new: the agent the new session is created under; undefined `agentName` is agy's default agent. */
  readonly creation?: { readonly agentName: string | undefined };
  /** `--dangerously-skip-permissions`, which agy cannot change without restarting the process. */
  readonly skipPermissions: boolean;
}

interface NativeOwner {
  /** Latest filtered `available_commands_update` per native session; it can precede session capture. */
  readonly commandsBySession: Map<string, SlashCommand[]>;
  configOptions: ACPSessionConfigOption[];
  initialized: boolean;
  loaded: LoadedNativeSession | null;
  /** Agent selected by this process (`--agent`), checked only when creating a native session. */
  readonly creationAgentName?: string;
  readonly skipPermissions: boolean;
  readonly native: AntigravityNativeConnection;
  /** The store this process writes, as a host path; null where it cannot be located. */
  readonly store: AntigravityNativeStore | null;
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
  /** Main-agent sessions only: what agy does on its own between runs. */
  private lateWork: LateWork = { phase: 'idle' };
  /** The latest run's approval policy: agy runs under that run's configuration, so it decides approvals between runs. */
  private latestPolicy: ApprovalPolicy | null = null;
  /** Main-agent sessions only: holds idle release while a subagent has not reported. */
  private subagents: AntigravitySubagentWatcher | null = null;
  private cancellationFlight: Promise<void> | null = null;
  private disposalFlight: Promise<void> | null = null;
  private disposed = false;
  private nativeConversationContextEstablished: boolean;
  private readonly nativeSlot = new ACPNativeOwnerSlot<NativeOwner>(async (owner, wasCurrent) => {
    if (wasCurrent) {
      owner.unsubscribe();
      this.subagents?.processEnded();
      this.#closeBackground('interrupted');
    }
    await owner.native.shutdown();
  });
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
      describePermissionOption: antigravityPermissionWarning,
      getTurnId: () => this.#interactionTurnId(),
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
      () => this.#interactionTurnId(),
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
      toolCallIds: new Set(),
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
    this.latestPolicy = approvalPolicyOf(request);
    if (this.lateWork.phase === 'stopped') this.lateWork = { phase: 'idle' };
    this.subagents?.turnStarted();
    this.#updateSnapshot('executing');
    this.#emitCurrentSnapshot();
    run.attachAbortSignal(request.signal);
    if (!run.isCancellationRequested) void this.#performExecution(active);
    return run;
  }

  /** Cancels the active run, or else stops what agy is doing on its own between runs. */
  cancel(): void {
    if (this.active) {
      this.active.run.cancel();
      return;
    }
    const sessionId = this.providerSessionId;
    if (this.lateWork.phase !== 'replying' || !sessionId) return;
    // agy's cancel stops its own reply and the background tasks and subagents behind it.
    this.nativeSlot.current?.native.cancel(sessionId);
    this.#closeBackground('interrupted', 'stopped');
  }

  getCommandSnapshot(): readonly SlashCommand[] | undefined {
    const sessionId = this.providerSessionId;
    const commands = sessionId ? this.nativeSlot.current?.commandsBySession.get(sessionId) : undefined;
    return commands?.map(command => ({ ...command }));
  }

  getSnapshot(): ProviderSessionSnapshot {
    return this.state.getSnapshot();
  }

  /** Releasing the idle session would end agy's process, and the work it is still doing with it. */
  blocksIdleRelease(): boolean {
    return this.lateWork.phase === 'replying' || (this.subagents?.isWatching ?? false);
  }

  /** A report from a subagent agy's current process launched is agy's own write. */
  ownsNativeHistoryChange(from: string, to: string): Promise<boolean> {
    return this.subagents?.ownsHistoryChange(from, to) ?? Promise.resolve(false);
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
        await this.nativeSlot.shutdown();
      } finally {
        await this.subagents?.dispose();
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
   * resolves at once and the turn continues under the new one. The steer is accepted when that
   * earlier prompt settles, or when the turn it joined completes; it was definitely not handed
   * off only if agy rejects it while the earlier prompt is still running.
   */
  async steer(request: ProviderExecutionRequest): Promise<boolean> {
    const active = this.active;
    const owner = this.nativeSlot.current;
    const sessionId = this.providerSessionId;
    if (
      !active || this.#isCancellationRequested(active) || request.signal.aborted
      || active.latestPrompt === 0 || !owner?.initialized || owner.loaded?.sessionId !== sessionId || !sessionId
    ) return false;
    const previous = active.prompts.get(active.latestPrompt)!;
    const steer: PendingSteer = { applied: false, text: getInputText(request) };
    active.steers.push(steer);
    const index = this.#sendPrompt(active, owner.native, sessionId, buildPromptBlocks(request));
    const ownPrompt = active.prompts.get(index)!.response;
    // agy echoes no steer; it answers the prompt it takes over once the steer joins the turn.
    const pending = new Promise<never>(() => {});
    const handedOff = previous.response.then(
      response => (response.stopReason === 'cancelled' ? pending : 'handoff' as const),
      () => pending,
    );
    try {
      const ownRejection = ownPrompt.then(() => pending);
      const outcome = await Promise.race([handedOff, ownRejection, this.#waitForLatestPrompt(active)]);
      if (outcome === 'handoff') {
        this.#applySteer(active, steer);
        return true;
      }
      if (outcome.stopReason === 'cancelled' && !steer.applied) {
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
    let unsubscribeClose: (() => void) | undefined;
    try {
      if (this.cancellationFlight) await this.cancellationFlight;
      if (this.#isCancellationRequested(active)) return;
      active.nativeTouched = true;
      const owner = await this.#ensureSession(active);
      if (this.#isCancellationRequested(active)) return;
      await this.#applyConfiguration(owner, active);
      if (this.#isCancellationRequested(active)) return;
      // agy finishes its own reply before it answers a prompt; holding the prompt until that reply settles keeps a
      // fast answer from joining the reply's turn. A pending approval in the reply holds it too, as it holds agy.
      const late = this.#backgroundTurn();
      if (late) {
        await whenAborted(AbortSignal.any([late.signal, active.abortController.signal]));
        if (this.#isCancellationRequested(active)) return;
      }
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
      // Consumers treat the first user boundary as the turn's own input; only later ones mark steers.
      active.run.emit({ content: getInputText(active.request), type: 'user_message_started' });
      const response = await Promise.race([closed, this.#waitForLatestPrompt(active)]);
      if (this.#isCancellationRequested(active)) return;
      // agy reports compaction only in its transcript; a completed `/compact` prompt (not a steer that took
      // over its turn) has compacted the context.
      const compacted = compact !== null && response.stopReason === 'end_turn' && active.latestPrompt === promptIndex;
      if (compacted) active.run.emit({ type: 'context_compacted' });
      // Completion confirms steers whose handoff it raced, so they still need their boundary.
      if (response.stopReason !== 'cancelled') {
        for (const steer of active.steers) this.#applySteer(active, steer);
      }
      this.#finishCompleted(active, response, compacted);
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

  /** Without `creation`, any live process can resume an existing session; creation needs the matching agent. */
  async #ensureNative(active: ActiveExecution, { creation, skipPermissions }: NativeLaunchRequirement): Promise<NativeOwner> {
    const started = await this.nativeSlot.ensure(
      owner => owner.initialized && owner.native.isAlive() && owner.skipPermissions === skipPermissions
        && (!creation || owner.creationAgentName === creation.agentName),
      () => this.#startNative(active, creation?.agentName, skipPermissions),
    );
    this.#throwIfCancellationRequested(active);
    return started;
  }

  async #startNative(active: ActiveExecution, creationAgentName: string | undefined, skipPermissions: boolean): Promise<NativeOwner> {
    const previous = this.nativeSlot.current;
    if (previous) await this.nativeSlot.detach(previous);
    const args = [
      ...ANTIGRAVITY_ACP_ARGS,
      ...(creationAgentName ? ['--agent', creationAgentName] : []),
      ...(skipPermissions ? [ANTIGRAVITY_SKIP_PERMISSIONS_FLAG] : []),
    ];
    const context = await resolveAntigravityExecutionContext(this.host, this.config.workingDirectory);
    const launch = buildTargetLaunchSpec({ ...context, args });
    const store = await resolveAntigravityNativeStore({
      environment: context.env, environmentText: this.host.environmentText, hostPlatform: process.platform, vaultPath: context.hostCwd,
    }, context.target);
    // A run cancelled during CLI lookup must not spawn a process that cancellation then waits on.
    this.#throwIfCancellationRequested(active);
    if (context.target.method === 'wsl' && !store) {
      throw new Error('Could not determine the Antigravity WSL session store. Check the Linux HOME and shell startup.');
    }
    const native = new AntigravityNativeConnection({
      createElicitation: request => this.#handleElicitation(request),
      launch,
      requestPermission: request => this.#handlePermission({
        ...request, toolCall: mapAntigravityToolCallPaths(request.toolCall, store?.pathMapper),
      }),
      version: this.host.clientVersion ?? '0.0.0',
    });
    const owner: NativeOwner = {
      commandsBySession: new Map(),
      configOptions: [],
      initialized: false,
      loaded: null,
      creationAgentName,
      skipPermissions,
      native,
      store,
      unsubscribe: () => {},
    };
    this.nativeSlot.install(owner);
    try {
      const unsubscribeNotifications = native.onNotification(notification => {
        if (this.#isCurrentOwner(owner)) this.#handleNotification(owner, notification);
      });
      // agy can exit between runs, ending its own reply and subagents with it.
      const unsubscribeClose = native.onClose(() => {
        if (!this.#isCurrentOwner(owner)) return;
        this.subagents?.processEnded();
        this.#closeBackground('interrupted');
      });
      owner.unsubscribe = () => {
        unsubscribeNotifications();
        unsubscribeClose();
      };
      await native.initialize();
      if (this.disposed || !this.#isCurrentOwner(owner)) throw new AntigravityExecutionCancellationError();
      owner.initialized = true;
      return owner;
    } catch (error) {
      await this.nativeSlot.detach(owner).catch(() => undefined);
      throw error;
    }
  }

  async #ensureSession(active: ActiveExecution): Promise<NativeOwner> {
    const instructions = active.request.configuration.systemInstructions;
    const prompt = active.request.toolPolicy.kind === 'passive'
      ? `${instructions.instructions}\n\n${PASSIVE_TOOL_INSTRUCTION}` : instructions.instructions;
    // Main chat runs on agy's default agent; its prompt is a resume-only append, which agy does not store and each
    // resume replaces, so every resume delivers the current text. Auxiliary sessions keep tool-restricted custom agents.
    const systemPromptAppend = instructions.kind === 'main-agent' ? prompt : undefined;
    // YOLO main chat lets agy approve everything itself: Claudian never receives a subagent's approval request, so
    // client-side approval alone would leave subagents stalled. Auxiliary sessions rely on Claudian's denials.
    const { permissionMode } = active.request.configuration;
    const policy = active.request.toolPolicy.kind;
    const skipPermissions = instructions.kind === 'main-agent' && shouldAutoApproveAntigravityPermission(permissionMode)
      && policy === 'provider-default';
    let owner: NativeOwner;
    if (this.providerSessionId) {
      // The saved session owns its agent. Restoration must not require or inspect any agent file.
      owner = await this.#ensureNative(active, { skipPermissions });
      const loaded = owner.loaded;
      if (loaded?.sessionId === this.providerSessionId && loaded.systemPromptAppend === systemPromptAppend) return owner;
    } else if (instructions.kind === 'main-agent') {
      owner = await this.#ensureNative(active, { creation: { agentName: undefined }, skipPermissions });
    } else {
      const name = `claudian-${instructions.purpose}`;
      const tools = instructions.purpose === 'inline-edit' ? ANTIGRAVITY_INLINE_EDIT_TOOLS : [];
      await prepareAntigravityAgentFile(this.config.workingDirectory, name, prompt, tools);
      this.#throwIfCancellationRequested(active);
      owner = await this.#ensureNative(active, { creation: { agentName: name }, skipPermissions });
    }
    const mcpServers = await this.#getMCPServers();
    this.#throwIfCancellationRequested(active);
    const request = { cwd: owner.native.launch.targetCwd, mcpServers };
    const created = this.providerSessionId ? undefined : await owner.native.newSession(request);
    if (created) {
      // Publish the recoverable locator before MCP readiness, including when cancellation won the race.
      this.#captureSessionId(created.sessionId);
      this.#setNativeConversationContextEstablished(false);
      this.#emitCurrentSnapshot();
      this.#throwIfCancellationRequested(active);
    }
    // Creation already loads an auxiliary agent's body and tools. Only a main append or custom MCP setup needs a resume.
    let response: ACPResumeSessionResponse | undefined = created;
    if (!response || systemPromptAppend !== undefined || mcpServers.length > 0) {
      try {
        response = await owner.native.resumeSession({
          ...request,
          sessionId: this.providerSessionId!,
          ...(systemPromptAppend === undefined ? {} : { _meta: { antigravity: { systemPrompt: { append: systemPromptAppend } } } }),
        });
      } catch (error) {
        if (created) throw new AntigravitySessionPreparationError(error);
        throw error;
      }
    }
    this.#throwIfCancellationRequested(active);
    this.#captureSessionId(response.sessionId ?? this.providerSessionId!);
    owner.loaded = { sessionId: this.providerSessionId!, systemPromptAppend, models: response.models };
    if (systemPromptAppend !== undefined) this.#watchSubagents(owner, this.providerSessionId!);
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
    const reasoning = configuration.reasoning?.trim();
    if (rawModel && rawModel !== readAntigravityConfigValue(owner.configOptions, ANTIGRAVITY_MODEL_CONFIG_ID)) {
      const { models } = readAntigravitySessionModels(owner.configOptions, owner.loaded?.models);
      const selected = models.find(model => model.rawId === rawModel);
      if (models.length > 0 && !selected) {
        throw new Error(`Antigravity model "${rawModel}" is not available in this session.`);
      }
      const variant = reasoning && selected?.reasoningEfforts.some(effort => effort.value === reasoning);
      await this.#setConfigOption(owner, active, sessionId, ANTIGRAVITY_MODEL_CONFIG_ID, variant ? `${rawModel}-${reasoning}` : rawModel);
    }
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
      // Capture ownership before dispatch: a pending call must never adopt a later turn. A call agy makes in its own
      // reply belongs to the background turn, under the configuration agy last ran with.
      const background = this.#backgroundTurn();
      const active = this.active;
      const owner = background
        ? { signal: background.signal, toolPolicy: this.latestPolicy?.toolPolicy }
        : active ? { signal: active.abortController.signal, toolPolicy: active.request.toolPolicy } : null;
      const result = invokeSessionTool(call.name, call.args, {
        port: this.config.sessionTools,
        signal: owner ? AbortSignal.any([owner.signal, call.signal]) : AbortSignal.abort(),
        toolPolicy: owner?.toolPolicy,
      });
      return background ? background.holdForRequest(result) : result;
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
    const launch = this.nativeSlot.current?.native.launch;
    if (launch?.target.method === 'wsl') {
      // Linux cannot reach the host loopback under WSL's default NAT; Windows interop relays MCP over stdio instead.
      const relay = await createWSLSessionToolRelay({
        env: launch.env, hostCwd: launch.spawnCwd, mode: 'mcp', route, target: launch.target,
      });
      return [{
        args: relay.args,
        command: relay.command,
        env: Object.entries(relay.env).map(([name, value]) => ({ name, value })),
        name: SESSION_TOOL_MCP_SERVER_NAME,
      }];
    }
    return [{
      headers: [{ name: SESSION_TOOL_ROUTE_HEADER, value: route.routeId }],
      name: SESSION_TOOL_MCP_SERVER_NAME,
      type: 'http',
      url: route.url,
    }];
  }

  #handlePermission(request: ACPRequestPermissionRequest): Promise<ACPRequestPermissionResponse> {
    if (request.sessionId !== this.providerSessionId) return Promise.resolve(CANCELLED_ACP_PERMISSION_RESPONSE);
    const background = this.#backgroundFor(request.sessionId);
    if (background) {
      // Fail closed: approvals between runs follow the configuration agy last ran under.
      if (!this.latestPolicy) return Promise.resolve(CANCELLED_ACP_PERMISSION_RESPONSE);
      return background.holdForRequest(this.#decidePermission(request, this.latestPolicy, background.signal)).then(response => {
        if (!grantsPermission(request, response)) background.toolDenied(request.toolCall.toolCallId);
        return response;
      });
    }
    const active = this.active;
    if (!active || this.#isCancellationRequested(active)) return Promise.resolve(CANCELLED_ACP_PERMISSION_RESPONSE);
    return this.#decidePermission(request, approvalPolicyOf(active.request), active.abortController.signal);
  }

  #decidePermission(
    request: ACPRequestPermissionRequest,
    { permissionMode, toolPolicy }: ApprovalPolicy,
    signal: AbortSignal,
  ): Promise<ACPRequestPermissionResponse> {
    const toolName = normalizeAntigravityToolName(readNativeToolName(request) ?? request.toolCall.title ?? '', request.toolCall.rawInput);
    const policy = toolPolicy.kind;
    if (policy === 'passive') return Promise.resolve(CANCELLED_ACP_PERMISSION_RESPONSE);
    if (policy === 'read-only') {
      return Promise.resolve(readNativeToolName(request) === 'run_command'
        ? allowACPPermission(request.options) : CANCELLED_ACP_PERMISSION_RESPONSE);
    }
    if (isSessionTool(toolName)) {
      return Promise.resolve(this.config.sessionTools ? allowACPPermission(request.options) : CANCELLED_ACP_PERMISSION_RESPONSE);
    }
    if (shouldAutoApproveAntigravityPermission(permissionMode)) {
      return Promise.resolve(allowACPPermission(request.options));
    }
    return this.interactionController.requestPermission(request, signal);
  }

  #handleElicitation(request: ACPCreateElicitationRequest): Promise<ACPCreateElicitationResponse> {
    const background = this.#backgroundFor(request.sessionId);
    if (background) return background.holdForRequest(this.questionRouter.handle(request, background.signal));
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
    if (notification.sessionId !== this.providerSessionId) return;
    const reported = notification.update;
    const update = (reported.sessionUpdate === 'tool_call' || reported.sessionUpdate === 'tool_call_update'
      ? mapAntigravityToolCallPaths(reported, owner.store?.pathMapper)
      : reported) as ACPSessionNotification['update'] & { name?: unknown };
    switch (update.sessionUpdate) {
      // Claudian emits its own user boundaries and owns conversation titles.
      case 'user_message_chunk':
      case 'session_info_update':
        return;
      default:
        break;
    }
    // After a Stop, agy reports the calls the cancel ended; they belong to the interrupted turn.
    const opens = ANTIGRAVITY_REPLY_OUTPUT_KINDS.has(update.sessionUpdate)
      && !(this.lateWork.phase === 'stopped' && update.sessionUpdate === 'tool_call_update');
    const background = this.#backgroundFor(notification.sessionId, opens);
    let metadata: ACPNormalizedUpdate | undefined;
    if (background) {
      metadata = background.handleUpdate(update);
    } else {
      const active = this.active;
      if (!active || this.#isCancellationRequested(active)) return;
      metadata = active.turn.handleUpdate(presentAntigravityUpdate(active.toolCallIds, update));
    }
    if (update.sessionUpdate === 'tool_call' && update.name === 'invoke_subagent') this.subagents?.subagentLaunched();
    if (metadata?.type === 'config_options') this.#adoptConfigOptions(owner, metadata.configOptions);
  }

  #applySteer(active: ActiveExecution, steer: PendingSteer): void {
    if (steer.applied) return;
    steer.applied = true;
    active.run.emit({ content: steer.text, type: 'user_message_started' });
  }

  /**
   * The open background turn, or, when `open` is set, a new one for main-agent work agy starts while no run is active.
   * Auxiliary sessions never have one: their policies depend on Claudian denying what agy asks outside a run.
   */
  #backgroundFor(sessionId: string, open = true): AntigravityBackgroundTurn | null {
    const current = this.#backgroundTurn();
    if (current || !open || this.active || this.disposed || sessionId !== this.providerSessionId) return current;
    if (this.nativeSlot.current?.loaded?.systemPromptAppend === undefined) return null;
    const background = new AntigravityBackgroundTurn({
      notify: event => this.state.notify(event),
      onSettled: () => this.#closeBackground('completed'),
      providerSessionId: this.providerSessionId,
      sessionInstanceId: this.sessionInstanceId,
      takeAnswers: toolCallId => this.questionRouter.takeAnswers(toolCallId),
    });
    this.lateWork = { phase: 'replying', turn: background };
    this.subagents?.turnStarted();
    this.#updateSnapshot('executing');
    this.#emitCurrentSnapshot();
    return background;
  }

  #closeBackground(reason: 'completed' | 'interrupted', next: 'idle' | 'stopped' = 'idle'): void {
    const background = this.#backgroundTurn();
    if (!background) return;
    this.lateWork = { phase: next };
    background.close(reason);
    // A run holding its prompt for this reply starts watching when it ends.
    if (this.active || this.disposed) return;
    // agy's reply may have launched subagents; an interruption (Stop, exit) ended them with it.
    if (reason === 'completed') this.subagents?.turnEnded(true);
    this.#updateSnapshot('idle');
    this.#emitCurrentSnapshot();
  }

  #backgroundTurn(): AntigravityBackgroundTurn | null {
    return this.lateWork.phase === 'replying' ? this.lateWork.turn : null;
  }

  #interactionTurnId(): string | null {
    return this.#backgroundTurn()?.turnId ?? this.active?.run.turnId ?? null;
  }

  #finishCompleted(active: ActiveExecution, response: ACPPromptResponse, compacted: boolean): void {
    // A successful response proves acceptance even when agy streamed no output for it.
    active.turn.accept();
    if (response.usage) {
      const model = active.request.configuration.model
        ? decodeAntigravityModelId(active.request.configuration.model) ?? undefined
        : undefined;
      // The response sums every model call in the turn; agy's latest usage_update measures the context. A
      // compaction's report measures the summarizing call over the old context, so it stays unmeasured until the
      // next call. An unmeasured context or window reports none, which hides the meter.
      const contextUsage = active.turn.contextUsage;
      const usage = buildACPUsageInfo({
        contextWindow: { size: contextUsage?.size ?? 0, used: compacted ? 0 : contextUsage?.used ?? 0 },
        model,
        promptUsage: response.usage,
      });
      if (usage) active.run.emit({ type: 'usage_updated', usage });
    }
    this.#updateSnapshot('idle');
    this.#emitCurrentSnapshot();
    active.abortController.abort();
    this.#endRun(active, {
      providerPayload: response,
      reason: response.stopReason === 'max_tokens' ? 'max-tokens' : response.stopReason === 'end_turn' ? 'completed' : 'provider-ended',
      type: 'turn_completed',
    });
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
    this.#endRun(active, {
      category,
      message,
      recoverable: true,
      type: 'execution_error',
    });
  }

  async #cancelRun(run: RequestedRunChannel, reason: string): Promise<void> {
    const active = this.active;
    if (!active || active.run !== run || run.isTerminal) return;
    if (this.cancellationFlight) return this.cancellationFlight;
    this.#updateSnapshot('cancelling');
    this.#emitCurrentSnapshot();
    active.abortController.abort();
    // agy's cancel also stops what it was doing between prompts.
    this.#closeBackground('interrupted');
    this.interactionController.dismissAll('cancelled');
    this.questionRouter.dismissAll('cancelled');
    const owner = this.nativeSlot.current;
    const sessionId = this.providerSessionId;
    this.cancellationFlight = (async () => {
      try {
        const latest = active.prompts.get(active.latestPrompt)?.response;
        if (owner && sessionId && latest) {
          // agy reports the calls its cancel ended after the prompt settles; they belong to this turn.
          this.lateWork = { phase: 'stopped' };
          owner.native.cancel(sessionId);
          // agy settles a cancelled prompt at once; a process that does not is replaced.
          const settled = await settleWithin(latest, CANCEL_SETTLE_TIMEOUT_MS);
          if (!settled) await this.nativeSlot.shutdown();
          // An answered prompt reached agy, even one cancelled before any output (agy echoes no prompt).
          else if (await latest.then(() => true, () => false)) active.turn.accept();
        } else if (active.nativeTouched) {
          // Startup, resume or configuration was interrupted; its native outcome is unknown.
          await this.nativeSlot.shutdown();
        }
      } catch {
        // Teardown failure cannot replace the already-requested cancellation terminal.
      } finally {
        if (!this.disposed) {
          this.#updateSnapshot('idle');
          this.#emitCurrentSnapshot();
        }
        this.#endRun(active, { reason, type: 'cancelled' });
      }
    })().finally(() => { this.cancellationFlight = null; });
    return this.cancellationFlight;
  }

  /** The one way a run ends: its terminal event, its turn's disposal, and release of the session slot. */
  #endRun(active: ActiveExecution, terminal: Parameters<RequestedRunChannel['finish']>[0]): void {
    active.run.finish(terminal);
    active.turn.dispose();
    if (this.active === active) this.active = null;
    if (!this.disposed && this.subagents?.sessionId === this.providerSessionId) {
      this.subagents?.turnEnded(active.latestPrompt > 0);
    }
  }

  #watchSubagents(owner: NativeOwner, sessionId: string): void {
    if (this.subagents?.sessionId === sessionId) return;
    void this.subagents?.dispose();
    const store = owner.store;
    // Change notifications over a WSL distro's share are not reliable for writes made inside Linux; poll instead.
    this.subagents = store
      ? new AntigravitySubagentWatcher({ poll: store.pathMapper !== undefined, sessionId, storeRoot: store.root })
      : null;
    // The run that loaded the session is under way; its end starts watching.
    this.subagents?.turnStarted();
  }

  #isCancellationRequested(active: ActiveExecution): boolean {
    return this.disposed || active.run.isCancellationRequested || this.active !== active || active.run.isTerminal;
  }

  #throwIfCancellationRequested(active: ActiveExecution): void {
    if (this.#isCancellationRequested(active)) throw new AntigravityExecutionCancellationError();
  }

  #isCurrentOwner(owner: NativeOwner): boolean {
    return !this.disposed && this.nativeSlot.isCurrent(owner);
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

function whenAborted(signal: AbortSignal): Promise<void> {
  return signal.aborted ? Promise.resolve() : new Promise(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); });
}

function approvalPolicyOf(request: ProviderExecutionRequest): ApprovalPolicy {
  return { permissionMode: request.configuration.permissionMode, toolPolicy: request.toolPolicy };
}

function grantsPermission(request: ACPRequestPermissionRequest, response: ACPRequestPermissionResponse): boolean {
  const { outcome } = response;
  return outcome.outcome === 'selected'
    && request.options.some(option => option.optionId === outcome.optionId && option.kind.startsWith('allow'));
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
