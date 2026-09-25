import type { Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { throwIfAborted, toAbortError } from '../../../utils/abort';
import { getEnhancedPath, parseEnvironmentVariables } from '../../../utils/env';
import { getVaultPath } from '../../../utils/path';
import { loadClaudeAgentQuery } from '../loadClaudeAgentSDK';
import { type ClaudeDiscoveredModel, decodeClaudeModels } from '../modelCatalog';
import { getClaudeProviderSettings, resolveClaudeSettingSources } from '../settings';
import { createCustomSpawnFunction } from './customSpawn';

/** Initialize an independent SDK process without submitting an inference turn. */
export async function probeClaudeModels(
  host: ProviderHost,
  signal?: AbortSignal,
): Promise<ClaudeDiscoveredModel[]> {
  throwIfAborted(signal, 'Claude model discovery cancelled');
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = window.setTimeout(() => controller.abort(new Error('Claude model discovery timed out')), 30_000);
  let conversation: Query | undefined;
  let onAbort: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(toAbortError(controller.signal, 'Claude model discovery cancelled'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const discover = async (): Promise<ClaudeDiscoveredModel[]> => {
    const cwd = getVaultPath(host.app);
    if (!cwd) throw new Error('Claude model discovery requires a local vault');
    const cliPath = await host.getResolvedProviderCliPath('claude');
    throwIfAborted(controller.signal, 'Claude model discovery cancelled');
    if (!cliPath) throw new Error('Claude Code installation not found');
    const agentQuery = await loadClaudeAgentQuery();
    throwIfAborted(controller.signal, 'Claude model discovery cancelled');
    const customEnv = parseEnvironmentVariables(host.getActiveEnvironmentVariables('claude'));
    const enhancedPath = getEnhancedPath(customEnv.PATH, cliPath);
    const config = getClaudeProviderSettings(host.settings);
    // eslint-disable-next-line require-yield -- Discovery initializes the SDK without sending a user message.
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      if (!controller.signal.aborted) {
        await new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }));
      }
    }
    conversation = agentQuery({
      prompt: prompt(),
      options: {
        cwd,
        pathToClaudeCodeExecutable: cliPath,
        env: { MCP_TIMEOUT: '5000', ...process.env, ...customEnv, PATH: enhancedPath },
        settingSources: resolveClaudeSettingSources(config.loadUserSettings),
        abortController: controller,
        spawnClaudeCodeProcess: createCustomSpawnFunction(enhancedPath),
        persistSession: false,
      },
    });
    const models = await conversation.supportedModels();
    return decodeClaudeModels(models.map(model => ({
      value: model.value,
      resolvedModel: model.resolvedModel,
      label: model.displayName,
      description: model.description,
      supportedEffortLevels: model.supportedEffortLevels,
    })));
  };
  try {
    return await Promise.race([discover(), aborted]);
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort!);
    controller.abort();
    conversation?.close();
  }
}
