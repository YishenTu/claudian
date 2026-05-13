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
  resolveClaudeSettingSources,
} from '../settings';
import {
  resolveAdaptiveEffortLevel,
  resolveThinkingTokens,
} from '../types/models';
import { createCustomSpawnFunction } from './customSpawn';
import {
  DISABLED_BUILTIN_SUBAGENTS,
  type PersistentQueryConfig,
  UNSUPPORTED_SDK_TOOLS,
} from './types';

export interface QueryOptionsContext {
  vaultPath: string;
  cliPath: string;
  settings: ClaudianSettings;
  customEnv: Record<string, string>;
  enhancedPath: string;
  mcpManager: McpServerManager;
  pluginManager: AppPluginManager;
}

export interface PersistentQueryContext extends QueryOptionsContext {
  abortController?: AbortController;
  resume?: {
    sessionId: string;
    sessionAt?: string;
    fork?: boolean;
  };
  canUseTool?: CanUseTool;
  hooks: Options['hooks'];
  externalContextPaths?: string[];
}

export interface ColdStartQueryContext extends QueryOptionsContext {
  abortController?: AbortController;
  sessionId?: string;
  modelOverride?: string;
  canUseTool?: CanUseTool;
  hooks: Options['hooks'];
  mcpMentions?: Set<string>;
  enabledMcpServers?: Set<string>;
  allowedTools?: string[];
  hasEditorContext: boolean;
  externalContextPaths?: string[];
}

export class QueryOptionsBuilder {
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

    // Fixed thinking budgets are startup query options. Adaptive effort remains
    // dynamic via applyFlagSettings(), but fixed budgets require query rebuilds.
    if (currentConfig.thinkingTokens !== newConfig.thinkingTokens) return true;

    if (currentConfig.enableChrome !== newConfig.enableChrome) return true;
    if (currentConfig.enableAutoMode !== newConfig.enableAutoMode) return true;

    // External context paths require restart (additionalDirectories can't be updated dynamically)
    if (QueryOptionsBuilder.pathsChanged(currentConfig.externalContextPaths, newConfig.externalContextPaths)) {
      return true;
    }

    return false;
  }

  static buildPersistentQueryConfig(
    ctx: QueryOptionsContext,
    externalContextPaths?: string[]
  ): PersistentQueryConfig {
    const claudeSettings = getClaudeProviderSettings(ctx.settings);
    const systemPromptSettings: SystemPromptSettings = {
      mediaFolder: ctx.settings.mediaFolder,
      customPrompt: ctx.settings.systemPrompt,
      vaultPath: ctx.vaultPath,
      userName: ctx.settings.userName,
    };

    const sdkPermissionMode = QueryOptionsBuilder.resolveClaudeSdkPermissionMode(
      ctx.settings.permissionMode,
      claudeSettings.safeMode,
    );

    const disallowedToolsKey = ctx.mcpManager.getAllDisallowedMcpTools().join('|');
    const pluginsKey = ctx.pluginManager.getPluginsKey();

    const settingSources = resolveClaudeSettingSources(claudeSettings.loadUserSettings);

    return {
      model: ctx.settings.model,
      thinkingTokens: resolveThinkingTokens(ctx.settings.model, ctx.settings.thinkingBudget),
      effortLevel: resolveAdaptiveEffortLevel(ctx.settings.model, ctx.settings.effortLevel),
      permissionMode: ctx.settings.permissionMode,
      sdkPermissionMode,
      systemPromptKey: computeSystemPromptKey(systemPromptSettings),
      disallowedToolsKey,
      mcpServersKey: '', // Dynamic via setMcpServers, not tracked for restart
      pluginsKey,
      externalContextPaths: externalContextPaths || [],
      settingSources: settingSources.join(','),
      claudeCliPath: ctx.cliPath,
      enableChrome: claudeSettings.enableChrome,
      enableAutoMode: claudeSettings.safeMode === 'auto',
    };
  }

  static buildPersistentQueryOptions(ctx: PersistentQueryContext): Options {
    const { options, claudeSettings } = QueryOptionsBuilder.buildBaseOptions(
      ctx,
      ctx.settings.model,
      ctx.abortController,
    );

    options.disallowedTools = [
      ...ctx.mcpManager.getAllDisallowedMcpTools(),
      ...UNSUPPORTED_SDK_TOOLS,
      ...DISABLED_BUILTIN_SUBAGENTS,
    ];

    QueryOptionsBuilder.applyPermissionMode(
      options,
      ctx.settings.permissionMode,
      claudeSettings.safeMode,
      ctx.canUseTool,
    );
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

    return options;
  }

  static buildColdStartQueryOptions(ctx: ColdStartQueryContext): Options {
    const selectedModel = ctx.modelOverride ?? ctx.settings.model;
    const { options, claudeSettings } = QueryOptionsBuilder.buildBaseOptions(
      ctx,
      selectedModel,
      ctx.abortController,
    );

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

    QueryOptionsBuilder.applyPermissionMode(
      options,
      ctx.settings.permissionMode,
      claudeSettings.safeMode,
      ctx.canUseTool,
    );
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

    return options;
  }

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

  private static applyExtraArgs(
    options: Options,
    settings: { enableChrome: boolean; safeMode: ClaudeSafeMode },
  ): void {
    if (settings.safeMode === 'auto') {
      options.extraArgs = { ...options.extraArgs, 'enable-auto-mode': null };
    }

    if (settings.enableChrome) {
      options.extraArgs = { ...options.extraArgs, chrome: null };
    }
  }

  private static buildBaseOptions(
    ctx: QueryOptionsContext,
    model: string,
    abortController?: AbortController,
  ): { options: Options; claudeSettings: ReturnType<typeof getClaudeProviderSettings> } {
    const claudeSettings = getClaudeProviderSettings(ctx.settings);
    const systemPromptSettings: SystemPromptSettings = {
      mediaFolder: ctx.settings.mediaFolder,
      customPrompt: ctx.settings.systemPrompt,
      vaultPath: ctx.vaultPath,
      userName: ctx.settings.userName,
    };
    const options: Options = {
      cwd: ctx.vaultPath,
      systemPrompt: buildSystemPrompt(systemPromptSettings),
      model,
      abortController,
      pathToClaudeCodeExecutable: ctx.cliPath,
      settingSources: resolveClaudeSettingSources(claudeSettings.loadUserSettings),
      env: {
        ...process.env,
        ...ctx.customEnv,
        PATH: ctx.enhancedPath,
      },
      includePartialMessages: true,
    };

    QueryOptionsBuilder.applyExtraArgs(options, claudeSettings);
    options.spawnClaudeCodeProcess = createCustomSpawnFunction(ctx.enhancedPath);

    return { options, claudeSettings };
  }

  private static applyThinking(
    options: Options,
    settings: ClaudianSettings,
    model: string
  ): void {
    const effortLevel = resolveAdaptiveEffortLevel(model, settings.effortLevel);
    if (effortLevel !== null) {
      options.thinking = { type: 'adaptive' };
      // SDK runtime accepts `xhigh` on Opus 4.7+ and silently falls back to
      // `high` elsewhere, but its type definition lags our local EffortLevel.
      options.effort = effortLevel;
      return;
    }

    const thinkingTokens = resolveThinkingTokens(model, settings.thinkingBudget);
    if (thinkingTokens !== null) {
      options.thinking = { type: 'enabled', budgetTokens: thinkingTokens };
    }
  }

  private static pathsChanged(a?: string[], b?: string[]): boolean {
    const aKey = [...(a || [])].sort().join('|');
    const bKey = [...(b || [])].sort().join('|');
    return aKey !== bKey;
  }

}
