import type ClaudianPlugin from '../../main';
import type { CursorContext } from '../../utils/editor';
import type { SharedAppStorage } from '../bootstrap/storage';
import type { McpServerManager } from '../mcp/McpServerManager';
import type { ChatRuntime } from '../runtime/ChatRuntime';
import type { HomeFileAdapter } from '../storage/HomeFileAdapter';
import type { VaultFileAdapter } from '../storage/VaultFileAdapter';
import type {
  AgentDefinition,
  Conversation,
  InstructionRefineResult,
  ManagedMcpServer,
  PluginInfo,
  SessionMetadata,
  SlashCommand,
  SubagentInfo,
  ToolCallInfo,
} from '../types';
import type { ProviderId } from '../types/provider';
import type { ProviderCommandCatalog } from './commands/ProviderCommandCatalog';

export type { ProviderId } from '../types/provider';

export interface ProviderCapabilities {
  providerId: ProviderId;
  supportsPersistentRuntime: boolean;
  supportsNativeHistory: boolean;
  supportsPlanMode: boolean;
  supportsRewind: boolean;
  supportsFork: boolean;
  supportsProviderCommands: boolean;
  supportsImageAttachments: boolean;
  supportsInstructionMode: boolean;
  supportsMcpTools: boolean;
  supportsTurnSteer?: boolean;
  reasoningControl: 'effort' | 'token-budget' | 'none';
  planPathPrefix?: string;
}

export const DEFAULT_CHAT_PROVIDER_ID = 'claude' as const satisfies ProviderId;

export interface CreateChatRuntimeOptions {
  plugin: ClaudianPlugin;
  providerId?: ProviderId;
}

/**
 * Chat-facing provider registration.
 *
 * This is intentionally limited to chat-facing services.
 * Shared bootstrap (defaults, storage) is in `src/core/bootstrap/`.
 * Provider-owned workspace services (CLI resolution, commands, agents,
 * MCP, settings tabs) live behind `src/providers/<id>/app/`.
 */
export interface ProviderRegistration {
  displayName: string;
  blankTabOrder: number;
  isEnabled: (settings: Record<string, unknown>) => boolean;
  capabilities: ProviderCapabilities;
  environmentKeyPatterns?: RegExp[];
  chatUIConfig: ProviderChatUIConfig;
  settingsReconciler: ProviderSettingsReconciler;
  createRuntime: (options: Omit<CreateChatRuntimeOptions, 'providerId'>) => ChatRuntime;
  createTitleGenerationService: (plugin: ClaudianPlugin) => TitleGenerationService;
  createInstructionRefineService: (plugin: ClaudianPlugin) => InstructionRefineService;
  createInlineEditService: (plugin: ClaudianPlugin) => InlineEditService;
  historyService: ProviderConversationHistoryService;
  taskResultInterpreter: ProviderTaskResultInterpreter;
  subagentLifecycleAdapter?: ProviderSubagentLifecycleAdapter;
}

export interface ProviderSettingsReconciler {
  handleEnvironmentChange?(settings: Record<string, unknown>): boolean;

  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] };

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean;
}

// ---------------------------------------------------------------------------
// App-level service interfaces
// ---------------------------------------------------------------------------

/** Tab manager state persisted across restarts. */
export interface AppTabManagerState {
  openTabs: Array<{ tabId: string; conversationId: string | null; draftModel?: string | null }>;
  activeTabId: string | null;
}

/** Provider-neutral session metadata storage. */
export interface AppSessionStorage {
  listMetadata(): Promise<SessionMetadata[]>;
  saveMetadata(meta: SessionMetadata): Promise<void>;
  deleteMetadata(id: string): Promise<void>;
  toSessionMetadata(conv: Conversation): SessionMetadata;
}

// ---------------------------------------------------------------------------
// Provider-owned workspace sub-interfaces
//
// These remain here as standalone types so app-level settings/chat code can
// depend on stable provider workspace contracts without importing concrete
// provider implementations. They are NOT part of the shared bootstrap storage
// contract (`SharedAppStorage`).
// ---------------------------------------------------------------------------

export interface AppMcpStorage {
  load(): Promise<ManagedMcpServer[]>;
  save(servers: ManagedMcpServer[]): Promise<void>;
  tryParseClipboardConfig?(text: string): unknown;
}

export interface AppCommandStorage {
  save(command: SlashCommand): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface AppSkillStorage {
  save(skill: SlashCommand): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface AppAgentStorage {
  load(agent: AgentDefinition): Promise<AgentDefinition | null>;
  save(agent: AgentDefinition): Promise<void>;
  delete(agent: AgentDefinition): Promise<void>;
}

export type AgentMentionSource = AgentDefinition['source'];

export interface AgentMentionProvider {
  searchAgents(query: string): Array<{
    id: string;
    name: string;
    description?: string;
    source: AgentMentionSource;
  }>;
}

/** Provider plugin manager interface consumed by the app layer. */
export interface AppPluginManager {
  loadPlugins(): Promise<void>;
  getPlugins(): PluginInfo[];
  hasPlugins(): boolean;
  hasEnabledPlugins(): boolean;
  getEnabledCount(): number;
  getPluginsKey(): string;
  togglePlugin(pluginId: string): Promise<void>;
  enablePlugin(pluginId: string): Promise<void>;
  disablePlugin(pluginId: string): Promise<void>;
}

/** Provider agent manager interface consumed by the app layer. */
export interface AppAgentManager extends AgentMentionProvider {
  loadAgents(): Promise<void>;
  getAvailableAgents(): AgentDefinition[];
  getAgentById(id: string): AgentDefinition | undefined;
  searchAgents(query: string): AgentDefinition[];
  setBuiltinAgentNames(names: string[]): void;
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

/** Extended option with token count for budget-based reasoning controls. */
export interface ProviderReasoningOption extends ProviderUIOption {
  tokens?: number;
}

/** Compact permission-mode toggle descriptor for providers that expose the current toolbar control. */
export interface ProviderPermissionModeToggleConfig {
  inactiveValue: string;
  inactiveLabel: string;
  activeValue: string;
  activeLabel: string;
  planValue?: string;
  planLabel?: string;
}

/** Compact service-tier toggle descriptor for providers that expose a fast/standard toolbar control. */
export interface ProviderServiceTierToggleConfig {
  inactiveValue: string;
  inactiveLabel: string;
  activeValue: string;
  activeLabel: string;
  description?: string;
}

export interface ProviderModeSelectorConfig {
  activeValue?: string;
  label: string;
  options: ProviderUIOption[];
  value: string;
}

/** Static UI configuration owned by the provider (model list, reasoning, context window). */
export interface ProviderChatUIConfig {
  /** Model options for the selector dropdown. Provider extracts what it needs from the settings bag. */
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[];

  /** Whether this provider owns the given model id. */
  ownsModel(model: string, settings: Record<string, unknown>): boolean;

  /** Whether the model uses adaptive reasoning (effort levels vs token budgets). */
  isAdaptiveReasoningModel(model: string, settings: Record<string, unknown>): boolean;

  /** Reasoning options for the current model (effort levels if adaptive, budgets otherwise). */
  getReasoningOptions(model: string, settings: Record<string, unknown>): ProviderReasoningOption[];

  /** Default reasoning value for the model. */
  getDefaultReasoningValue(model: string, settings: Record<string, unknown>): string;

  /** Context window size in tokens. */
  getContextWindowSize(model: string, customLimits?: Record<string, number>): number;

  /** Whether this is a built-in (default) model vs custom/env model. */
  isDefaultModel(model: string): boolean;

  /** Apply model change side effects to settings (defaults, tracking). */
  applyModelDefaults(model: string, settings: unknown): void;

  /** Optional hook when the toolbar changes a reasoning selection. */
  applyReasoningSelection?(model: string, value: string, settings: unknown): void;

  /** Normalize model variant based on visibility flags. Provider extracts what it needs from the settings bag. */
  normalizeModelVariant(model: string, settings: Record<string, unknown>): string;

  /** Extract custom model IDs from parsed environment variables. Used for per-model context limit UI. */
  getCustomModelIds(envVars: Record<string, string>): Set<string>;

  /** Optional permission-mode toggle descriptor. Return null when the provider exposes no permission toggle UI. */
  getPermissionModeToggle?(): ProviderPermissionModeToggleConfig | null;

  /** Optional provider-owned mapping back into the shared permission-mode contract. */
  resolvePermissionMode?(settings: Record<string, unknown>): string | null;

  /** Optional hook when the toolbar changes permission mode. */
  applyPermissionMode?(value: string, settings: unknown): void;

  /** Optional service-tier toggle descriptor. Return null when the provider exposes no fast/standard UI. */
  getServiceTierToggle?(settings: Record<string, unknown>): ProviderServiceTierToggleConfig | null;

  /** Optional provider-owned mode selector descriptor. */
  getModeSelector?(settings: Record<string, unknown>): ProviderModeSelectorConfig | null;

  /** Optional hook when the toolbar changes a provider-owned mode selection. */
  applyModeSelection?(value: string, settings: unknown): void;

  /** Whether the provider enables the shared bang-bash input mode. */
  isBangBashEnabled?(settings: Record<string, unknown>): boolean;

  /** SVG icon for the provider (shown next to model names in selectors). */
  getProviderIcon?(): ProviderIconSvg | null;
}

// ---------------------------------------------------------------------------
// Provider-owned boundary services
// ---------------------------------------------------------------------------

export interface ProviderCliResolver {
  resolveFromSettings(settings: Record<string, unknown>): string | null;
  reset(): void;
}

export interface ProviderRuntimeCommandLoaderContext {
  // Shared command discovery may need a short-lived provider session; the tab
  // manager decides when that is allowed for the active tab.
  allowSessionCreation?: boolean;
  conversation: Conversation | null;
  externalContextPaths: string[];
  plugin: ClaudianPlugin;
  runtime: ChatRuntime | null;
}

export interface ProviderRuntimeCommandLoader {
  isAvailable(settings: Record<string, unknown>): boolean;
  loadCommands(context: ProviderRuntimeCommandLoaderContext): Promise<SlashCommand[]>;
}

// `commands` warms provider-owned command discovery without fully priming the
// bound tab runtime. `runtime` primes the real tab runtime itself.
export type ProviderTabWarmupMode = 'none' | 'commands' | 'runtime';

export type ProviderTabWarmupLifecycleState = 'blank' | 'bound_cold' | 'bound_active' | 'closing';

export interface ProviderTabWarmupContext {
  conversation: Conversation | null;
  externalContextPaths: string[];
  plugin: ClaudianPlugin;
  runtime: ChatRuntime | null;
  tab: {
    conversationId: string | null;
    draftModel: string | null;
    lifecycleState: ProviderTabWarmupLifecycleState;
    providerId: ProviderId;
  };
}

export interface ProviderTabWarmupPolicy {
  resolveMode(context: ProviderTabWarmupContext): ProviderTabWarmupMode;
}

export interface ProviderWorkspaceServices {
  commandCatalog?: ProviderCommandCatalog | null;
  agentMentionProvider?: AgentMentionProvider | null;
  cliResolver?: ProviderCliResolver | null;
  runtimeCommandLoader?: ProviderRuntimeCommandLoader | null;
  tabWarmupPolicy?: ProviderTabWarmupPolicy | null;
  mcpServerManager?: McpServerManager | null;
  settingsTabRenderer?: ProviderSettingsTabRenderer | null;
  refreshAgentMentions?(): Promise<void>;
}

export interface ProviderSettingsTabRendererContext {
  plugin: ClaudianPlugin;
  renderHiddenProviderCommandSetting(
    container: HTMLElement,
    providerId: ProviderId,
    copy: { name: string; desc: string; placeholder: string },
  ): void;
  refreshModelSelectors(): void;
  renderCustomContextLimits(container: HTMLElement, providerId?: ProviderId): void;
}

export interface ProviderSettingsTabRenderer {
  render(container: HTMLElement, context: ProviderSettingsTabRendererContext): void;
}

export interface ProviderWorkspaceInitContext {
  plugin: ClaudianPlugin;
  storage: SharedAppStorage;
  vaultAdapter: VaultFileAdapter;
  homeAdapter: HomeFileAdapter;
}

export interface ProviderWorkspaceRegistration<
  TServices extends ProviderWorkspaceServices = ProviderWorkspaceServices,
> {
  initialize(context: ProviderWorkspaceInitContext): Promise<TServices>;
}

export interface ProviderConversationHistoryService {
  hydrateConversationHistory(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void>;
  deleteConversationSession(
    conversation: Conversation,
    vaultPath: string | null,
  ): Promise<void>;
  resolveSessionIdForConversation(conversation: Conversation | null): string | null;
  isPendingForkConversation(conversation: Conversation): boolean;
  /** Builds opaque provider state for a forked conversation. */
  buildForkProviderState(
    sourceSessionId: string,
    resumeAt: string,
    sourceProviderState?: Record<string, unknown>,
  ): Record<string, unknown>;
  /** Adds provider-owned persisted metadata to Conversation.providerState before session save. */
  buildPersistedProviderState?(conversation: Conversation): Record<string, unknown> | undefined;
}

export type ProviderTaskTerminalStatus = Extract<ToolCallInfo['status'], 'completed' | 'error'>;

export interface ProviderTaskResultInterpreter {
  hasAsyncLaunchMarker(toolUseResult: unknown): boolean;
  extractAgentId(toolUseResult: unknown): string | null;
  extractStructuredResult(toolUseResult: unknown): string | null;
  resolveTerminalStatus(
    toolUseResult: unknown,
    fallbackStatus: ProviderTaskTerminalStatus,
  ): ProviderTaskTerminalStatus;
  extractTagValue(payload: string, tagName: string): string | null;
}

export interface ProviderSubagentLaunchResult {
  agentId?: string;
  nickname?: string;
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

export interface ProviderSubagentLifecycleAdapter {
  isHiddenTool(name: string): boolean;
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
  extractSpawnResult(raw: string | undefined): ProviderSubagentLaunchResult;
  extractWaitResult(raw: string | undefined): ProviderSubagentWaitResult;
}

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

// -- Instruction refinement --

export type RefineProgressCallback = (update: InstructionRefineResult) => void;

export interface InstructionRefineService {
  setModelOverride?(model?: string): void;
  resetConversation(): void;
  refineInstruction(
    rawInstruction: string,
    existingInstructions: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult>;
  continueConversation(
    message: string,
    onProgress?: RefineProgressCallback
  ): Promise<InstructionRefineResult>;
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

export interface InlineEditResult {
  success: boolean;
  editedText?: string;
  insertedText?: string;
  clarification?: string;
  error?: string;
}

export interface InlineEditService {
  setModelOverride?(model?: string): void;
  resetConversation(): void;
  editText(request: InlineEditRequest): Promise<InlineEditResult>;
  continueConversation(message: string, contextFiles?: string[]): Promise<InlineEditResult>;
  cancel(): void;
}
