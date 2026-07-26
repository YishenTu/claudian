import { Notice } from 'obsidian';

import { NotifiedMutationError } from '../../../core/storage/NotifiedMutationError';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import type {
  ManagedMcpServer,
  McpServerConfig,
} from '../../../core/types';
import { DEFAULT_MCP_SERVER, isValidMcpServerConfig } from '../../../core/types';

export const KIMI_MCP_CONFIG_PATH = '.kimi-code/mcp.json';
const INVALID_MCP_CONFIG_MESSAGE =
  'Failed to update .kimi-code/mcp.json because it contains invalid JSON.';

// Keys Claudian owns inside a server entry; every other kimi-native field
// (timeouts, enabledTools, ...) survives a save.
const ENTRY_VARIANT_KEYS = ['type', 'transport', 'command', 'args', 'env', 'url', 'headers'];
// Transport-specific kimi-native fields that go stale when the variant flips.
const STDIO_ONLY_KEYS = ['cwd', 'executor'];
const REMOTE_ONLY_KEYS = ['bearerTokenEnvVar'];

// Read/write access to the vault-level `.kimi-code/mcp.json`. Kimi reads this
// file natively at process start; entries are translated between kimi's
// `transport` shape and the shared `type` shape, and Claudian-only metadata
// (contextSaving, description) lives in the `_claudian.servers` namespace.
// `enabled` and `disabledTools` map onto kimi-native entry fields.
export class KimiMcpStorage {
  constructor(private adapter: VaultFileAdapter) {}

  async load(): Promise<ManagedMcpServer[]> {
    try {
      if (!(await this.adapter.exists(KIMI_MCP_CONFIG_PATH))) {
        return [];
      }

      const file: unknown = JSON.parse(await this.adapter.read(KIMI_MCP_CONFIG_PATH));
      if (!isRecord(file) || !isRecord(file.mcpServers)) {
        return [];
      }

      const claudianMeta = isRecord(file._claudian) && isRecord(file._claudian.servers)
        ? file._claudian.servers
        : {};
      const servers: ManagedMcpServer[] = [];
      for (const [name, rawEntry] of Object.entries(file.mcpServers)) {
        if (!isValidMcpServerConfig(rawEntry)) {
          continue;
        }
        const entry = rawEntry as unknown as Record<string, unknown>;
        const meta = isRecord(claudianMeta[name]) ? claudianMeta[name] : {};
        servers.push({
          name,
          config: toClaudianConfig(entry),
          enabled: typeof entry.enabled === 'boolean'
            ? entry.enabled
            : DEFAULT_MCP_SERVER.enabled,
          contextSaving: typeof meta.contextSaving === 'boolean'
            ? meta.contextSaving
            : DEFAULT_MCP_SERVER.contextSaving,
          disabledTools: normalizeStringList(entry.disabledTools),
          description: typeof meta.description === 'string' ? meta.description : undefined,
        });
      }
      return servers;
    } catch {
      return [];
    }
  }

  async save(servers: ManagedMcpServer[]): Promise<void> {
    let existing: Record<string, unknown> | null = null;
    if (await this.adapter.exists(KIMI_MCP_CONFIG_PATH)) {
      const raw = await this.adapter.read(KIMI_MCP_CONFIG_PATH);
      try {
        const parsed: unknown = JSON.parse(raw);
        if (isRecord(parsed)) {
          existing = parsed;
        }
      } catch {
        new Notice(INVALID_MCP_CONFIG_MESSAGE);
        throw new NotifiedMutationError(INVALID_MCP_CONFIG_MESSAGE);
      }
    }

    const existingServers: Record<string, unknown> = existing && isRecord(existing.mcpServers)
      ? existing.mcpServers
      : {};
    const mcpServers: Record<string, unknown> = {};
    const claudianServers: Record<string, { contextSaving?: boolean; description?: string }> = {};

    for (const server of servers) {
      const rawExistingEntry: unknown = existingServers[server.name];
      const existingEntry: Record<string, unknown> = isRecord(rawExistingEntry)
        ? rawExistingEntry
        : {};
      mcpServers[server.name] = toKimiEntry(server, existingEntry);

      const meta: { contextSaving?: boolean; description?: string } = {};
      if (server.contextSaving !== DEFAULT_MCP_SERVER.contextSaving) {
        meta.contextSaving = server.contextSaving;
      }
      if (server.description) {
        meta.description = server.description;
      }
      if (Object.keys(meta).length > 0) {
        claudianServers[server.name] = meta;
      }
    }

    const file: Record<string, unknown> = existing ? { ...existing } : {};
    file.mcpServers = mcpServers;

    const existingClaudian = existing && isRecord(existing._claudian)
      ? existing._claudian
      : null;
    if (Object.keys(claudianServers).length > 0) {
      file._claudian = { ...(existingClaudian ?? {}), servers: claudianServers };
    } else if (existingClaudian) {
      const rest = { ...existingClaudian };
      delete rest.servers;
      if (Object.keys(rest).length > 0) {
        file._claudian = rest;
      } else {
        delete file._claudian;
      }
    } else {
      delete file._claudian;
    }

    await this.adapter.write(KIMI_MCP_CONFIG_PATH, JSON.stringify(file, null, 2));
  }
}

function toClaudianConfig(entry: Record<string, unknown>): McpServerConfig {
  if (typeof entry.command === 'string') {
    const args = normalizeStringList(entry.args);
    const env = isStringRecord(entry.env) ? { ...entry.env } : undefined;
    return {
      command: entry.command,
      ...(args ? { args } : {}),
      ...(env ? { env } : {}),
    };
  }

  const headers = isStringRecord(entry.headers) ? { ...entry.headers } : undefined;
  return {
    type: entry.transport === 'sse' ? 'sse' : 'http',
    url: typeof entry.url === 'string' ? entry.url : '',
    ...(headers ? { headers } : {}),
  };
}

function toKimiEntry(
  server: ManagedMcpServer,
  existingEntry: Record<string, unknown>,
): Record<string, unknown> {
  const entry: Record<string, unknown> = { ...existingEntry };
  for (const key of ENTRY_VARIANT_KEYS) {
    delete entry[key];
  }

  const config = server.config;
  if ('command' in config && typeof config.command === 'string') {
    for (const key of REMOTE_ONLY_KEYS) {
      delete entry[key];
    }
    entry.transport = 'stdio';
    entry.command = config.command;
    if (config.args && config.args.length > 0) {
      entry.args = [...config.args];
    }
    if (config.env && Object.keys(config.env).length > 0) {
      entry.env = { ...config.env };
    }
  } else if ('url' in config && typeof config.url === 'string') {
    for (const key of STDIO_ONLY_KEYS) {
      delete entry[key];
    }
    entry.transport = config.type === 'sse' ? 'sse' : 'http';
    entry.url = config.url;
    if (config.headers && Object.keys(config.headers).length > 0) {
      entry.headers = { ...config.headers };
    }
  }

  if (server.enabled !== DEFAULT_MCP_SERVER.enabled) {
    entry.enabled = server.enabled;
  } else {
    delete entry.enabled;
  }

  const disabledTools = server.disabledTools
    ?.map((tool) => tool.trim())
    .filter((tool) => tool.length > 0);
  if (disabledTools && disabledTools.length > 0) {
    entry.disabledTools = disabledTools;
  } else {
    delete entry.disabledTools;
  }

  return entry;
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.filter((entry): entry is string => typeof entry === 'string');
  return normalized.length > 0 ? normalized : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}
