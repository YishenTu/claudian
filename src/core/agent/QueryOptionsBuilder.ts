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
  AgentDefinition as SdkAgentDefinition,
  CanUseTool,
  McpServerConfig,
  Options,
} from '@anthropic-ai/claude-agent-sdk';

import type { AgentManager } from '../agents';
import type { McpServerManager } from '../mcp';
import type { PluginManager } from '../plugins';
import { buildSystemPrompt, type SystemPromptSettings } from '../prompts/mainAgent';
import type { ClaudianSettings, PermissionMode } from '../types';
import { resolveModelWithBetas, THINKING_BUDGETS } from '../types';
import type { AgentDefinition } from '../types/agent';
import {
  computeSystemPromptKey,
  type PersistentQueryConfig,
  UNSUPPORTED_SDK_TOOLS,
} from './types';

// ============================================
// Context Types
// ============================================

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
  pluginManager: PluginManager;
  /** Agent manager for custom subagent definitions. */
  agentManager?: AgentManager;
}

/**
 * Additional context for persistent query options.
 */
export interface PersistentQueryContext extends QueryOptionsContext {
  /** AbortController for the query. */
  abortController?: AbortController;
  /** Session ID for resuming a conversation. */
  resumeSessionId?: string;
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

// ============================================
// QueryOptionsBuilder
// ============================================

/**
 * Static builder for SDK Options and configuration objects.
 *
 * Design: Uses static methods rather than instance methods because the builder
 * is stateless - all state comes from the context parameter. This makes the
 * code easier to test and avoids needing to instantiate a builder object.
 */
export class QueryOptionsBuilder {
  /**
   * Checks if the persistent query needs to be restarted based on configuration changes.
   *
   * Compares current config against new config to detect changes that require restart.
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

    // Beta flag presence is determined by show1MModel setting.
    // If it changes, restart is required.
    if (currentConfig.show1MModel !== newConfig.show1MModel) return true;

    // Export paths affect system prompt
    if (QueryOptionsBuilder.pathsChanged(currentConfig.allowedExportPaths, newConfig.allowedExportPaths)) {
      return true;
    }

    // External context paths require restart (additionalDirectories can't be updated dynamically)
    if (QueryOptionsBuilder.pathsChanged(currentConfig.externalContextPaths, newConfig.externalContextPaths)) {
      return true;
    }

    return false;
  }

  /**
   * Builds configuration object for tracking changes.
   *
   * Used to detect when the persistent query needs to be restarted
   * due to configuration changes that cannot be applied dynamically.
   *
   * @param ctx - The query options context
   * @param externalContextPaths - External context paths for additionalDirectories
   */
  static buildPersistentQueryConfig(
    ctx: QueryOptionsContext,
    externalContextPaths?: string[]
  ): PersistentQueryConfig {
    // System prompt settings (agents are passed via Options.agents, not system prompt)
    const systemPromptSettings: SystemPromptSettings = {
      mediaFolder: ctx.settings.mediaFolder,
      customPrompt: ctx.settings.systemPrompt,
      allowedExportPaths: ctx.settings.allowedExportPaths,
      vaultPath: ctx.vaultPath,
    };

    const budgetSetting = ctx.settings.thinkingBudget;
    const budgetConfig = THINKING_BUDGETS.find(b => b.value === budgetSetting);
    const thinkingTokens = budgetConfig?.tokens ?? null;

    // Compute disallowedToolsKey from all disabled MCP tools (pre-registered upfront)
    const allDisallowedTools = ctx.mcpManager.getAllDisallowedMcpTools();
    const disallowedToolsKey = allDisallowedTools.join('|');

    // Compute pluginsKey from active plugins
    const pluginsKey = ctx.pluginManager.getPluginsKey();

    return {
      model: ctx.settings.model,
      thinkingTokens: thinkingTokens && thinkingTokens > 0 ? thinkingTokens : null,
      permissionMode: ctx.settings.permissionMode,
      systemPromptKey: computeSystemPromptKey(systemPromptSettings),
      disallowedToolsKey,
      mcpServersKey: '', // Dynamic via setMcpServers, not tracked for restart
      pluginsKey,
      externalContextPaths: externalContextPaths || [],
      allowedExportPaths: ctx.settings.allowedExportPaths,
      settingSources: ctx.settings.loadUserClaudeSettings ? 'user,project' : 'project',
      claudeCliPath: ctx.cliPath,
      show1MModel: ctx.settings.show1MModel,
    };
  }

  /**
   * Builds SDK options for the persistent query.
   *
   * Persistent queries maintain a long-running connection to Claude,
   * eliminating cold-start latency for follow-up messages.
   */
  static buildPersistentQueryOptions(ctx: PersistentQueryContext): Options {
    const permissionMode = ctx.settings.permissionMode;

    // Resolve model and optional beta flags (e.g., 1M context)
    // If show1MModel is enabled, always include 1M beta to allow model switching without restart
    const resolved = resolveModelWithBetas(ctx.settings.model, ctx.settings.show1MModel);

    // Build system prompt (agents are passed via Options.agents, not system prompt)
    const systemPrompt = buildSystemPrompt({
      mediaFolder: ctx.settings.mediaFolder,
      customPrompt: ctx.settings.systemPrompt,
      allowedExportPaths: ctx.settings.allowedExportPaths,
      vaultPath: ctx.vaultPath,
    });

    const options: Options = {
      cwd: ctx.vaultPath,
      systemPrompt,
      model: resolved.model,
      abortController: ctx.abortController,
      pathToClaudeCodeExecutable: ctx.cliPath,
      settingSources: ctx.settings.loadUserClaudeSettings
        ? ['user', 'project']
        : ['project'],
      env: {
        ...process.env,
        ...ctx.customEnv,
        PATH: ctx.enhancedPath,
      },
      includePartialMessages: true, // Enable streaming
    };

    // Add beta flags if present (e.g., 1M context window)
    if (resolved.betas) {
      options.betas = resolved.betas;
    }

    // Pre-register all disabled MCP tools and hide unsupported SDK tools
    const allDisallowedTools = [
      ...ctx.mcpManager.getAllDisallowedMcpTools(),
      ...UNSUPPORTED_SDK_TOOLS,
    ];
    options.disallowedTools = allDisallowedTools;

    // Add plugins
    const pluginConfigs = ctx.pluginManager.getActivePluginConfigs();
    if (pluginConfigs.length > 0) {
      options.plugins = pluginConfigs;
    }

    // Add custom agents via SDK native support
    QueryOptionsBuilder.applyAgents(options, ctx.agentManager);

    // Set permission mode
    QueryOptionsBuilder.applyPermissionMode(options, permissionMode, ctx.canUseTool);

    // Add thinking budget
    QueryOptionsBuilder.applyThinkingBudget(options, ctx.settings.thinkingBudget);

    // Add hooks
    options.hooks = ctx.hooks;

    // Resume session if provided
    if (ctx.resumeSessionId) {
      options.resume = ctx.resumeSessionId;
    }

    // Add external context paths as additionalDirectories
    if (ctx.externalContextPaths && ctx.externalContextPaths.length > 0) {
      options.additionalDirectories = ctx.externalContextPaths;
    }

    return options;
  }

  /**
   * Builds SDK options for a cold-start query.
   *
   * Cold-start queries are used for:
   * - Inline edit (separate context)
   * - Title generation (lightweight)
   * - Session recovery (interrupted or expired sessions)
   * - When persistent query is not available
   * - When forceColdStart option is set
   */
  static buildColdStartQueryOptions(ctx: ColdStartQueryContext): Options {
    const permissionMode = ctx.settings.permissionMode;

    // Resolve model and optional beta flags (e.g., 1M context)
    // If show1MModel is enabled, always include 1M beta to allow model switching without restart
    const selectedModel = ctx.modelOverride ?? ctx.settings.model;
    const resolved = resolveModelWithBetas(selectedModel, ctx.settings.show1MModel);

    // Build system prompt (agents are passed via Options.agents, not system prompt)
    const systemPrompt = buildSystemPrompt({
      mediaFolder: ctx.settings.mediaFolder,
      customPrompt: ctx.settings.systemPrompt,
      allowedExportPaths: ctx.settings.allowedExportPaths,
      vaultPath: ctx.vaultPath,
    });

    const options: Options = {
      cwd: ctx.vaultPath,
      systemPrompt,
      model: resolved.model,
      abortController: ctx.abortController,
      pathToClaudeCodeExecutable: ctx.cliPath,
      // Load project settings. Optionally load user settings if enabled.
      // Note: User settings (~/.claude/settings.json) may contain permission rules
      // that bypass Claudian's permission system. Skills from ~/.claude/skills/
      // are still discovered regardless (not in settings.json).
      settingSources: ctx.settings.loadUserClaudeSettings
        ? ['user', 'project']
        : ['project'],
      env: {
        ...process.env,
        ...ctx.customEnv,
        PATH: ctx.enhancedPath,
      },
      includePartialMessages: true, // Enable streaming
    };

    // Add beta flags if present (e.g., 1M context window)
    if (resolved.betas) {
      options.betas = resolved.betas;
    }

    // Add MCP servers to options
    const mcpMentions = ctx.mcpMentions || new Set<string>();
    const uiEnabledServers = ctx.enabledMcpServers || new Set<string>();
    const combinedMentions = new Set([...mcpMentions, ...uiEnabledServers]);
    const mcpServers = ctx.mcpManager.getActiveServers(combinedMentions);

    if (Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }

    // Disallow MCP tools from inactive servers and unsupported SDK tools
    const disallowedMcpTools = ctx.mcpManager.getDisallowedMcpTools(combinedMentions);
    options.disallowedTools = [
      ...disallowedMcpTools,
      ...UNSUPPORTED_SDK_TOOLS,
    ];

    // Add plugins
    const pluginConfigs = ctx.pluginManager.getActivePluginConfigs();
    if (pluginConfigs.length > 0) {
      options.plugins = pluginConfigs;
    }

    // Add custom agents via SDK native support
    QueryOptionsBuilder.applyAgents(options, ctx.agentManager);

    // Set permission mode
    QueryOptionsBuilder.applyPermissionMode(options, permissionMode, ctx.canUseTool);

    // Add hooks
    options.hooks = ctx.hooks;

    // Add thinking budget
    QueryOptionsBuilder.applyThinkingBudget(options, ctx.settings.thinkingBudget);

    // Apply tool restriction for cold-start queries
    if (ctx.allowedTools !== undefined && ctx.allowedTools.length > 0) {
      options.tools = ctx.allowedTools;
    }

    // Resume previous session if we have a session ID
    if (ctx.sessionId) {
      options.resume = ctx.sessionId;
    }

    // Add external context paths as additionalDirectories
    if (ctx.externalContextPaths && ctx.externalContextPaths.length > 0) {
      options.additionalDirectories = ctx.externalContextPaths;
    }

    return options;
  }

  /**
   * Gets active MCP servers and their configuration for dynamic updates.
   */
  static getMcpServersConfig(
    mcpManager: McpServerManager,
    mcpMentions?: Set<string>,
    enabledMcpServers?: Set<string>
  ): { servers: Record<string, McpServerConfig>; key: string } {
    const mentions = mcpMentions || new Set<string>();
    const uiEnabled = enabledMcpServers || new Set<string>();
    const combined = new Set([...mentions, ...uiEnabled]);
    const servers = mcpManager.getActiveServers(combined);

    return {
      servers: servers as Record<string, McpServerConfig>,
      key: JSON.stringify(servers),
    };
  }

  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Applies permission mode settings to options.
   *
   * Always sets allowDangerouslySkipPermissions: true to enable dynamic
   * switching between permission modes via setPermissionMode() without
   * requiring a process restart. This mimics Claude Code CLI behavior.
   */
  private static applyPermissionMode(
    options: Options,
    permissionMode: PermissionMode,
    canUseTool?: CanUseTool
  ): void {
    // Always enable bypass capability so we can dynamically switch modes
    options.allowDangerouslySkipPermissions = true;

    if (permissionMode === 'yolo') {
      options.permissionMode = 'bypassPermissions';
    } else {
      options.permissionMode = 'default';
      if (canUseTool) {
        options.canUseTool = canUseTool;
      }
    }
  }

  /**
   * Applies thinking budget settings to options.
   */
  private static applyThinkingBudget(
    options: Options,
    budgetSetting: string
  ): void {
    const budgetConfig = THINKING_BUDGETS.find(b => b.value === budgetSetting);
    if (budgetConfig && budgetConfig.tokens > 0) {
      options.maxThinkingTokens = budgetConfig.tokens;
    }
  }

  /**
   * Compares two path arrays for equality (order-independent).
   */
  private static pathsChanged(a?: string[], b?: string[]): boolean {
    const aKey = [...(a || [])].sort().join('|');
    const bKey = [...(b || [])].sort().join('|');
    return aKey !== bKey;
  }

  /**
   * Applies custom agents to options (filters out built-ins managed by SDK).
   */
  private static applyAgents(options: Options, agentManager?: AgentManager): void {
    const agents = agentManager?.getAvailableAgents().filter(a => a.source !== 'builtin') ?? [];
    if (agents.length > 0) {
      options.agents = QueryOptionsBuilder.buildSdkAgentsRecord(agents);
    }
  }

  /**
   * Converts Claudian agent definitions to SDK format.
   *
   * @param agents - Array of Claudian agent definitions
   * @returns Record of agent ID to SDK agent definition
   */
  private static buildSdkAgentsRecord(
    agents: AgentDefinition[]
  ): Record<string, SdkAgentDefinition> {
    const record: Record<string, SdkAgentDefinition> = {};
    for (const agent of agents) {
      record[agent.id] = {
        description: agent.description,
        prompt: agent.prompt,
        tools: agent.tools,
        disallowedTools: agent.disallowedTools,
        // SDK expects undefined for 'inherit', not the string
        model: agent.model === 'inherit' ? undefined : agent.model,
      };
    }
    return record;
  }
}
