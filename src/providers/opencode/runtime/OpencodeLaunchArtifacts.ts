import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parse, type ParseError } from 'jsonc-parser';

import { CLAUDIAN_STORAGE_PATH } from '../../../core/bootstrap/storagePaths';
import {
  buildSystemPrompt,
  computeSystemPromptKey,
  type SystemPromptSettings,
} from '../../../core/prompt/mainAgent';
import { expandHomePath } from '../../../utils/path';
import {
  OPENCODE_BUILD_MODE_ID,
  OPENCODE_SAFE_MODE_ID,
  OPENCODE_YOLO_MODE_ID,
} from '../modes';
import { resolveOpencodeDatabasePath } from './OpencodePaths';

export interface OpencodeLaunchArtifacts {
  configPath: string;
  nativeConfigPath: string;
  configContent: string;
  databasePath: string | null;
  launchKey: string;
  systemPromptPath: string;
}

export interface OpencodeManagedAgentConfig {
  definition?: Record<string, unknown>;
  id: string;
}

const DEFAULT_OPENCODE_MANAGED_AGENT_CONFIGS: readonly OpencodeManagedAgentConfig[] = [
  { id: OPENCODE_BUILD_MODE_ID },
  {
    definition: {
      mode: 'primary',
      permission: {
        plan_enter: 'deny',
        question: 'allow',
      },
    },
    id: OPENCODE_YOLO_MODE_ID,
  },
  {
    definition: {
      mode: 'primary',
      permission: {
        plan_enter: 'deny',
        question: 'allow',
        bash: 'ask',
        edit: 'ask',
      },
    },
    id: OPENCODE_SAFE_MODE_ID,
  },
];

export interface PrepareOpencodeLaunchArtifactsParams {
  artifactsSubdir?: string;
  nativeVersion?: 1 | 2;
  defaultAgentId?: string;
  managedAgents?: readonly OpencodeManagedAgentConfig[];
  runtimeEnv: NodeJS.ProcessEnv;
  settings?: SystemPromptSettings;
  dynamicSystemPromptSections?: readonly string[];
  systemPromptKey?: string;
  systemPromptText?: string;
  userName?: string;
  workspaceRoot: string;
}

export async function prepareOpencodeLaunchArtifacts(
  params: PrepareOpencodeLaunchArtifactsParams,
): Promise<OpencodeLaunchArtifacts> {
  const artifactsDir = path.join(
    params.workspaceRoot,
    CLAUDIAN_STORAGE_PATH,
    params.artifactsSubdir ?? 'opencode',
  );
  const systemPromptPath = path.join(artifactsDir, 'system.md');
  const configPath = path.join(artifactsDir, 'config.json');
  const systemPrompt = normalizeSystemPrompt(
    params.systemPromptText ?? buildSystemPrompt(requireSettings(params), {
      dynamicSections: params.dynamicSystemPromptSections
        ? [...params.dynamicSystemPromptSections]
        : undefined,
    }),
  );
  const promptKey = params.systemPromptKey
    ?? (params.systemPromptText !== undefined
      ? params.systemPromptText
      : computeSystemPromptKey(requireSettings(params), {
          dynamicSections: params.dynamicSystemPromptSections
            ? [...params.dynamicSystemPromptSections]
            : undefined,
        }));
  const customConfigPath = resolveOpencodeConfigPath(params.runtimeEnv.OPENCODE_CONFIG, params.workspaceRoot);
  const customConfigText = await readOpencodeConfig(customConfigPath, params.runtimeEnv);
  const inlineConfig = params.runtimeEnv.OPENCODE_CONFIG_CONTENT?.trim();
  const serializeManagedConfig = (config: Record<string, unknown>, promptPath = systemPromptPath): string => `${JSON.stringify(
    buildOpencodeManagedConfig(
      config,
      promptPath,
      params.userName ?? params.settings?.userName,
      params.managedAgents,
      params.defaultAgentId,
      params.nativeVersion,
    ),
    null,
    2,
  )}\n`;
  const fileContent = serializeManagedConfig({});
  // Native configuration layers have their own precedence and merge semantics.
  // Keep inline user settings in memory, separate from the custom file layer.
  // Substituted user text is literal on the next native parse. Only the managed
  // prompt reference still needs native expansion; protect it with a temporary marker.
  const promptMarker = randomUUID();
  const configContent = serializeManagedConfig(inlineConfig
    ? await parseOpencodeConfig(inlineConfig, 'OPENCODE_CONFIG_CONTENT', params.runtimeEnv, params.workspaceRoot)
    : {}, promptMarker)
    .replace(/\{(env|file):/g, '\\u007b$1:')
    .replaceAll(`"\\u007bfile:${promptMarker}}"`, JSON.stringify(`{file:${systemPromptPath}}`));
  const databasePath = resolveOpencodeDatabasePath(params.runtimeEnv);

  await fs.mkdir(artifactsDir, { recursive: true });
  await ensureOpencodeDatabaseDirectory(databasePath);
  await writeIfChanged(systemPromptPath, systemPrompt);
  await writeIfChanged(configPath, fileContent);

  return {
    configPath,
    nativeConfigPath: customConfigPath ?? configPath,
    configContent,
    databasePath,
    launchKey: [
      promptKey,
      customConfigPath ?? '',
      customConfigText ?? '',
      fileContent,
      configContent,
      databasePath ?? '',
      params.runtimeEnv.XDG_DATA_HOME ?? '',
    ].join('::'),
    systemPromptPath,
  };
}

async function ensureOpencodeDatabaseDirectory(databasePath: string | null): Promise<void> {
  if (!databasePath || databasePath === ':memory:') {
    return;
  }

  await fs.mkdir(path.dirname(databasePath), { recursive: true });
}

export function buildOpencodeManagedConfig(
  baseConfig: Record<string, unknown>,
  systemPromptPath: string,
  userName?: string,
  managedAgents: readonly OpencodeManagedAgentConfig[] = DEFAULT_OPENCODE_MANAGED_AGENT_CONFIGS,
  defaultAgentId?: string,
  nativeVersion: 1 | 2 = 1,
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
  const agentConfigs = managedAgents.length > 0
    ? managedAgents
    : DEFAULT_OPENCODE_MANAGED_AGENT_CONFIGS;

  for (const agentConfig of agentConfigs) {
    const existingAgentValue = existingAgents[agentConfig.id];
    const existingAgent = isPlainObject(existingAgentValue)
      ? { ...existingAgentValue }
      : {};
    nextAgents[agentConfig.id] = {
      ...existingAgent,
      ...(isPlainObject(agentConfig.definition) ? agentConfig.definition : {}),
      prompt: `{file:${systemPromptPath}}`,
    };
  }

  nextAgents.plan = {
    ...(isPlainObject(nextAgents.plan) ? nextAgents.plan : {}),
    disable: true,
  };
  config.agent = nextAgents;
  if (nativeVersion === 2) {
    const nativeAgents = isPlainObject(baseConfig.agents) ? { ...baseConfig.agents } : {};
    for (const { id, definition } of agentConfigs) {
      // A native entry replaces the entire migrated legacy entry within a document.
      // Only override an existing native entry; otherwise let OpenCode migrate agent[id].
      const existing = nativeAgents[id];
      if (!isPlainObject(existing)) continue;
      const managed = definition ?? {};
      const permissions = nativePermissionRules(managed.permission);
      nativeAgents[id] = {
        ...existing,
        ...(typeof managed.mode === 'string' ? { mode: managed.mode } : {}),
        system: `{file:${systemPromptPath}}`,
        ...(permissions.length ? { permissions: [
          ...(Array.isArray(existing.permissions) ? existing.permissions as unknown[] : []),
          ...permissions,
        ] } : {}),
      };
    }
    if (isPlainObject(nativeAgents.plan)) {
      nativeAgents.plan = { ...nativeAgents.plan, disabled: true };
    }
    if (Object.keys(nativeAgents).length) config.agents = nativeAgents;
  }
  const trimmedDefaultAgentId = defaultAgentId?.trim();
  if (trimmedDefaultAgentId) {
    config.default_agent = trimmedDefaultAgentId;
  }

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

function resolveOpencodeConfigPath(configuredPath: string | undefined, workspaceRoot: string): string | undefined {
  const trimmedPath = configuredPath?.trim();
  if (!trimmedPath) return undefined;
  const expandedPath = expandHomePath(trimmedPath);
  return path.isAbsolute(expandedPath) ? expandedPath : path.resolve(workspaceRoot, expandedPath);
}

async function readOpencodeConfig(resolvedPath: string | undefined, environment: NodeJS.ProcessEnv): Promise<string | undefined> {
  if (!resolvedPath) return undefined;
  let rawConfig: string;
  try {
    rawConfig = await fs.readFile(resolvedPath, 'utf8');
  } catch {
    throw new Error(`Could not read OpenCode config: ${resolvedPath}`);
  }
  await parseOpencodeConfig(rawConfig, resolvedPath, environment, path.dirname(resolvedPath));
  return rawConfig;
}

async function parseOpencodeConfig(
  content: string,
  source: string,
  environment: NodeJS.ProcessEnv,
  directory: string,
): Promise<Record<string, unknown>> {
  // Native OpenCode substitutes environment, then file expressions before JSONC,
  // including expressions used as unquoted booleans or objects.
  const substituted = content.replace(/\{env:([^}]+)\}/g, (_, name: string) => environment[name] || '');
  let expanded = '';
  let cursor = 0;
  for (const match of substituted.matchAll(/\{file:([^}]+)\}/g)) {
    expanded += substituted.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    const lineStart = substituted.lastIndexOf('\n', match.index - 1) + 1;
    if (substituted.slice(lineStart, match.index).trimStart().startsWith('//')) {
      expanded += match[0];
      continue;
    }
    const nativeHome = (process.platform === 'win32' ? environment.USERPROFILE : environment.HOME) || os.homedir();
    const filePath = match[1].startsWith('~/') ? path.join(nativeHome, match[1].slice(2)) : match[1];
    const referencePath = path.resolve(directory, filePath);
    let fileContent: string;
    try {
      fileContent = await fs.readFile(referencePath, 'utf8');
    } catch {
      throw new Error(`Could not read OpenCode config file reference in ${source}: ${referencePath}`);
    }
    expanded += JSON.stringify(fileContent.trim()).slice(1, -1);
  }
  expanded += substituted.slice(cursor);
  const errors: ParseError[] = [];
  const config: unknown = parse(expanded, errors, { allowTrailingComma: true });
  if (errors.length || !isPlainObject(config)) {
    throw new Error(`Invalid OpenCode config: ${source}. Expected a JSON or JSONC object.`);
  }
  return config;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSystemPrompt(systemPrompt: string): string {
  return systemPrompt.endsWith('\n') ? systemPrompt : `${systemPrompt}\n`;
}

function requireSettings(
  params: PrepareOpencodeLaunchArtifactsParams,
): SystemPromptSettings {
  if (params.settings) {
    return params.settings;
  }

  throw new Error('prepareOpencodeLaunchArtifacts requires settings when no systemPromptText is provided');
}

function nativePermissionRules(value: unknown): Array<{ action: string; resource: string; effect: string }> {
  if (!isPlainObject(value)) return [];
  const aliases: Record<string, string> = { bash: 'shell', task: 'subagent', write: 'edit', patch: 'edit' };
  return Object.entries(value).flatMap(([tool, permissions]) => {
    const action = aliases[tool] ?? tool;
    return Object.entries(isPlainObject(permissions) ? permissions : { '*': permissions })
      .flatMap(([resource, effect]) => effect === 'allow' || effect === 'deny' || effect === 'ask'
        ? [{ action, resource, effect }]
        : []);
  });
}
