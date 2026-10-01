import type { CursorContext } from '../../utils/editor';
import type { SharedAppStorage } from '../bootstrap/storage';
import type {
  ProviderExecutionBackend,
  ProviderExecutionTransitionScope,
} from '../execution';
import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type {
  AskUserAnswers,
  AuxiliaryContinuityReset,
  Conversation,
  SessionMetadata,
  SlashCommand,
  SubagentInfo,
  SubagentProgress,
  ToolCallInfo,
} from '../types';
import type { ProviderId } from '../types/provider';
import type { ProviderCommandCatalog } from './commands/ProviderCommandCatalog';
import type { ProviderCommandDiscoveryResult } from './commands/ProviderCommandDiscoveryResult';
import type { ProviderModelCatalog } from './models/ProviderModelCatalog';
import type { ProviderHost } from './ProviderHost';

export type { ProviderId } from '../types/provider';

export interface ProviderCapabilities {
  providerId: ProviderId;
  supportsNativeHistory: boolean;
  /** Can execute without saving native conversation history, including clarification turns. */
  supportsEphemeralSessions: boolean;
  supportsRewind: boolean;
  supportsFork: boolean;
  supportsConversationBranches?: boolean;
  /** Whether forked children can be non-persistent; defaults to supportsEphemeralSessions. */
  supportsEphemeralFork?: boolean;
  /** Omitted means checkpoint forking; full-session providers can fork only the latest reply. */
  forkMode?: 'checkpoint' | 'full-session';
  supportsProviderCommands: boolean;
  supportsImageAttachments: boolean;
  supportsTurnSteer?: boolean;
  supportsFastMode?: boolean;
  /** Can report authoritative main-agent output tokens and elapsed turn time. */
  supportsResponseThroughput?: boolean;
  reasoningControl: 'effort' | 'none';
}

export const DEFAULT_CHAT_PROVIDER_ID = 'claude' as const satisfies ProviderId;

/**
 * Chat-facing provider registration.
 *
 * This is intentionally limited to chat-facing services.
 * Shared bootstrap (defaults, storage) is in `src/core/bootstrap/`.
 * Provider-owned workspace services (CLI resolution, commands, agents,
 * settings tabs) live behind `src/providers/<id>/app/`.
 */
/** Native reply content is provider-owned; chat routes it as ordinary user input. */
export interface ProviderQuestionReply {
  content: string;
  /** Empty when the reply is presented only in its question renderer. */
  displayContent: string;
}

export interface ProviderRegistration {
  displayName: string;
  blankTabOrder: number;
  isEnabled: (settings: Record<string, unknown>) => boolean;
  setEnabled?: (settings: Record<string, unknown>, enabled: boolean) => void;
  capabilities: ProviderCapabilities;
  getConversationCapabilities?: (providerState?: Record<string, unknown>) => ProviderCapabilities;
  environmentKeyPatterns?: RegExp[];
  modelPolicy: ProviderModelPolicy;
  chatUIConfig: ProviderChatUIConfig;
  settingsReconciler: ProviderSettingsReconciler;
  createExecutionBackend: (plugin: ProviderHost) => ProviderExecutionBackend;
  createSubagentHistoryService?: (plugin: ProviderHost) => ProviderSubagentHistoryService;
  historyService: ProviderConversationHistoryService;
  taskResultInterpreter: ProviderTaskResultInterpreter;
  subagentAdapter?: ProviderSubagentAdapter;
  formatQuestionReply?: (tool: ToolCallInfo, answers: AskUserAnswers) => ProviderQuestionReply | null;
}

export interface ProviderModule extends ProviderRegistration {
  id: ProviderId;
  settingsStorage: ProviderSettingsStorageAdapter;
  workspace: ProviderWorkspaceRegistration;
}

export interface ProviderSettingsStorageAdapter {
  /** Whether selected models need native effort metadata discovery during startup. */
  needsReasoningMetadata?(settings: Record<string, unknown>): boolean;
  hostScopedFields?: string[];
  runtimeOnlyFields?: string[];
  /** Provider-owned durable projection; full discovery catalogs remain runtime-only. */
  projectPersistedConfig?(settings: Record<string, unknown>): Record<string, unknown>;
  normalizeStored(
    target: Record<string, unknown>,
    stored: Record<string, unknown>,
  ): boolean;
}

export type ProviderEnvironmentSessionPolicy = 'invalidate' | 'reload';

export interface ProviderSettingsReconciler {
  /** Defaults to `invalidate` for backward compatibility. */
  environmentSessionPolicy?: ProviderEnvironmentSessionPolicy;

  handleEnvironmentChange?(settings: Record<string, unknown>): boolean;

  invalidateConversationSessions(conversations: Conversation[]): Conversation[];

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] };

  normalizeModelVariantSettings?(settings: Record<string, unknown>): boolean;
}

// ---------------------------------------------------------------------------
// App-level service interfaces
// ---------------------------------------------------------------------------

/** Tab manager state persisted across restarts. */
export interface AppTabManagerState {
  openTabs: Array<{ tabId: string; conversationId: string | null; draftModel?: string; providerId?: ProviderId | null }>;
  activeTabId: string | null;
  expandedTitleTabIds?: string[];
}

/** Provider-neutral session metadata storage. */
export interface SessionMetadataListOptions {
  /** Receives successful reads incrementally. Batches may follow completion order. */
  onBatch?: (metadata: SessionMetadata[]) => void;
  batchSize?: number;
}

export interface SessionMetadataScanResult {
  metadata: SessionMetadata[];
  /** False when any metadata directory or listed metadata file could not be read. */
  complete: boolean;
  /** Files that were read successfully but did not contain valid session metadata. */
  invalidMetadataCount: number;
}

// ---------------------------------------------------------------------------
// Provider-owned workspace sub-interfaces
//
// These remain here as standalone types so app-level settings/chat code can
// depend on stable provider workspace contracts without importing concrete
// provider implementations. They are NOT part of the shared bootstrap storage
// contract (`SharedAppStorage`).
// ---------------------------------------------------------------------------

export interface AppCommandStorage {
  save(command: SlashCommand): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface AppSkillStorage {
  save(skill: SlashCommand): Promise<void>;
  delete(name: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Provider-owned chat UI configuration
// ---------------------------------------------------------------------------

/** Option for model, reasoning, or other UI selectors. */
export interface ProviderUIOption {
  value: string;
  label: string;
  description?: string;
  /** Optional group label for visual separators in dropdowns. */
  group?: string;
  /** Per-option icon override (e.g. when mixing providers in a single dropdown). */
  providerIcon?: ProviderIconSvg;
  /** Owning provider when several providers share one dropdown, so the option can carry its brand. */
  providerId?: ProviderId;
}

export interface ProviderPathIconSvg {
  kind?: 'path';
  viewBox: string;
  path: string;
}

export interface ProviderSvgPathChild {
  tag: 'path';
  attributes: Record<string, string>;
}

export interface ProviderSvgGroupChild {
  tag: 'g';
  attributes: Record<string, string>;
  children: ProviderSvgPathChild[];
}

export type ProviderSvgChild = ProviderSvgGroupChild | ProviderSvgPathChild;

export interface ProviderCompositeIconSvg {
  kind: 'composite';
  viewBox: string;
  children: ProviderSvgChild[];
}

/** SVG icon descriptor for provider branding in selectors and headers. */
export type ProviderIconSvg = ProviderPathIconSvg | ProviderCompositeIconSvg;

/** Permission-mode values a provider accepts in the shared `permissionMode` setting. */
export interface ProviderPermissionModePolicy {
  readonly values: readonly string[];
  /** Fail-closed value for unknown stored values. */
  readonly fallbackValue: string;
  /** Initial choice when no permission has been selected for this provider. */
  readonly defaultValue?: string;
  /** Maps a retired stored value to a current one; unmapped values use the fallback. */
  migrateValue?(value: string, settings: Record<string, unknown>): string | undefined;
}

/** One toolbar permission-mode choice, in menu order. */
export interface ProviderPermissionModeOption extends ProviderUIOption {
  /** Skips approval prompts; the toolbar marks it as a warning while selected. */
  bypassesApprovals?: boolean;
}

/** Provider-reported service-tier choices, labels and resolved selection. */
export interface ProviderServiceTierPolicy {
  inactiveValue: string;
  inactiveLabel: string;
  activeValue: string;
  activeLabel: string;
  /** Whether the provider will use the active tier for the next request. */
  isActive: boolean;
  description?: string;
}

export type ProviderServiceTierToggleConfig = ProviderServiceTierPolicy;

export interface ProviderModeSelectorConfig {
  activeValue?: string;
  label: string;
  options: ProviderUIOption[];
  value: string;
}

/** Provider model and execution preferences, independent of chat rendering. */
export interface ProviderModelPolicy {
  readonly permissionModes?: ProviderPermissionModePolicy;
  /** Available models in durable selection order, independent of dropdown layout. */
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[];

  /** Semantic default model, independent from selector display order. */
  getDefaultModel?(settings: Record<string, unknown>): string | null;

  /** Whether this provider owns the given model id. */
  ownsModel(model: string, settings: Record<string, unknown>): boolean;

  /** Whether the model takes an effort level; otherwise the saved effort is kept unvalidated. */
  supportsReasoningEffort(model: string, settings: Record<string, unknown>): boolean;

  /** Effort levels for the current model. */
  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderUIOption[];

  /** Default reasoning value for the model. */
  getDefaultReasoningValue(model: string, settings: Record<string, unknown>): string;

  /** Whether this is a built-in (default) model vs custom/env model. */
  isDefaultModel(model: string): boolean;

  /** Apply model change side effects to settings (defaults, tracking). */
  applyModelDefaults(model: string, settings: unknown): void;

  /** Apply model-scoped defaults to an ephemeral conversation settings projection. */
  applyModelProjectionDefaults?(model: string, settings: unknown): void;

  /** Optional provider hook to discover model-scoped metadata after a model is selected. */
  prepareModelMetadata?(
    model: string,
    settings: Record<string, unknown>,
    context: { plugin: ProviderHost },
  ): Promise<void>;

  /** Optional hook when the toolbar changes a reasoning selection. */
  applyReasoningSelection?(model: string, value: string, settings: unknown): void;

  /** Normalize model variant based on visibility flags. Provider extracts what it needs from the settings bag. */
  normalizeModelVariant(model: string, settings: Record<string, unknown>): string;

  /** Canonicalize an alias to a current option without applying provider fallback policy. */
  normalizeAvailableModelSelection?(
    model: string,
    settings: Record<string, unknown>,
  ): string;

  /** Extract custom model IDs from parsed environment variables. Used for per-model context limit UI. */
  getCustomModelIds(envVars: Record<string, string>): Set<string>;

  /** Provider-owned aliases for custom models configured through environment snippets. */
  customModelAliases?: {
    get(settings: Record<string, unknown>): Record<string, string>;
    update(settings: Record<string, unknown>, aliases: Record<string, string>): void;
  };

  /** Optional provider-owned mapping back into the shared permission-mode contract. */
  resolvePermissionMode?(settings: Record<string, unknown>): string | null;

  /** Optional hook when the toolbar changes permission mode. */
  applyPermissionMode?(value: string, settings: unknown): void;

  /** Available service-tier choices and the currently resolved tier. */
  getServiceTierPolicy?(settings: Record<string, unknown>): ProviderServiceTierPolicy | null;

  /** Optional hook when the toolbar changes a provider-owned mode selection. */
  applyModeSelection?(value: string, settings: unknown): void;

}

/** UI composition may reuse policy, but application code consumes ProviderModelPolicy. */
export interface ProviderChatUIConfig extends Omit<ProviderModelPolicy, 'permissionModes' | 'getServiceTierPolicy'> {
  getPermissionModeOptions?(settings?: Record<string, unknown>): readonly ProviderPermissionModeOption[] | null;
  getServiceTierToggle?(settings: Record<string, unknown>): ProviderServiceTierToggleConfig | null;
  getModeSelector?(settings: Record<string, unknown>): ProviderModeSelectorConfig | null;
  getProviderIcon?(): ProviderIconSvg | null;
}

// ---------------------------------------------------------------------------
// Provider-owned boundary services
// ---------------------------------------------------------------------------

export interface ProviderTransitionOwnerContext {
  providerTransitionOwner?: boolean;
}

export interface ProviderCLIResolutionContext extends ProviderTransitionOwnerContext {
  executionTarget?: unknown;
}

export interface ProviderCLIResolver {
  resolveFromSettings(
    settings: Record<string, unknown>,
    context?: ProviderCLIResolutionContext,
  ): string | null | Promise<string | null>;
  reset(): void;
}

export interface ProviderCommandLoaderContext {
  allowIsolatedMetadataCreation: boolean;
  conversation: Conversation | null;
  plugin: ProviderHost;
  readyCommandSnapshot?: readonly SlashCommand[];
  /** Cancels provider-owned discovery work when its consumer is invalidated. */
  signal?: AbortSignal;
}

export interface ProviderCommandLoader {
  /**
   * Returns a provider-owned, non-secret identity for inputs that affect command discovery.
   * Raw settings, environment values, session state, and external paths must not be included.
   */
  getCacheFingerprint(settings: Record<string, unknown>): string;
  isAvailable(settings: Record<string, unknown>): boolean;
  loadCommands(
    context: ProviderCommandLoaderContext,
  ): Promise<ProviderCommandDiscoveryResult<SlashCommand>>;
}

export interface ProviderWorkspaceServices {
  onAgentSkillsChanged?(): Promise<void> | void;
  commandCatalog?: ProviderCommandCatalog | null;
  cliResolver?: ProviderCLIResolver | null;
  commandLoader?: ProviderCommandLoader | null;
  settingsTabRenderer?: ProviderSettingsTabRenderer | null;
  modelCatalog?: ProviderModelCatalog;
  sessionArchive?: ProviderSessionArchive | null;
  dispose?(): Promise<void> | void;
}

export interface ProviderSessionArchiveChange {
  conversation: ProviderHistoryInput;
  isArchived: boolean;
}

/** Explicit native archive operation; application archive state stays authoritative. */
export interface ProviderSessionArchive {
  /**
   * Applies every change in order. Sessions that are missing or already in the requested
   * state are unchanged; other failures reject after the remaining changes were attempted.
   */
  setSessionsArchived(changes: readonly ProviderSessionArchiveChange[]): Promise<void>;
}

export interface ProviderModelCatalogRefreshResult {
  /** Whether runtime catalog or persisted selection state changed. */
  changed: boolean;
  diagnostics?: string;
  /** Whether the provider-owned refresh persisted selection settings. */
  persistedSettingsChanged?: boolean;
}

export interface ProviderSettingsTabRendererContext {
  plugin: ProviderHost;
  /** Publish provider model-option changes to every settings and chat consumer. */
  notifyProviderModelOptionsChanged(providerId: ProviderId): void;
  renderCustomContextLimits(container: HTMLElement, providerId: ProviderId): void;
}

export interface ProviderSettingsTabRenderHandle {
  refresh(): void;
  dispose(): void;
}

export interface ProviderSettingsTabRenderer {
  render(container: HTMLElement, context: ProviderSettingsTabRendererContext): ProviderSettingsTabRenderHandle | void;
}

export interface ProviderWorkspaceInitContext {
  plugin: ProviderHost;
  storage: SharedAppStorage;
  vaultAdapter: VaultFileAdapter;
  transitionScope: ProviderExecutionTransitionScope;
}

export interface ProviderWorkspaceRegistration<
  TServices extends ProviderWorkspaceServices = ProviderWorkspaceServices,
> {
  /** Shared skill changes invalidate resources even before lazy initialization. */
  consumesAgentSkills?: boolean;
  /** Initialized services provide `sessionArchive`; lets callers skip initializing other providers. */
  providesSessionArchive?: boolean;
  initialize(context: ProviderWorkspaceInitContext): Promise<TServices>;
}

/** Only repository-owned history fields may be proposed by native readers. */
export type ProviderHistoryState = Pick<
  Conversation, 'sessionId' | 'providerState' | 'resumeAtMessageId' | 'messages'
>;

/** Native history inspection never receives application identity or mutable repository state. */
export type ProviderHistoryInput = Readonly<ProviderHistoryState> & {
  readonly createdAt?: number;
  readonly lastActivityAt?: number;
};

export type ProviderHistoryUpdate = Partial<ProviderHistoryState>;

export interface ProviderHistoryResult<T> {
  readonly outcome: T;
  readonly changes?: ProviderHistoryUpdate;
}

/** Readers return explicit proposals; only the repository validates and publishes them. */
export interface ProviderConversationHistoryService {
  /** Whether this conversation still references native history worth model recovery. */
  hasConversationModelRecoverySource?(conversation: ProviderHistoryInput): boolean;
  /**
   * Recovers a stable provider-owned model selection from native history.
   * Implementations must not require the model to remain in the current catalog.
   */
  recoverConversationModelSelection?(
    conversation: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<string | null>;
  /** Recovers a missing provider-native session reference before history hydration. */
  recoverConversationSessionReference?(
    conversation: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderHistoryUpdate | null>;
  /**
   * Reports whether the provider-native session needed to resume a persisted
   * conversation is still available. Providers that cannot distinguish a
   * missing session from an inaccessible history store should return unknown.
   */
  getConversationSessionAvailability?(
    conversation: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderConversationSessionAvailability>;
  /** Clears stale resume state so relocated provider history can rebuild natively. */
  prepareRelocatedConversationSession?(
    conversation: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderHistoryUpdate | null>;
  /** Decides whether a confirmed missing resume session makes the whole record disposable. */
  resolveMissingConversationSession?(
    conversation: ProviderHistoryInput,
    vaultPath: string | null,
    missingProviderSessionId?: string,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderHistoryResult<'delete' | 'reset' | 'preserve'>>;
  hydrateConversationHistory(
    conversation: ProviderHistoryInput,
    vaultPath: string | null,
    pathContext?: ProviderHistoryPathContext,
  ): Promise<ProviderHistoryUpdate>;
  resolveSessionIdForConversation(conversation: ProviderHistoryInput | null): string | null;
  isPendingForkConversation(conversation: ProviderHistoryInput): boolean;
  /** Builds opaque fork state; ephemeral creation may be deferred to its execution owner. */
  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
    vaultPath?: string | null,
    pathContext?: ProviderHistoryPathContext,
    options?: { lifecycle: 'persistent' | 'ephemeral' },
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
  /** Projects provider state for storage without changing live state or native history. */
  buildPersistedProviderState?(
    conversation: ProviderHistoryInput,
    /** Preserve existing history state instead of rebuilding it from unloaded messages. */
    options?: { preserveProviderState?: boolean },
  ): Record<string, unknown> | undefined;
}

export interface ProviderSubagentHistoryRequest {
  providerSessionId: string;
  subagentId: string;
  vaultPath: string;
}

/** Provider-owned transcript recovery kept separate from live execution. */
export interface ProviderSubagentHistoryService {
  loadToolCalls(request: ProviderSubagentHistoryRequest): Promise<ToolCallInfo[]>;
  loadFinalResult(request: ProviderSubagentHistoryRequest): Promise<string | null>;
}

export interface ProviderHistoryPathContext {
  environment: NodeJS.ProcessEnv;
  hostPlatform?: NodeJS.Platform;
  settings?: Record<string, unknown>;
  vaultPath?: string | null;
}

export type ProviderConversationSessionAvailability =
  | 'available'
  | 'relocated'
  | 'missing'
  | 'unknown';

export type ProviderTaskTerminalStatus = Extract<ToolCallInfo['status'], 'completed' | 'error'>;

export interface ProviderTaskDescription {
  mode: 'sync' | 'async' | null;
  description?: string;
  prompt?: string;
}

export interface ProviderTaskLaunch {
  mode: 'sync' | 'async';
  agentId: string | null;
  result: string;
}

export interface ProviderTaskResult {
  status: 'running' | ProviderTaskTerminalStatus;
  result: string;
}

export interface ProviderTaskResultContext {
  mode: 'sync' | 'async';
  agentId?: string;
}

/** Native task formats and output recovery stay behind this provider boundary. */
export interface ProviderTaskResultInterpreter {
  describeTask(input: Readonly<Record<string, unknown>>): ProviderTaskDescription;
  interpretLaunch(result: unknown, isError: boolean, toolUseResult?: unknown): ProviderTaskLaunch;
  /** Correlate native input/output without recovering result files. */
  getOutputTaskId(input: Readonly<Record<string, unknown>> | undefined, result?: unknown): string | null;
  interpretResult(result: unknown, isError: boolean, context: ProviderTaskResultContext, toolUseResult?: unknown): ProviderTaskResult;
}

export interface ProviderSubagentLaunchResult {
  agentId?: string;
  nickname?: string;
  /** Other native identifiers that refer to this same agent. */
  aliases?: string[];
}

export interface ProviderSubagentWaitStatus {
  completed?: string;
  error?: string;
  failed?: string;
}

export interface ProviderSubagentWaitResult {
  statuses: Record<string, ProviderSubagentWaitStatus>;
  timedOut: boolean;
}

export interface ProviderManagedSubagentAdapter {
  protocol: 'managed-agent';
  isOutputTool(name: string): boolean;
  isSpawnTool(name: string): boolean;
}

export interface ProviderSubagentLifecycleAdapter {
  protocol: 'lifecycle';
  isHiddenTool(name: string): boolean;
  isToolCallFullyOwned(
    toolCall: ToolCallInfo,
    agentIdToSpawnId: ReadonlyMap<string, string>,
  ): boolean;
  isSpawnTool(name: string): boolean;
  isWaitTool(name: string): boolean;
  isCloseTool(name: string): boolean;
  resolveSpawnToolIds(
    waitToolCall: ToolCallInfo,
    agentIdToSpawnId: ReadonlyMap<string, string>,
  ): string[];
  buildSubagentInfo(
    spawnToolCall: ToolCallInfo,
    siblingToolCalls?: ToolCallInfo[],
  ): SubagentInfo;
  /** Display-only activity from provider lifecycle snapshots; never stored on the task. */
  getProgress?(
    spawnToolCall: ToolCallInfo,
    siblingToolCalls: ToolCallInfo[],
  ): SubagentProgress | undefined;
  extractSpawnResult(
    raw: string | undefined,
    toolCall?: ToolCallInfo,
  ): ProviderSubagentLaunchResult;
  extractWaitResult(
    raw: string | undefined,
    toolCall?: ToolCallInfo,
  ): ProviderSubagentWaitResult;
}

export type ProviderSubagentAdapter =
  | ProviderManagedSubagentAdapter
  | ProviderSubagentLifecycleAdapter;

// ---------------------------------------------------------------------------
// Auxiliary service contracts
// ---------------------------------------------------------------------------

// -- Title generation --

export type TitleGenerationResult =
  | { success: true; title: string }
  | { success: false; error: string };

export type TitleGenerationCallback = (
  conversationId: string,
  result: TitleGenerationResult
) => Promise<void>;

export interface TitleGenerationService {
  generateTitle(
    conversationId: string,
    userMessage: string,
    callback: TitleGenerationCallback
  ): Promise<void>;
  cancel(): void;
}

// -- Inline edit --

export type InlineEditMode = 'selection' | 'cursor';

export interface InlineEditSelectionRequest {
  mode: 'selection';
  instruction: string;
  notePath: string;
  selectedText: string;
  startLine?: number;
  lineCount?: number;
  contextFiles?: string[];
}

export interface InlineEditCursorRequest {
  mode: 'cursor';
  instruction: string;
  notePath: string;
  cursorContext: CursorContext;
  contextFiles?: string[];
}

export type InlineEditRequest = InlineEditSelectionRequest | InlineEditCursorRequest;

export interface InlineEditOutcome {
  success: boolean;
  resetRequired?: false;
  editedText?: string;
  insertedText?: string;
  clarification?: string;
  error?: string;
}

export type InlineEditResult = InlineEditOutcome | AuxiliaryContinuityReset;

export interface InlineEditService {
  setModelOverride?(model?: string): void;
  resetConversation(): void;
  editText(request: InlineEditRequest): Promise<InlineEditResult>;
  continueConversation(message: string, contextFiles?: string[]): Promise<InlineEditResult>;
  cancel(): void;
}
