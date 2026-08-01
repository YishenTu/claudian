import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { ProviderSettingsCoordinator } from '../../../core/providers/ProviderSettingsCoordinator';
import { getEnhancedPath, getMissingNodeError, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { extractAssistantText } from '../auxiliary/extractAssistantText';
import { loadClaudeAgentQuery } from '../loadClaudeAgentSdk';
import { toClaudeRuntimeModelId } from '../modelSelection';
import {
  getClaudeProviderSettings,
  resolveClaudeSettingSources,
} from '../settings';
import {
  resolveEffortLevel,
} from '../types/models';
import { createCustomSpawnFunction } from './customSpawn';

export interface ColdStartQueryConfig {
  plugin: ProviderHost;
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

/**
 * Provider-execution path. The caller has already resolved the complete
 * native options and prompt, while this helper retains cold-start query
 * ownership and iteration semantics.
 */
export interface PreparedColdStartQueryConfig {
  options: Options;
  prompt: string | AsyncIterable<SDKUserMessage>;
  onQuery?: (query: Query) => void;
  onMessage?: (message: SDKMessage) => void | Promise<void>;
  stopAfterResult?: boolean;
}

export interface ColdStartQueryResult {
  text: string;
  sessionId: string | null;
}

export function runColdStartQuery(
  config: ColdStartQueryConfig,
  prompt: string,
): Promise<ColdStartQueryResult>;
export function runColdStartQuery(
  config: PreparedColdStartQueryConfig,
): Promise<ColdStartQueryResult>;
export async function runColdStartQuery(
  config: ColdStartQueryConfig | PreparedColdStartQueryConfig,
  prompt?: string,
): Promise<ColdStartQueryResult> {
  if (isPreparedColdStartQueryConfig(config)) {
    return await runPreparedColdStartQuery(config);
  }
  const vaultPath = getVaultPath(config.plugin.app);
  if (!vaultPath) {
    throw new Error('Could not determine vault path');
  }

  const resolvedClaudePath = await config.plugin.getResolvedProviderCliPath('claude');
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
      config.plugin.settings,
      'claude',
    );
  const claudeSettings = getClaudeProviderSettings(settings);

  const selectedModel = toClaudeRuntimeModelId(config.model ?? (settings.model as string));

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
    settingSources: resolveClaudeSettingSources(claudeSettings.loadUserSettings),
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

  if (claudeSettings.safeMode === 'auto') {
    options.extraArgs = { ...options.extraArgs, 'enable-auto-mode': null };
  }

  if (!config.thinking?.disabled) {
    const effortLevel = resolveEffortLevel(selectedModel, settings.effortLevel);
    options.thinking = { type: 'adaptive' };
    // SDK runtime accepts `xhigh` on Opus 4.7+, Sonnet 5+, and Fable, and silently
    // falls back to `high` elsewhere, but its type definition lags our local EffortLevel.
    options.effort = effortLevel;
  }

  const agentQuery = await loadClaudeAgentQuery();
  if (config.abortController?.signal.aborted) {
    throw new Error('Cancelled');
  }
  const response = agentQuery({ prompt: prompt ?? '', options });
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

async function runPreparedColdStartQuery(
  execution: PreparedColdStartQueryConfig,
): Promise<ColdStartQueryResult> {
  const agentQuery = await loadClaudeAgentQuery();
  execution.options.abortController?.signal.throwIfAborted();
  const response = agentQuery({
    prompt: execution.prompt,
    options: execution.options,
  });
  execution.onQuery?.(response);
  let responseText = '';
  let sessionId: string | null = null;

  for await (const message of response) {
    await execution.onMessage?.(message);
    if (
      message.type === 'system'
      && message.subtype === 'init'
      && message.session_id
    ) {
      sessionId = message.session_id;
    }
    const text = extractAssistantText(message);
    if (text) {
      responseText += text;
    }
    if (execution.stopAfterResult && message.type === 'result') {
      break;
    }
  }

  return {
    text: responseText,
    sessionId,
  };
}

function isPreparedColdStartQueryConfig(
  config: ColdStartQueryConfig | PreparedColdStartQueryConfig,
): config is PreparedColdStartQueryConfig {
  return 'options' in config && 'prompt' in config;
}
