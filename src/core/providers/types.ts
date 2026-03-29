import type ClaudianPlugin from '../../main';
import type { CursorContext } from '../../utils/editor';
import type { McpServerManager } from '../mcp/McpServerManager';
import type { ChatRuntime } from '../runtime/ChatRuntime';
import type {
  AgentDefinition,
  Conversation,
  InstructionRefineResult,
  ManagedMcpServer,
  PluginInfo,
  SessionMetadata,
  SlashCommand,
  ToolCallInfo,
} from '../types';
import type { ProviderCommandCatalog } from './commands/ProviderCommandCatalog';

export type ProviderId = 'claude' | 'codex';

export interface ProviderCapabilities {
  providerId: ProviderId;
  supportsPersistentRuntime: boolean;
  supportsNativeHistory: boolean;
  supportsPlanMode: boolean;
  supportsRewind: boolean;
  supportsFork: boolean;
  supportsProviderCommands: boolean;
  reasoningControl: 'effort' | 'token-budget' | 'none';
  planPathPrefix?: string;
}

export const DEFAULT_CHAT_PROVIDER_ID = 'claude' as const satisfies ProviderId;

export interface CreateChatRuntimeOptions {
  plugin: ClaudianPlugin;
  mcpManager: McpServerManager;
  providerId?: ProviderId;
}

/**
 * Chat-facing provider registration.
 *
 * This is intentionally limited to chat-facing services.
 * Shared bootstrap (defaults, storage) is in `src/core/bootstrap/`.
 * Claude-only workspace services (CLI resolver, plugins, agents, commands,
 * skills, MCP) live behind the Claude adaptor in `src/providers/claude/app/`.
 */
export interface ProviderRegistration {
  displayName: string;
  blankTabOrder: number;
  isEnabled: (settings: Record<string, unknown>) => boolean;
  capabilities: ProviderCapabilities;
  chatUIConfig: ProviderChatUIConfig;
  settingsReconciler: ProviderSettingsReconciler;
  createRuntime: (options: Omit<CreateChatRuntimeOptions, 'providerId'>) => ChatRuntime;
  createTitleGenerationService: (plugin: ClaudianPlugin) => TitleGenerationService;
  createInstructionRefineService: (plugin: ClaudianPlugin) => InstructionRefineService;
  createInlineEditService: (plugin: ClaudianPlugin) => InlineEditService;
  historyService: ProviderConversationHistoryService;
  taskResultInterpreter: ProviderTaskResultInterpreter;
}

export interface ProviderSettingsReconciler {
  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
    envText: string,
  ): { changed: boolean; invalidatedConversations: Conversation[] };

  normalizeModelVariantSettings(settings: Record<string, unknown>): boolean;
}

// ---------------------------------------------------------------------------
// App-level service interfaces
// ---------------------------------------------------------------------------

/** Tab manager state persisted across restarts. */
export interface AppTabManagerState {
  openTabs: Array<{ tabId: string; conversationId: string | null }>;
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
// Claude-owned storage sub-interfaces
//
// These remain here as standalone types so the settings UI can reference them
// through the Claude storage surface. They are NOT part of the shared
// bootstrap storage contract (SharedAppStorage).
// ---------------------------------------------------------------------------

export interface AppMcpStorage {
  load(): Promise<ManagedMcpServer[]>;
  save(servers: ManagedMcpServer[]): Promise<void>;
  tryParseClipboardConfig?(text: string): unknown | null;
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

/** Plugin manager interface (Claude-owned, consumed by app layer). */
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

/** Agent manager interface (Claude-owned, consumed by app layer). */
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

/** SVG icon descriptor for provider branding in selectors. */
export interface ProviderIconSvg {
  viewBox: string;
  path: string;
}

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

/** Static UI configuration owned by the provider (model list, reasoning, context window). */
export interface ProviderChatUIConfig {
  /** Model options for the selector dropdown. Provider extracts what it needs from the settings bag. */
  getModelOptions(settings: Record<string, unknown>): ProviderUIOption[];

  /** Whether the model uses adaptive reasoning (effort levels vs token budgets). */
  isAdaptiveReasoningModel(model: string): boolean;

  /** Reasoning options for the current model (effort levels if adaptive, budgets otherwise). */
  getReasoningOptions(model: string): ProviderReasoningOption[];

  /** Default reasoning value for the model. */
  getDefaultReasoningValue(model: string): string;

  /** Context window size in tokens. */
  getContextWindowSize(model: string, customLimits?: Record<string, number>): number;

  /** Whether this is a built-in (default) model vs custom/env model. */
  isDefaultModel(model: string): boolean;

  /** Apply model change side effects to settings (defaults, tracking). */
  applyModelDefaults(model: string, settings: unknown): void;

  /** Normalize model variant based on visibility flags. Provider extracts what it needs from the settings bag. */
  normalizeModelVariant(model: string, settings: Record<string, unknown>): string;

  /** Extract custom model IDs from parsed environment variables. Used for per-model context limit UI. */
  getCustomModelIds(envVars: Record<string, string>): Set<string>;

  /** Optional permission-mode toggle descriptor. Return null when the provider exposes no permission toggle UI. */
  getPermissionModeToggle?(): ProviderPermissionModeToggleConfig | null;

  /** SVG icon for the provider (shown next to model names in selectors). */
  getProviderIcon?(): ProviderIconSvg | null;
}

// ---------------------------------------------------------------------------
// Provider-owned boundary services
// ---------------------------------------------------------------------------

export interface ProviderCliResolver {
  resolve(
    hostnamePaths: Record<string, string> | undefined,
    legacyPath: string | undefined,
    environmentVariables: string,
  ): string | null;
  reset(): void;
}

export interface ProviderWorkspaceServices {
  commandCatalog?: ProviderCommandCatalog | null;
  agentMentionProvider?: AgentMentionProvider | null;
  refreshAgentMentions?(): Promise<void>;
}

export interface ProviderWorkspaceInitContext {
  plugin: ClaudianPlugin;
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
  buildForkProviderState(sourceSessionId: string, resumeAt: string): Record<string, unknown>;
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
  resetConversation(): void;
  editText(request: InlineEditRequest): Promise<InlineEditResult>;
  continueConversation(message: string, contextFiles?: string[]): Promise<InlineEditResult>;
  cancel(): void;
}
