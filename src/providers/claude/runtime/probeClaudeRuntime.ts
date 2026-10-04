import type {
  Options,
  Query,
  SDKControlInitializeResponse,
} from '@anthropic-ai/claude-agent-sdk';

import { getEnhancedPath, parseEnvironmentVariables } from '@/core/process/env';

import type { ProviderHost } from '../../../core/providers/ProviderHost';
import { throwIfAborted, toAbortError } from '../../../utils/abort';
import { getVaultPath } from '../../../utils/path';
import { loadClaudeAgentQuery } from '../loadClaudeAgentSDK';
import { getClaudeProviderSettings, resolveClaudeSettingSources } from '../settings';
import { createCustomSpawnFunction } from './customSpawn';

const PROBE_CANCELLED = 'Claude Code runtime discovery cancelled';
const PROBE_TIMEOUT_MS = 30_000;
// Session init waits on MCP server startup; cap it so one slow server cannot stall discovery.
const PROBE_MCP_TIMEOUT_MS = '5000';

export type ClaudeLaunchOptions = Required<Pick<
  Options,
  'cwd' | 'pathToClaudeCodeExecutable' | 'env' | 'settingSources' | 'spawnClaudeCodeProcess'
>>;

export interface ClaudeLaunchOptionOverrides {
  /** Settings snapshot that decides Claude setting sources; defaults to the host settings. */
  readonly settings?: Record<string, unknown>;
  /** Environment defaults that the process environment and configured variables override. */
  readonly envDefaults?: Record<string, string>;
}

/** Launch inputs every Claude Code process shares: working folder, executable, environment and settings sources. */
export function buildClaudeLaunchOptions(
  host: Pick<ProviderHost, 'settings' | 'getActiveEnvironmentVariables'>,
  cwd: string,
  cliPath: string,
  overrides: ClaudeLaunchOptionOverrides = {},
): ClaudeLaunchOptions {
  const customEnv = parseEnvironmentVariables(host.getActiveEnvironmentVariables('claude'));
  const enhancedPath = getEnhancedPath(customEnv.PATH, cliPath);
  const { loadUserSettings } = getClaudeProviderSettings(overrides.settings ?? host.settings);
  return {
    cwd,
    pathToClaudeCodeExecutable: cliPath,
    env: { ...overrides.envDefaults, ...process.env, ...customEnv, PATH: enhancedPath },
    settingSources: resolveClaudeSettingSources(loadUserSettings),
    spawnClaudeCodeProcess: createCustomSpawnFunction(enhancedPath),
  };
}

/** No Claude Code process can start: there is no local vault or no resolvable CLI. */
export class ClaudeRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeRuntimeUnavailableError';
  }
}

/**
 * Starts an independent Claude Code process and returns its initialization answer
 * (commands, models, agents, account). An empty prompt makes Claude Code emit
 * session init from local configuration without an inference call.
 */
export async function probeClaudeRuntime(
  host: ProviderHost,
  signal?: AbortSignal,
): Promise<SDKControlInitializeResponse> {
  throwIfAborted(signal, PROBE_CANCELLED);
  const controller = new AbortController();
  const cancel = (): void => controller.abort(signal?.reason);
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = window.setTimeout(
    () => controller.abort(new Error('Claude Code runtime discovery timed out')),
    PROBE_TIMEOUT_MS,
  );
  let conversation: Query | undefined;
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(toAbortError(controller.signal, PROBE_CANCELLED));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const initialize = async (): Promise<SDKControlInitializeResponse> => {
    const cwd = getVaultPath(host.app);
    if (!cwd) throw new ClaudeRuntimeUnavailableError('Claude Code discovery requires a local vault');
    const cliPath = await host.getResolvedProviderCliPath('claude');
    throwIfAborted(controller.signal, PROBE_CANCELLED);
    if (!cliPath) throw new ClaudeRuntimeUnavailableError('Claude Code installation not found');
    const agentQuery = await loadClaudeAgentQuery();
    throwIfAborted(controller.signal, PROBE_CANCELLED);
    const config = getClaudeProviderSettings(host.settings);
    // Match chat launches, which always enable auto mode.
    const extraArgs = {
      'enable-auto-mode': null,
      ...(config.enableChrome ? { chrome: null } : {}),
    };
    conversation = agentQuery({
      prompt: '',
      options: {
        ...buildClaudeLaunchOptions(host, cwd, cliPath, { envDefaults: { MCP_TIMEOUT: PROBE_MCP_TIMEOUT_MS } }),
        extraArgs,
        abortController: controller,
        persistSession: false,
      },
    });
    // Claude Code answers initialize while MCP servers may still be connecting, then pushes
    // `commands_changed` as their prompts arrive. Session init follows MCP startup, and
    // supportedCommands() tracks the latest push, so read commands only after init.
    for (;;) {
      const next = await conversation.next();
      if (next.done) throw new Error('Claude Code runtime discovery ended before initialization');
      if (next.value.type === 'system' && next.value.subtype === 'init') break;
    }
    const [initialization, commands] = await Promise.all([
      conversation.initializationResult(),
      conversation.supportedCommands(),
    ]);
    return { ...initialization, commands };
  };
  try {
    return await Promise.race([initialize(), aborted]);
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', onAbort);
    controller.abort();
    conversation?.close();
  }
}
