import type {
  AgentInfo,
  Options as QoderOptions,
  Query,
  SlashCommand as QoderSlashCommand,
} from '@qoder-ai/qoder-agent-sdk';

import { getRuntimeEnvironmentVariables } from '../../../core/providers/providerEnvironment';
import type { ProviderHost } from '../../../core/providers/ProviderHost';
import type { SlashCommand } from '../../../core/types';
import { getVaultPath } from '../../../utils/path';
import { decodeQoderModelId, normalizeQoderModelInfoList } from '../models';
import { getQoderProviderSettings } from '../settings';
import type { QoderRuntimeSnapshot } from '../types';
import { getLoadedQoderSdk, loadQoderQuery } from './loadQoderSdk';
import type { QoderCliResolver } from './QoderCliResolver';

const QODER_ACCESS_TOKEN_ENV = 'QODER_PERSONAL_ACCESS_TOKEN';

export interface QoderBaseOptionsContext {
  cliResolver: QoderCliResolver;
  model?: string | null;
  plugin: ProviderHost;
  reasoningEffort?: string | null;
}

export function buildQoderBaseOptions(
  context: QoderBaseOptionsContext,
): QoderOptions {
  const settings = context.plugin.settings as unknown as Record<string, unknown>;
  const providerSettings = getQoderProviderSettings(settings);
  const env = getRuntimeEnvironmentVariables(settings, 'qoder');
  const cliPath = context.cliResolver.resolveFromSettings(settings);
  const model = decodeQoderModelId(context.model ?? '') ?? undefined;
  const reasoningEffort = context.reasoningEffort?.trim() || undefined;

  return {
    auth: resolveQoderAuth(providerSettings.authMode, env),
    cwd: getVaultPath(context.plugin.app) ?? process.cwd(),
    enableFileCheckpointing: providerSettings.checkpointingEnabled,
    env,
    includePartialMessages: true,
    ...(cliPath ? { pathToQoderCLIExecutable: cliPath } : {}),
    ...(model ? { model } : {}),
    // Reasoning effort is per-request policy: the SDK forwards `parameters`
    // verbatim to the CLI only through pull-mode `resolveModel`.
    ...(model && reasoningEffort
      ? { resolveModel: () => ({ model, parameters: { reasoningEffort } }) }
      : {}),
  };
}

export async function collectQoderRuntimeSnapshot(
  context: QoderBaseOptionsContext,
): Promise<QoderRuntimeSnapshot> {
  const queryFactory = await loadQoderQuery();
  const q = queryFactory({
    prompt: 'Return OK.',
    options: {
      ...buildQoderBaseOptions(context),
    },
  });

  try {
    const [init, models, commands, agents] = await Promise.all([
      q.initializationResult(),
      q.getAvailableModels({ fetchStrategy: 'live' }),
      q.supportedCommands(),
      q.supportedAgents(),
    ]);

    return {
      agents,
      commands: commands.map(normalizeQoderSlashCommand),
      models: normalizeQoderModelInfoList(models),
      skills: normalizeQoderSkills(init.skills),
    };
  } finally {
    await q.close();
  }
}

export async function collectQoderModels(
  context: QoderBaseOptionsContext,
): Promise<ReturnType<typeof normalizeQoderModelInfoList>> {
  return (await collectQoderRuntimeSnapshot(context)).models;
}

export async function collectQoderCommands(
  context: QoderBaseOptionsContext,
): Promise<SlashCommand[]> {
  return (await collectQoderRuntimeSnapshot(context)).commands;
}

export async function collectQoderAgents(
  context: QoderBaseOptionsContext,
): Promise<AgentInfo[]> {
  return (await collectQoderRuntimeSnapshot(context)).agents;
}

export async function closeQoderQuery(query: Query | null): Promise<void> {
  if (!query) {
    return;
  }

  try {
    await query.close();
  } catch {
    // Ignore cleanup failures.
  }
}

function resolveQoderAuth(
  authMode: 'auto' | 'pat-env' | 'qodercli',
  env: Record<string, string>,
) {
  const { accessTokenFromEnv, qodercliAuth } = getLoadedQoderSdk();
  if (authMode === 'pat-env') {
    return accessTokenFromEnv(QODER_ACCESS_TOKEN_ENV);
  }
  if (authMode === 'qodercli') {
    return qodercliAuth();
  }
  return env[QODER_ACCESS_TOKEN_ENV]?.trim()
    ? accessTokenFromEnv(QODER_ACCESS_TOKEN_ENV)
    : qodercliAuth();
}

function normalizeQoderSlashCommand(command: QoderSlashCommand): SlashCommand {
  return {
    argumentHint: command.argumentHint,
    content: '',
    description: command.description,
    id: `qoder:${command.name}`,
    kind: 'command',
    name: command.name,
    source: 'sdk',
  };
}

function normalizeQoderSkills(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}
