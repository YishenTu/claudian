import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { CLAUDIAN_STORAGE_PATH } from '../../../core/bootstrap/StoragePaths';
import {
  buildSystemPrompt,
  computeSystemPromptKey,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';
import { expandHomePath } from '../../../utils/path';
import { resolveOpencodeDatabasePath } from './OpencodePaths';

const OPENCODE_SYSTEM_PROMPT_AGENT_IDS = ['build', 'plan'] as const;

export interface OpencodeLaunchArtifacts {
  configPath: string;
  databasePath: string | null;
  launchKey: string;
  systemPromptPath: string;
}

export interface PrepareOpencodeLaunchArtifactsParams {
  runtimeEnv: NodeJS.ProcessEnv;
  settings: SystemPromptSettings;
  workspaceRoot: string;
}

export async function prepareOpencodeLaunchArtifacts(
  params: PrepareOpencodeLaunchArtifactsParams,
): Promise<OpencodeLaunchArtifacts> {
  const artifactsDir = path.join(params.workspaceRoot, CLAUDIAN_STORAGE_PATH, 'opencode');
  const systemPromptPath = path.join(artifactsDir, 'system.md');
  const configPath = path.join(artifactsDir, 'config.json');
  const systemPrompt = `${buildSystemPrompt(params.settings)}\n`;
  const baseConfig = await loadOpencodeBaseConfig(
    params.runtimeEnv.OPENCODE_CONFIG,
    params.workspaceRoot,
  );
  const config = `${JSON.stringify(
    buildOpencodeManagedConfig(baseConfig, systemPromptPath, params.settings.userName),
    null,
    2,
  )}\n`;
  const databasePath = resolveOpencodeDatabasePath(params.runtimeEnv);

  await fs.mkdir(artifactsDir, { recursive: true });
  await writeIfChanged(systemPromptPath, systemPrompt);
  await writeIfChanged(configPath, config);

  return {
    configPath,
    databasePath,
    launchKey: [
      computeSystemPromptKey(params.settings),
      config,
      databasePath ?? '',
      params.runtimeEnv.OPENCODE_DB ?? '',
      params.runtimeEnv.XDG_DATA_HOME ?? '',
    ].join('::'),
    systemPromptPath,
  };
}

export function buildOpencodeManagedConfig(
  baseConfig: Record<string, unknown>,
  systemPromptPath: string,
  userName?: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    ...baseConfig,
    $schema: typeof baseConfig.$schema === 'string'
      ? baseConfig.$schema
      : 'https://opencode.ai/config.json',
  };
  const existingAgents = isPlainObject(baseConfig.agent)
    ? { ...baseConfig.agent }
    : {};
  const nextAgents: Record<string, unknown> = { ...existingAgents };

  for (const agentId of OPENCODE_SYSTEM_PROMPT_AGENT_IDS) {
    const existingAgent = isPlainObject(existingAgents[agentId])
      ? { ...existingAgents[agentId] }
      : {};
    nextAgents[agentId] = {
      ...existingAgent,
      prompt: `{file:${systemPromptPath}}`,
    };
  }

  config.agent = nextAgents;

  const trimmedUserName = userName?.trim();
  if (trimmedUserName) {
    config.username = trimmedUserName;
  }

  return config;
}

async function writeIfChanged(filePath: string, content: string): Promise<void> {
  try {
    const existing = await fs.readFile(filePath, 'utf-8');
    if (existing === content) {
      return;
    }
  } catch {
    // Missing file; write below.
  }

  await fs.writeFile(filePath, content, 'utf-8');
}

async function loadOpencodeBaseConfig(
  configuredPath: string | undefined,
  workspaceRoot: string,
): Promise<Record<string, unknown>> {
  const trimmedPath = configuredPath?.trim();
  if (!trimmedPath) {
    return {};
  }

  const expandedPath = expandHomePath(trimmedPath);
  const resolvedPath = path.isAbsolute(expandedPath)
    ? expandedPath
    : path.resolve(workspaceRoot, expandedPath);

  try {
    const rawConfig = await fs.readFile(resolvedPath, 'utf8');
    const parsedConfig = JSON.parse(rawConfig) as unknown;
    return isPlainObject(parsedConfig) ? parsedConfig : {};
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
