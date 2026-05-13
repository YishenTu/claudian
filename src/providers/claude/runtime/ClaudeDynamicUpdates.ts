import type {
  McpServerConfig,
  PermissionMode as SDKPermissionMode,
  Query,
} from '@anthropic-ai/claude-agent-sdk';

import type { McpServerManager } from '../../../core/mcp/McpServerManager';
import type {
  ChatRuntimeQueryOptions,
} from '../../../core/runtime/types';
import type { ClaudianSettings, PermissionMode } from '../../../core/types/settings';
import {
  resolveAdaptiveEffortLevel,
} from '../types/models';
import type {
  ClaudeEnsureReadyOptions,
  ClosePersistentQueryOptions,
  PersistentQueryConfig,
} from './types';

export interface ClaudeDynamicUpdateDeps {
  getPersistentQuery: () => Query | null;
  getCurrentConfig: () => PersistentQueryConfig | null;
  mutateCurrentConfig: (mutate: (config: PersistentQueryConfig) => void) => void;
  getVaultPath: () => string | null;
  getCliPath: () => string | null;
  getScopedSettings: () => ClaudianSettings;
  getPermissionMode: () => PermissionMode;
  resolveSDKPermissionMode: (mode: PermissionMode) => SDKPermissionMode;
  mcpManager: McpServerManager;
  buildPersistentQueryConfig: (
    vaultPath: string,
    cliPath: string,
    externalContextPaths?: string[],
  ) => PersistentQueryConfig;
  needsRestart: (newConfig: PersistentQueryConfig) => boolean;
  ensureReady: (options: ClaudeEnsureReadyOptions) => Promise<boolean>;
  setCurrentExternalContextPaths: (paths: string[]) => void;
  notifyFailure: (message: string) => void;
}

export async function applyClaudeDynamicUpdates(
  deps: ClaudeDynamicUpdateDeps,
  queryOptions?: ChatRuntimeQueryOptions,
  restartOptions?: ClosePersistentQueryOptions,
  allowRestart = true,
): Promise<void> {
  const persistentQuery = deps.getPersistentQuery();
  if (!persistentQuery) {
    return;
  }

  const vaultPath = deps.getVaultPath();
  if (!vaultPath) {
    return;
  }

  const cliPath = deps.getCliPath();
  if (!cliPath) {
    return;
  }

  const settings = deps.getScopedSettings();
  const selectedModel = queryOptions?.model || settings.model;
  const permissionMode = deps.getPermissionMode();

  const currentConfig = deps.getCurrentConfig();
  if (currentConfig && selectedModel !== currentConfig.model) {
    try {
      await persistentQuery.setModel(selectedModel);
      deps.mutateCurrentConfig(config => {
        config.model = selectedModel;
      });
    } catch {
      deps.notifyFailure('Failed to update model');
    }
  }

  const effortLevel = resolveAdaptiveEffortLevel(selectedModel, settings.effortLevel);
  if (effortLevel !== null) {
    const currentEffort = deps.getCurrentConfig()?.effortLevel ?? null;
    if (effortLevel !== currentEffort) {
      try {
        // SDK runtime accepts `max`, but the current type definition for
        // Settings.effortLevel has not caught up yet.
        await persistentQuery.applyFlagSettings({ effortLevel } as unknown as Parameters<Query['applyFlagSettings']>[0]);
        deps.mutateCurrentConfig(config => {
          config.effortLevel = effortLevel;
        });
      } catch {
        deps.notifyFailure('Failed to update effort level');
      }
    }
  } else {
    deps.mutateCurrentConfig(config => {
      config.effortLevel = null;
    });
  }

  const configBeforePermissionUpdate = deps.getCurrentConfig();
  if (configBeforePermissionUpdate) {
    const sdkMode = deps.resolveSDKPermissionMode(permissionMode);
    const currentSdkMode = configBeforePermissionUpdate.sdkPermissionMode ?? null;
    const requiresAutoModeRestart = sdkMode === 'auto' && !configBeforePermissionUpdate.enableAutoMode;
    if (requiresAutoModeRestart) {
      // The Claude Code auto-mode opt-in is a startup flag. The restart path below
      // will rebuild the query with that capability before auto becomes active.
    } else if (sdkMode !== currentSdkMode) {
      try {
        await persistentQuery.setPermissionMode(sdkMode);
        deps.mutateCurrentConfig(config => {
          config.permissionMode = permissionMode;
          config.sdkPermissionMode = sdkMode;
        });
      } catch {
        deps.notifyFailure('Failed to update permission mode');
      }
    } else {
      deps.mutateCurrentConfig(config => {
        config.permissionMode = permissionMode;
        config.sdkPermissionMode = sdkMode;
      });
    }
  }

  const mcpMentions = queryOptions?.mcpMentions || new Set<string>();
  const uiEnabledServers = queryOptions?.enabledMcpServers || new Set<string>();
  const combinedMentions = new Set([...mcpMentions, ...uiEnabledServers]);
  const mcpServers = deps.mcpManager.getActiveServers(combinedMentions);
  const mcpServersKey = JSON.stringify(mcpServers);

  if (deps.getCurrentConfig() && mcpServersKey !== deps.getCurrentConfig()!.mcpServersKey) {
    const serverConfigs: Record<string, McpServerConfig> = {};
    for (const [name, config] of Object.entries(mcpServers)) {
      serverConfigs[name] = config;
    }

    try {
      await persistentQuery.setMcpServers(serverConfigs);
      deps.mutateCurrentConfig(config => {
        config.mcpServersKey = mcpServersKey;
      });
    } catch {
      deps.notifyFailure('Failed to update MCP servers');
    }
  }

  const newExternalContextPaths = queryOptions?.externalContextPaths || [];
  deps.setCurrentExternalContextPaths(newExternalContextPaths);

  if (!allowRestart) {
    return;
  }

  const newConfig = deps.buildPersistentQueryConfig(vaultPath, cliPath, newExternalContextPaths);
  if (!deps.needsRestart(newConfig)) {
    return;
  }

  const restarted = await deps.ensureReady({
    externalContextPaths: newExternalContextPaths,
    preserveHandlers: restartOptions?.preserveHandlers,
    force: true,
  });

  if (restarted && deps.getPersistentQuery()) {
    await applyClaudeDynamicUpdates(deps, queryOptions, restartOptions, false);
  }
}
