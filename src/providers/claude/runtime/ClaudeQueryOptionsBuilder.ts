/**
 * QueryOptionsBuilder - SDK Options Construction
 *
 * Extracts options-building logic from ClaudianService for:
 * - Persistent query options (warm path)
 * - Cold-start query options
 * - Configuration change detection
 *
 * Design: Static builder methods that take a context object containing
 * all required dependencies (settings, managers, paths).
 */

import type {
  CanUseTool,
  Options,
  PermissionMode as SDKPermissionMode,
} from '@anthropic-ai/claude-agent-sdk';

import type { McpServerManager } from '../../../core/mcp/McpServerManager';
import {
  buildSystemPrompt,
  computeSystemPromptKey,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';
import type { AppPluginManager } from '../../../core/providers/types';
import type { ClaudianSettings, PermissionMode } from '../../../core/types/settings';
import {
  type ClaudeSafeMode,
  getClaudeProviderSettings,
} from '../settings';
import {
  type EffortLevel,
  isAdaptiveThinkingModel,
  THINKING_BUDGETS,
} from '../types/models';
import { createCustomSpawnFunction } from './customSpawn';
import {
  DISABLED_BUILTIN_SUBAGENTS,
  type PersistentQueryConfig,
  UNSUPPORTED_SDK_TOOLS,
} from './types';

/**
 * Context required for building SDK options.
 * Passed to builder methods to avoid direct dependencies on ClaudianService.
 */
export interface QueryOptionsContext {
  /** Absolute path to the vault root. */
  vaultPath: string;
  /** Path to the Claude CLI executable. */
  cliPath: string;
  /** Current plugin settings. */
  settings: ClaudianSettings;
  /** Parsed environment variables (from settings). */
  customEnv: Record<string, string>;
  /** Enhanced PATH with CLI directories. */
  enhancedPath: string;
  /** MCP server manager for server configuration. */
  mcpManager: McpServerManager;
  /** Plugin manager for Claude Code plugins. */
  pluginManager: AppPluginManager;
}

/**
 * Additional context for persistent query options.
 */
export interface PersistentQueryContext extends QueryOptionsContext {
  /** AbortController for the query. */
  abortController?: AbortController;
  /** Session resume state (sessionId required; sessionAt and fork only meaningful with a session). */
  resume?: {
    sessionId: string;
    /** Assistant checkpoint ID for SDK resumeSessionAt after rewind. */
    sessionAt?: string;
    /** Fork the session (non-destructive branch). */
    fork?: boolean;
  };
  /** Approval callback for normal mode. */
  canUseTool?: CanUseTool;
  /** Pre-built hooks array. */
  hooks: Options['hooks'];
  /** External context paths for additionalDirectories SDK option. */
  externalContextPaths?: string[];
}

/**
 * Additional context for cold-start query options.
 */
export interface ColdStartQueryContext extends QueryOptionsContext {
  /** AbortController for the query. */
  abortController?: AbortController;
  /** Session ID for resuming a conversation. */
  sessionId?: string;
  /** Optional model override for cold-start queries. */
  modelOverride?: string;
  /** Approval callback for normal mode. */
  canUseTool?: CanUseTool;
  /** Pre-built hooks array. */
  hooks: Options['hooks'];
  /** MCP server @-mentions from the query. */
  mcpMentions?: Set<string>;
  /** MCP servers enabled via UI selector. */
  enabledMcpServers?: Set<string>;
  /** Allowed tools restriction (undefined = no restriction). */
  allowedTools?: string[];
  /** Whether the query has editor context. */
  hasEditorContext: boolean;
  /** External context paths for additionalDirectories SDK option. */
  externalContextPaths?: string[];
}

/** Static builder for SDK Options and configuration objects. */
export class QueryOptionsBuilder {
  /**
   * Some changes (model, thinking tokens) can be updated dynamically; others require restart.
   */
  static needsRestart(
    currentConfig: PersistentQueryConfig | null,
    newConfig: PersistentQueryConfig
  ): boolean {
    if (!currentConfig) return true;

    // These require restart (cannot be updated dynamically)
    if (currentConfig.systemPromptKey !== newConfig.systemPromptKey) return true;
    if (currentConfig.disallowedToolsKey !== newConfig.disallowedToolsKey) return true;
    if (currentConfig.pluginsKey !== newConfig.pluginsKey) return true;
    if (currentConfig.settingSources !== newConfig.settingSources) return true;
    if (currentConfig.claudeCliPath !== newConfig.claudeCliPath) return true;

    // Note: Permission mode is handled dynamically via setPermissionMode() in ClaudianService.
    // Since allowDangerouslySkipPermissions is always true, both directions work without restart.

    if (currentConfig.enableChrome !== newConfig.enableChrome) return true;

    // Effort level requires restart (no setEffort() on persistent query)
    if (currentConfig.effortLevel !== newConfig.effortLevel) return true;

    // External context paths require restart (additionalDirectories can't be updated dynamically)
    if (QueryOptionsBuilder.pathsChanged(currentConfig.externalContextPaths, newConfig.externalContextPaths)) {
      return true;
    }

    return false;
  }

  /** Builds configuration snapshot for restart detection. */
  static buildPersistentQueryConfig(
    ctx: QueryOptionsContext,
    externalContextPaths?: string[]
  ): PersistentQueryConfig {
    const claudeSettings = getClaudeProviderSettings(ctx.settings as unknown as Record<string, unknown>);
    const systemPromptSettings: SystemPromptSettings = {
      mediaFolder: ctx.settings.mediaFolder,
      customPrompt: ctx.settings.systemPrompt,
      vaultPath: ctx.vaultPath,
      userName: ctx.settings.userName,
    };

    const budgetSetting = ctx.settings.thinkingBudget;
    const budgetConfig = THINKING_BUDGETS.find(b => b.value === budgetSetting);
    const thinkingTokens = budgetConfig?.tokens ?? null;
    const sdkPermissionMode = QueryOptionsBuilder.resolveClaudeSdkPermissionMode(
      ctx.settings.permissionMode,
      claudeSettings.safeMode,
    );

    // Compute disallowedToolsKey from all disabled MCP tools (pre-registered upfront)
    const allDisallowedTools = ctx.mcpManager.getAllDisallowedMcpTools();
    const disallowedToolsKey = allDisallowedTools.join('|');

    // Compute pluginsKey from active plugins
    const pluginsKey = ctx.pluginManager.getPluginsKey();

    return {
      model: ctx.settings.model,
      thinkingTokens: thinkingTokens && thinkingTokens > 0 ? thinkingTokens : null,
      effortLevel: isAdaptiveThinkingModel(ctx.settings.model) ? ctx.settings.effortLevel as EffortLevel : null,
      permissionMode: ctx.settings.permissionMode,
      sdkPermissionMode,
      systemPromptKey: computeSystemPromptKey(systemPromptSettings),
      disallowedToolsKey,
      mcpServersKey: '', // Dynamic via setMcpServers, not tracked for restart
      pluginsKey,
      externalContextPaths: externalContextPaths || [],
      settingSources: claudeSettings.loadUserSettings ? 'user,project' : 'project',
      claudeCliPath: ctx.cliPath,
      enableChrome: claudeSettings.enableChrome,
    };
  }

  /** Builds SDK options for the persistent query. */
  static buildPersistentQueryOptions(ctx: PersistentQueryContext): Options {
    const claudeSettings = getClaudeProviderSettings(ctx.settings as unknown as Record<string, unknown>);
    const permissionMode = ctx.settings.permissionMode;

    const systemPrompt = buildSystemPrompt({
      mediaFolder: ctx.settings.mediaFolder,
      customPrompt: ctx.settings.systemPrompt,
      vaultPath: ctx.vaultPath,
      userName: ctx.settings.userName,
    });

    const options: Options = {
      cwd: ctx.vaultPath,
      systemPrompt,
      model: ctx.settings.model,
      abortController: ctx.abortController,
      pathToClaudeCodeExecutable: ctx.cliPath,
      settingSources: claudeSettings.loadUserSettings
        ? ['user', 'project']
        : ['project'],
      env: {
        ...process.env,
        ...ctx.customEnv,
        PATH: ctx.enhancedPath,
      },
      includePartialMessages: true,
    };

    QueryOptionsBuilder.applyExtraArgs(options, claudeSettings.enableChrome);

    options.disallowedTools = [
      ...ctx.mcpManager.getAllDisallowedMcpTools(),
      ...UNSUPPORTED_SDK_TOOLS,
      ...DISABLED_BUILTIN_SUBAGENTS,
    ];

    QueryOptionsBuilder.applyPermissionMode(options, permissionMode, claudeSettings.safeMode, ctx.canUseTool);
    QueryOptionsBuilder.applyThinking(options, ctx.settings, ctx.settings.model);
    options.hooks = ctx.hooks;

    options.enableFileCheckpointing = true;

    if (ctx.resume) {
      options.resume = ctx.resume.sessionId;
      if (ctx.resume.sessionAt) {
        options.resumeSessionAt = ctx.resume.sessionAt;
      }
      if (ctx.resume.fork) {
        options.forkSession = true;
      }
    }

    if (ctx.externalContextPaths && ctx.externalContextPaths.length > 0) {
      options.additionalDirectories = ctx.externalContextPaths;
    }

    options.spawnClaudeCodeProcess = createCustomSpawnFunction(ctx.enhancedPath);

    return options;
  }

  /** Builds SDK options for a cold-start query. */
  static buildColdStartQueryOptions(ctx: ColdStartQueryContext): Options {
    const claudeSettings = getClaudeProviderSettings(ctx.settings as unknown as Record<string, unknown>);
    const permissionMode = ctx.settings.permissionMode;

    const selectedModel = ctx.modelOverride ?? ctx.settings.model;
    const systemPrompt = buildSystemPrompt({
      mediaFolder: ctx.settings.mediaFolder,
      customPrompt: ctx.settings.systemPrompt,
      vaultPath: ctx.vaultPath,
      userName: ctx.settings.userName,
    });

    const options: Options = {
      cwd: ctx.vaultPath,
      systemPrompt,
      model: selectedModel,
      abortController: ctx.abortController,
      pathToClaudeCodeExecutable: ctx.cliPath,
      // User settings may contain permission rules that bypass Claudian's permission system
      settingSources: claudeSettings.loadUserSettings
        ? ['user', 'project']
        : ['project'],
      env: {
        ...process.env,
        ...ctx.customEnv,
        PATH: ctx.enhancedPath,
      },
      includePartialMessages: true,
    };

    QueryOptionsBuilder.applyExtraArgs(options, claudeSettings.enableChrome);

    const mcpMentions = ctx.mcpMentions || new Set<string>();
    const uiEnabledServers = ctx.enabledMcpServers || new Set<string>();
    const combinedMentions = new Set([...mcpMentions, ...uiEnabledServers]);
    const mcpServers = ctx.mcpManager.getActiveServers(combinedMentions);

    if (Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }

    const disallowedMcpTools = ctx.mcpManager.getDisallowedMcpTools(combinedMentions);
    options.disallowedTools = [
      ...disallowedMcpTools,
      ...UNSUPPORTED_SDK_TOOLS,
      ...DISABLED_BUILTIN_SUBAGENTS,
    ];

    QueryOptionsBuilder.applyPermissionMode(options, permissionMode, claudeSettings.safeMode, ctx.canUseTool);
    options.hooks = ctx.hooks;
    QueryOptionsBuilder.applyThinking(options, ctx.settings, ctx.modelOverride ?? ctx.settings.model);

    if (ctx.allowedTools !== undefined && ctx.allowedTools.length > 0) {
      options.tools = ctx.allowedTools;
    }

    if (ctx.sessionId) {
      options.resume = ctx.sessionId;
    }

    if (ctx.externalContextPaths && ctx.externalContextPaths.length > 0) {
      options.additionalDirectories = ctx.externalContextPaths;
    }

    options.spawnClaudeCodeProcess = createCustomSpawnFunction(ctx.enhancedPath);

    return options;
  }

  /**
   * Always sets allowDangerouslySkipPermissions: true to enable dynamic
   * switching between permission modes without requiring a process restart.
   */
  /**
   * Resolve the SDK permission mode from Claudian's permission mode and safe mode setting.
   * Shared by option construction and live session updates.
   */
  static resolveClaudeSdkPermissionMode(
    permissionMode: PermissionMode,
    claudeSafeMode: ClaudeSafeMode = 'acceptEdits',
  ): SDKPermissionMode {
    if (permissionMode === 'yolo') return 'bypassPermissions';
    if (permissionMode === 'plan') return 'plan';
    return claudeSafeMode;
  }

  private static applyPermissionMode(
    options: Options,
    permissionMode: PermissionMode,
    claudeSafeMode: ClaudeSafeMode,
    canUseTool?: CanUseTool
  ): void {
    options.allowDangerouslySkipPermissions = true;

    if (canUseTool) {
      options.canUseTool = canUseTool;
    }

    options.permissionMode = QueryOptionsBuilder.resolveClaudeSdkPermissionMode(
      permissionMode,
      claudeSafeMode,
    );
  }

  private static applyExtraArgs(options: Options, enableChrome: boolean): void {
    if (enableChrome) {
      options.extraArgs = { ...options.extraArgs, chrome: null };
    }
  }

  private static applyThinking(
    options: Options,
    settings: ClaudianSettings,
    model: string
  ): void {
    if (isAdaptiveThinkingModel(model)) {
      options.thinking = { type: 'adaptive' };
      options.effort = settings.effortLevel as EffortLevel;
    } else {
      const budgetConfig = THINKING_BUDGETS.find(b => b.value === settings.thinkingBudget);
      if (budgetConfig && budgetConfig.tokens > 0) {
        options.maxThinkingTokens = budgetConfig.tokens;
      }
    }
  }

  private static pathsChanged(a?: string[], b?: string[]): boolean {
    const aKey = [...(a || [])].sort().join('|');
    const bKey = [...(b || [])].sort().join('|');
    return aKey !== bKey;
  }

}
