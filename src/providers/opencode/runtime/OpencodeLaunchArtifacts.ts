import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse, type ParseError } from 'jsonc-parser';

import { CLAUDIAN_STORAGE_PATH } from '../../../core/bootstrap/storagePaths';
import { expandHomePath } from '../../../utils/path';
import type { OpencodeExecutionProfile } from '../execution/OpencodeSessionContract';
import { AUX_AGENT_IDS, buildAgentConfig, OPENCODE_BUILD_AGENT_ID } from './OpencodeExecutionAgents';
import { resolveOpencodeDatabasePath } from './OpencodePaths';

export interface OpencodeLaunchArtifacts {
  configPath: string;
  nativeConfigPath: string;
  configContent: string;
  databasePath: string | null;
  launchKey: string;
}

export interface OpencodeManagedAgentConfig {
  definition?: Record<string, unknown>;
  id: string;
  /** Literal caller-resolved instructions; agents without them keep OpenCode's native prompt selection. */
  prompt?: string;
}

const DEFAULT_OPENCODE_MANAGED_AGENT_CONFIGS: readonly OpencodeManagedAgentConfig[] = [
  { id: OPENCODE_BUILD_AGENT_ID },
];

export interface PrepareOpencodeLaunchArtifactsParams {
  sessionToolsPluginPath?: string;
  profile?: OpencodeExecutionProfile;
  nativeVersion?: 1 | 2;
  runtimeEnv: NodeJS.ProcessEnv;
  /**
   * Caller-resolved instructions for the launched profile, inlined into this process's config only.
   * Launches whose sessions register their own instructions omit it.
   */
  systemPromptText?: string;
  workspaceRoot: string;
}

export async function prepareOpencodeLaunchArtifacts(
  params: PrepareOpencodeLaunchArtifactsParams,
): Promise<OpencodeLaunchArtifacts> {
  const artifactsDir = path.join(params.workspaceRoot, CLAUDIAN_STORAGE_PATH, 'opencode');
  const profile = params.profile ?? 'managed';
  const launchedAgentId = profile === 'managed' ? OPENCODE_BUILD_AGENT_ID : AUX_AGENT_IDS[profile];
  const configPath = path.join(artifactsDir, 'config.json');
  const customConfigPath = resolveOpencodeConfigPath(params.runtimeEnv.OPENCODE_CONFIG, params.workspaceRoot);
  const customConfigText = await readOpencodeConfig(customConfigPath, params.runtimeEnv);
  const inlineConfig = params.runtimeEnv.OPENCODE_CONFIG_CONTENT?.trim();
  const serializeManagedConfig = (
    config: Record<string, unknown>,
    defaultAgentId = OPENCODE_BUILD_AGENT_ID,
    prompt?: string,
  ): string => `${JSON.stringify(buildOpencodeManagedConfig(
    config,
    [...DEFAULT_OPENCODE_MANAGED_AGENT_CONFIGS, buildAgentConfig('readonly'), buildAgentConfig('passive')]
      .map(agent => prompt !== undefined && agent.id === launchedAgentId ? { ...agent, prompt } : agent),
    defaultAgentId,
    params.nativeVersion,
  ), null, 2)}\n`;
  // The shared file is loaded by every process, so it never carries instructions.
  const fileContent = serializeManagedConfig({});
  const managedBase = inlineConfig
    ? await parseOpencodeConfig(inlineConfig, 'OPENCODE_CONFIG_CONTENT', params.runtimeEnv, params.workspaceRoot)
    : {};
  if (params.nativeVersion === 2 && params.sessionToolsPluginPath) {
    managedBase.plugins = [
      ...(Array.isArray(managedBase.plugins) ? managedBase.plugins as unknown[] : []),
      { package: pathToFileURL(params.sessionToolsPluginPath).href },
    ];
  }
  // Preserve native user layers and caller instructions literally, protecting
  // substituted text from native expansion a second time.
  const configContent = serializeManagedConfig(managedBase, launchedAgentId, params.systemPromptText)
    .replace(/\{(env|file):/g, '\\u007b$1:');
  const databasePath = resolveOpencodeDatabasePath(params.runtimeEnv);

  await fs.mkdir(artifactsDir, { recursive: true });
  await ensureOpencodeDatabaseDirectory(databasePath);
  // Earlier versions wrote per-profile prompt files here; nothing references them anymore.
  await fs.rm(path.join(artifactsDir, 'prompts'), { recursive: true, force: true });
  await writeIfChanged(configPath, fileContent);

  return {
    configPath,
    nativeConfigPath: customConfigPath ?? configPath,
    configContent,
    databasePath,
    launchKey: [
      customConfigPath ?? '',
      customConfigText ?? '',
      fileContent,
      configContent,
      databasePath ?? '',
      params.runtimeEnv.XDG_DATA_HOME ?? '',
    ].join('::'),
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
      ...(agentConfig.prompt === undefined ? {} : { prompt: agentConfig.prompt }),
    };
  }

  nextAgents.plan = {
    ...(isPlainObject(nextAgents.plan) ? nextAgents.plan : {}),
    disable: true,
  };
  config.agent = nextAgents;
  if (nativeVersion === 2) {
    const nativeAgents = isPlainObject(baseConfig.agents) ? { ...baseConfig.agents } : {};
    for (const { id, definition, prompt } of agentConfigs) {
      // A native entry replaces the entire migrated legacy entry within a document.
      // Only override an existing native entry; otherwise let OpenCode migrate agent[id].
      const existing = nativeAgents[id];
      if (!isPlainObject(existing)) continue;
      const managed = definition ?? {};
      const permissions = nativePermissionRules(managed.permission);
      nativeAgents[id] = {
        ...existing,
        ...(typeof managed.mode === 'string' ? { mode: managed.mode } : {}),
        ...(prompt === undefined ? {} : { system: prompt }),
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

  return config;
}

const pendingFileWrites = new Map<string, Promise<void>>();

export async function writeIfChanged(filePath: string, content: string): Promise<void> {
  // Serialize launches in this plugin so each compares against the latest completed write.
  const previous = pendingFileWrites.get(filePath) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => writeFileIfChanged(filePath, content));
  pendingFileWrites.set(filePath, pending);
  try {
    await pending;
  } finally {
    if (pendingFileWrites.get(filePath) === pending) pendingFileWrites.delete(filePath);
  }
}

async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    if (await fs.readFile(filePath, 'utf-8') === content) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, content, 'utf-8');
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export function resolveOpencodeConfigPath(configuredPath: string | undefined, workspaceRoot: string): string | undefined {
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

export async function parseOpencodeConfig(
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
