import type {
  Options,
  Query,
  SDKControlInitializeResponse,
} from '@anthropic-ai/claude-agent-sdk';

import { getEnhancedPath, parseEnvironmentVariables } from '@/core/process/env';
import { resolveExecutionTarget, resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import type { ExecutionTarget } from '@/core/process/execution-target/types';
import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';

import type { ProviderRuntimeHost } from '../../../core/providers/ProviderRuntimeHost';
import { throwIfAborted, toAbortError } from '../../../utils/abort';
import { decodeClaudeConfig, resolveClaudeSettingSources } from '../config';
import { loadClaudeAgentQuery } from '../loadClaudeAgentSDK';
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
  readonly executionTarget?: ExecutionTarget;
  /** Environment defaults that the process environment and configured variables override. */
  readonly envDefaults?: Record<string, string>;
}

/** The path generated instructions must expose to Claude's filesystem tools. */
export async function resolveClaudeExecutionWorkingDirectory(
  host: Pick<ProviderRuntimeHost, 'config'>,
  hostWorkingDirectory: string,
): Promise<string> {
  const target = await resolveExecutionTargetAsync({ settings: decodeClaudeConfig(host.config), hostVaultPath: hostWorkingDirectory });
  if (target.method !== 'wsl') return hostWorkingDirectory;
  const targetPath = createExecutionPathMapper(target).toTargetPath(hostWorkingDirectory);
  if (!targetPath) throw new Error('Claude Code cannot map the workspace to its execution target');
  return targetPath;
}

/** Launch inputs every Claude Code process shares: working folder, executable, environment and settings sources. */
export function buildClaudeLaunchOptions(
  host: Pick<ProviderRuntimeHost, 'config' | 'environmentText'>,
  cwd: string,
  cliPath: string,
  overrides: ClaudeLaunchOptionOverrides = {},
): ClaudeLaunchOptions {
  const customEnv = parseEnvironmentVariables(host.environmentText);
  const config = decodeClaudeConfig(host.config);
  const target = overrides.executionTarget ?? resolveExecutionTarget({ settings: config, hostVaultPath: cwd });
  const enhancedPath = target.method === 'wsl' ? (customEnv.PATH ?? '') : getEnhancedPath(customEnv.PATH, cliPath);
  const targetCwd = target.method === 'wsl' ? createExecutionPathMapper(target).toTargetPath(cwd) : cwd;
  if (!targetCwd) throw new Error('Claude Code cannot map the workspace to its execution target');
  const { loadUserSettings } = config;
  return {
    cwd: targetCwd,
    pathToClaudeCodeExecutable: cliPath,
    env: { ...overrides.envDefaults, ...process.env, ...customEnv, ...(target.method === 'wsl' ? {} : { PATH: enhancedPath }) },
    settingSources: resolveClaudeSettingSources(loadUserSettings),
    spawnClaudeCodeProcess: createCustomSpawnFunction(enhancedPath, { target, hostCwd: cwd, environmentText: host.environmentText }),
  };
}

/** Initialization answer plus the skill names that session init reports separately from commands. */
export type ClaudeRuntimeInitialization = SDKControlInitializeResponse & { readonly skills: readonly string[] };

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
  host: ProviderRuntimeHost,
  signal?: AbortSignal,
): Promise<ClaudeRuntimeInitialization> {
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
  const initialize = async (): Promise<ClaudeRuntimeInitialization> => {
    const cwd = host.workingDirectory;
    if (!cwd) throw new ClaudeRuntimeUnavailableError('Claude Code discovery requires a local vault');
    const target = await resolveExecutionTargetAsync({ settings: decodeClaudeConfig(host.config), hostVaultPath: cwd });
    const cliPath = await host.resolveCliPath({ executionTarget: target });
    throwIfAborted(controller.signal, PROBE_CANCELLED);
    if (!cliPath) throw new ClaudeRuntimeUnavailableError('Claude Code installation not found');
    const agentQuery = await loadClaudeAgentQuery();
    throwIfAborted(controller.signal, PROBE_CANCELLED);
    const config = decodeClaudeConfig(host.config);
    // Match chat launches, which always enable auto mode.
    const extraArgs = {
      'enable-auto-mode': null,
      ...(config.enableChrome ? { chrome: null } : {}),
    };
    conversation = agentQuery({
      prompt: '',
      options: {
        ...buildClaudeLaunchOptions(host, cwd, cliPath, { envDefaults: { MCP_TIMEOUT: PROBE_MCP_TIMEOUT_MS }, executionTarget: target }),
        extraArgs,
        abortController: controller,
        persistSession: false,
      },
    });
    // Claude Code answers initialize while MCP servers may still be connecting, then pushes
    // `commands_changed` as their prompts arrive. Session init follows MCP startup, and
    // supportedCommands() tracks the latest push, so read commands only after init.
    let skills: readonly string[];
    for (;;) {
      const next = await conversation.next();
      if (next.done) throw new Error('Claude Code runtime discovery ended before initialization');
      if (next.value.type === 'system' && next.value.subtype === 'init') {
        skills = next.value.skills ?? [];
        break;
      }
    }
    const [initialization, commands] = await Promise.all([
      conversation.initializationResult(),
      conversation.supportedCommands(),
    ]);
    return { ...initialization, commands, skills };
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
