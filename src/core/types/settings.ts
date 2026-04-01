export type HiddenProviderCommands = Record<string, string[]>;

export interface ApprovalSelectionDecision {
  type: 'select-option';
  value: string;
}

/** User decision from the approval modal. */
export type ApprovalDecision =
  | 'allow'
  | 'allow-always'
  | 'deny'
  | 'cancel'
  | ApprovalSelectionDecision;

/** Saved environment variable configuration. */
export interface EnvSnippet {
  id: string;
  name: string;
  description: string;
  envVars: string;
  scope?: EnvironmentScope;
  contextLimits?: Record<string, number>;  // Optional: context limits for custom models
}

/** Source of a slash command. */
export type SlashCommandSource = 'builtin' | 'user' | 'plugin' | 'sdk';

/** Slash command configuration shared by the UI, storage, and runtime boundary. */
export interface SlashCommand {
  id: string;
  name: string;                // Command name used after / (e.g., "review-code")
  description?: string;        // Optional description shown in dropdown
  argumentHint?: string;       // Placeholder text for arguments (e.g., "[file] [focus]")
  allowedTools?: string[];     // Restrict tools when command is used
  model?: string;              // Optional provider-specific model override
  content: string;             // Prompt template with placeholders
  source?: SlashCommandSource; // Origin of the command (builtin, user, plugin, sdk)
  kind?: 'command' | 'skill';  // Explicit type — replaces id-prefix heuristic
  // Provider-owned command metadata that the UI preserves and round-trips.
  disableModelInvocation?: boolean;  // Disable model invocation for this skill
  userInvocable?: boolean;           // Whether user can invoke this skill directly
  context?: 'fork';                  // Subagent execution mode
  agent?: string;                    // Subagent type when context='fork'
  hooks?: Record<string, unknown>;   // Pass-through to SDK
}

/** Keyboard navigation settings for vim-style scrolling. */
export interface KeyboardNavigationSettings {
  scrollUpKey: string;         // Key to scroll up when focused on messages (default: 'w')
  scrollDownKey: string;       // Key to scroll down when focused on messages (default: 's')
  focusInputKey: string;       // Key to focus input (default: 'i', like vim insert mode)
}

/** Tab bar position setting. */
export type TabBarPosition = 'input' | 'header';

/** Result from instruction refinement agent query. */
export interface InstructionRefineResult {
  success: boolean;
  refinedInstruction?: string;  // The refined instruction text
  clarification?: string;       // Agent's clarifying question (if any)
  error?: string;               // Error message (if failed)
}

/** Permission mode for tool execution. */
export type PermissionMode = 'yolo' | 'plan' | 'normal';

/** Scope for environment variable storage and snippets. */
export type EnvironmentScope = 'shared' | `provider:${string}`;

/** Hostname-keyed CLI paths for per-device configuration. */
export type HostnameCliPaths = Record<string, string>;

/** Opaque provider-owned settings bags keyed by provider id. */
export type ProviderConfigMap = Partial<Record<string, Record<string, unknown>>>;

/**
 * Application settings stored in .claude/claudian-settings.json.
 *
 * Provider-specific fields (model, thinkingBudget, effortLevel, etc.) use
 * `string` here.  The active provider casts internally when it needs
 * narrower types.
 */
export interface ClaudianSettings {
  // User preferences
  userName: string;

  // Security
  permissionMode: PermissionMode;

  // Model & thinking (provider interprets values)
  model: string;
  thinkingBudget: string;
  effortLevel: string;
  enableAutoTitleGeneration: boolean;
  titleGenerationModel: string;

  // Content settings
  excludedTags: string[];
  mediaFolder: string;
  systemPrompt: string;
  persistentExternalContextPaths: string[];

  // Environment
  sharedEnvironmentVariables: string;
  envSnippets: EnvSnippet[];
  customContextLimits: Record<string, number>;

  // UI settings
  keyboardNavigation: KeyboardNavigationSettings;

  // Internationalization
  locale: string;

  // Provider-owned settings
  providerConfigs: ProviderConfigMap;

  // Provider selection
  settingsProvider: string;  // ProviderId — which provider's model/effort/budget is projected to top-level fields
  savedProviderModel: Partial<Record<string, string>>;
  savedProviderEffort: Partial<Record<string, string>>;
  savedProviderThinkingBudget: Partial<Record<string, string>>;

  // State (provider-specific, round-tripped opaquely)
  lastCustomModel?: string;

  // UI preferences
  maxTabs: number;
  tabBarPosition: TabBarPosition;
  enableAutoScroll: boolean;
  openInMainTab: boolean;

  // Provider command visibility
  hiddenProviderCommands: HiddenProviderCommands;

  // Allow provider-specific extension fields
  [key: string]: unknown;
}
