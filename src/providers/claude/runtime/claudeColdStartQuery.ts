import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { query as agentQuery } from '@anthropic-ai/claude-agent-sdk';

import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import type ClaudianPlugin from '../../../main';
import { getEnhancedPath, getMissingNodeError, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { extractAssistantText } from '../auxiliary/extractAssistantText';
import { getClaudeProviderSettings } from '../settings';
import {
  resolveAdaptiveEffortLevel,
  resolveThinkingTokens,
} from '../types/models';
import { createCustomSpawnFunction } from './customSpawn';

export interface ColdStartQueryConfig {
  plugin: ClaudianPlugin;
  systemPrompt: string;
  /** Tools available to the model. Omit for SDK default (all tools). */
  tools?: string[];
  hooks?: Options['hooks'];
  /** Override model. Default: provider setting. */
  model?: string;
  /**
   * Thinking configuration override:
   * - undefined: use provider settings (adaptive or budget-based)
   * - { disabled: true }: skip all thinking configuration
   */
  thinking?: { disabled: true };
  /** Default: SDK default (true). */
  persistSession?: boolean;
  resumeSessionId?: string;
  abortController?: AbortController;
  /** Pre-fetched provider settings snapshot. Avoids a redundant fetch when the caller already has one. */
  providerSettings?: Record<string, unknown>;
  /** Called with accumulated text after each chunk. */
  onTextChunk?: (accumulatedText: string) => void;
}

export interface ColdStartQueryResult {
  text: string;
  sessionId: string | null;
}

export async function runColdStartQuery(
  config: ColdStartQueryConfig,
  prompt: string,
): Promise<ColdStartQueryResult> {
  const vaultPath = getVaultPath(config.plugin.app);
  if (!vaultPath) {
    throw new Error('Could not determine vault path');
  }

  const resolvedClaudePath = config.plugin.getResolvedProviderCliPath('claude');
  if (!resolvedClaudePath) {
    throw new Error('Claude CLI not found');
  }

  const customEnv = parseEnvironmentVariables(
    config.plugin.getActiveEnvironmentVariables('claude')
  );
  const enhancedPath = getEnhancedPath(customEnv.PATH, resolvedClaudePath);

  const missingNodeError = getMissingNodeError(resolvedClaudePath, enhancedPath);
  if (missingNodeError) {
    throw new Error(missingNodeError);
  }

  const settings = config.providerSettings
    ?? ProviderSettingsCoordinator.getProviderSettingsSnapshot(
      config.plugin.settings as unknown as Record<string, unknown>,
      'claude',
    );
  const claudeSettings = getClaudeProviderSettings(settings);

  const selectedModel = config.model ?? (settings.model as string);

  const options: Options = {
    cwd: vaultPath,
    systemPrompt: config.systemPrompt,
    model: selectedModel,
    abortController: config.abortController,
    pathToClaudeCodeExecutable: resolvedClaudePath,
    env: {
      ...process.env,
      ...customEnv,
      PATH: enhancedPath,
    },
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: claudeSettings.loadUserSettings
      ? ['user', 'project']
      : ['project'],
    spawnClaudeCodeProcess: createCustomSpawnFunction(enhancedPath),
  };

  if (config.tools !== undefined) {
    options.tools = config.tools;
  }

  if (config.hooks) {
    options.hooks = config.hooks;
  }

  if (config.persistSession === false) {
    options.persistSession = false;
  }

  if (config.resumeSessionId) {
    options.resume = config.resumeSessionId;
  }

  if (!config.thinking?.disabled) {
    const effortLevel = resolveAdaptiveEffortLevel(selectedModel, settings.effortLevel);
    if (effortLevel !== null) {
      options.thinking = { type: 'adaptive' };
      options.effort = effortLevel;
    } else {
      const thinkingTokens = resolveThinkingTokens(selectedModel, settings.thinkingBudget);
      if (thinkingTokens !== null) {
        options.maxThinkingTokens = thinkingTokens;
      }
    }
  }

  const response = agentQuery({ prompt, options });
  let responseText = '';
  let sessionId: string | null = null;

  for await (const message of response) {
    if (config.abortController?.signal.aborted) {
      await response.interrupt();
      throw new Error('Cancelled');
    }

    if (
      message.type === 'system' &&
      message.subtype === 'init' &&
      message.session_id
    ) {
      sessionId = message.session_id;
    }

    const text = extractAssistantText(message);
    if (text) {
      responseText += text;
      config.onTextChunk?.(responseText);
    }
  }

  return { text: responseText, sessionId };
}
