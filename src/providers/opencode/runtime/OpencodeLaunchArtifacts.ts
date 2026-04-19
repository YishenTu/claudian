import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  buildSystemPrompt,
  computeSystemPromptKey,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';
import { resolveOpencodeDatabasePath } from './OpencodePaths';

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
  const artifactsDir = path.join(params.workspaceRoot, '.context', 'opencode');
  const systemPromptPath = path.join(artifactsDir, 'system.md');
  const configPath = path.join(artifactsDir, 'config.json');
  const systemPrompt = `${buildSystemPrompt(params.settings)}\n`;
  const config = `${JSON.stringify(buildOpencodeManagedConfig(systemPromptPath, params.settings.userName), null, 2)}\n`;
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
  systemPromptPath: string,
  userName?: string,
): Record<string, unknown> {
  const config: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    agent: {
      build: {
        prompt: `{file:${systemPromptPath}}`,
      },
    },
    default_agent: 'build',
  };

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
