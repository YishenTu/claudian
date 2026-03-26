import type ClaudianPlugin from '../../main';
import type { CursorContext } from '../../utils/editor';
import type { McpServerManager } from '../mcp';
import type { ChatRuntime } from '../runtime';
import type {
  Conversation,
  InstructionRefineResult,
  ToolCallInfo,
} from '../types';

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

export interface ProviderRegistration {
  capabilities: ProviderCapabilities;
  chatUIConfig: ProviderChatUIConfig;
  createRuntime: (options: Omit<CreateChatRuntimeOptions, 'providerId'>) => ChatRuntime;
  createTitleGenerationService: (plugin: ClaudianPlugin) => TitleGenerationService;
  createInstructionRefineService: (plugin: ClaudianPlugin) => InstructionRefineService;
  createInlineEditService: (plugin: ClaudianPlugin) => InlineEditService;
  createCliResolver: () => ProviderCliResolver;
  historyService: ProviderConversationHistoryService;
  taskResultInterpreter: ProviderTaskResultInterpreter;
}

// ---------------------------------------------------------------------------
// Provider-owned chat UI configuration
// ---------------------------------------------------------------------------

/** Option for model, reasoning, or other UI selectors. */
export interface ProviderUIOption {
  value: string;
  label: string;
  description?: string;
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
  /** Model options for the selector dropdown. */
  getModelOptions(settings: {
    enableOpus1M?: boolean;
    enableSonnet1M?: boolean;
    environmentVariables?: string;
  }): ProviderUIOption[];

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

  /** Normalize model variant based on visibility flags (e.g., 1M context toggle). */
  normalizeModelVariant(model: string, settings: {
    enableOpus1M?: boolean;
    enableSonnet1M?: boolean;
  }): string;

  /** Optional permission-mode toggle descriptor. Return null when the provider exposes no permission toggle UI. */
  getPermissionModeToggle?(): ProviderPermissionModeToggleConfig | null;
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
