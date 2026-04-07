import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import {
  CODEX_SUBAGENT_KNOWN_KEYS,
  type CodexSubagentDefinition,
} from '../types/subagent';

export const CODEX_AGENTS_PATH = '.codex/agents';
const SUBAGENT_PERSISTENCE_PREFIX = 'codex-subagent';

export interface CodexSubagentLocation {
  fileName: string;
}

export function createCodexSubagentPersistenceKey(
  location: CodexSubagentLocation,
): string {
  return `${SUBAGENT_PERSISTENCE_PREFIX}:${encodeURIComponent(location.fileName)}`;
}

export function parseCodexSubagentPersistenceKey(
  persistenceKey?: string,
): CodexSubagentLocation | null {
  if (!persistenceKey) {
    return null;
  }

  if (persistenceKey.startsWith(`${CODEX_AGENTS_PATH}/`) && persistenceKey.endsWith('.toml')) {
    return { fileName: persistenceKey.slice(CODEX_AGENTS_PATH.length + 1) };
  }

  const [prefix, encodedFileName] = persistenceKey.split(':');
  if (prefix !== SUBAGENT_PERSISTENCE_PREFIX || !encodedFileName) {
    return null;
  }

  const fileName = decodeURIComponent(encodedFileName);
  return fileName.endsWith('.toml') ? { fileName } : null;
}

export class CodexSubagentStorage {
  constructor(
    private vaultAdapter: Pick<VaultFileAdapter, 'exists' | 'read' | 'write' | 'delete' | 'listFiles' | 'ensureFolder'>,
  ) {}

  async loadAll(): Promise<CodexSubagentDefinition[]> {
    return this.scanAdapter(this.vaultAdapter);
  }

  async load(agent: CodexSubagentDefinition): Promise<CodexSubagentDefinition | null> {
    const filePath = this.resolveCurrentPath(agent);
    try {
      if (!(await this.vaultAdapter.exists(filePath))) return null;
      const content = await this.vaultAdapter.read(filePath);
      return parseSubagentToml(content, filePath);
    } catch {
      return null;
    }
  }

  async save(agent: CodexSubagentDefinition, previous?: CodexSubagentDefinition | null): Promise<void> {
    const filePath = this.resolveTargetPath(agent, previous);
    const previousPath = previous ? this.resolveCurrentPath(previous) : null;
    await this.vaultAdapter.ensureFolder(CODEX_AGENTS_PATH);
    const content = serializeSubagentToml(agent);
    await this.vaultAdapter.write(filePath, content);

    if (previousPath && previousPath !== filePath) {
      await this.vaultAdapter.delete(previousPath);
    }
  }

  async delete(agent: CodexSubagentDefinition): Promise<void> {
    const filePath = this.resolveCurrentPath(agent);
    await this.vaultAdapter.delete(filePath);
  }

  private resolveCurrentPath(agent: CodexSubagentDefinition): string {
    const persistedLocation = parseCodexSubagentPersistenceKey(agent.persistenceKey);
    if (persistedLocation) {
      return `${CODEX_AGENTS_PATH}/${persistedLocation.fileName}`;
    }

    return `${CODEX_AGENTS_PATH}/${agent.name}.toml`;
  }

  private resolveTargetPath(
    agent: CodexSubagentDefinition,
    previous?: CodexSubagentDefinition | null,
  ): string {
    if (previous && previous.name === agent.name) {
      return this.resolveCurrentPath(previous);
    }

    return `${CODEX_AGENTS_PATH}/${agent.name}.toml`;
  }

  private async scanAdapter(
    adapter: Pick<VaultFileAdapter, 'read' | 'listFiles'>,
  ): Promise<CodexSubagentDefinition[]> {
    const results: CodexSubagentDefinition[] = [];

    try {
      const files = await adapter.listFiles(CODEX_AGENTS_PATH);
      for (const filePath of files) {
        if (!filePath.endsWith('.toml')) continue;
        try {
          const content = await adapter.read(filePath);
          const agent = parseSubagentToml(content, filePath);
          if (agent) results.push(agent);
        } catch {
          // Skip malformed files
        }
      }
    } catch {
      // Directory doesn't exist yet
    }

    return results;
  }
}

export function parseSubagentToml(
  content: string,
  filePath: string,
): CodexSubagentDefinition | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(content) as Record<string, unknown>;
  } catch {
    return null;
  }

  const name = typeof parsed.name === 'string' ? parsed.name : undefined;
  const description =
    typeof parsed.description === 'string' ? parsed.description : undefined;
  const developerInstructions =
    typeof parsed.developer_instructions === 'string'
      ? parsed.developer_instructions
      : undefined;

  if (!name || !description || !developerInstructions) return null;

  const result: CodexSubagentDefinition = {
    name,
    description,
    developerInstructions,
    persistenceKey: createCodexSubagentPersistenceKey({
      fileName: filePath.startsWith(`${CODEX_AGENTS_PATH}/`)
        ? filePath.slice(CODEX_AGENTS_PATH.length + 1)
        : filePath.split('/').pop() ?? filePath,
    }),
  };

  if (typeof parsed.model === 'string') {
    result.model = parsed.model;
  }
  if (typeof parsed.model_reasoning_effort === 'string') {
    result.modelReasoningEffort = parsed.model_reasoning_effort;
  }
  if (typeof parsed.sandbox_mode === 'string') {
    result.sandboxMode = parsed.sandbox_mode;
  }
  if (Array.isArray(parsed.nickname_candidates)) {
    const candidates = parsed.nickname_candidates.filter(
      (v): v is string => typeof v === 'string',
    );
    if (candidates.length > 0) result.nicknameCandidates = candidates;
  }

  const extraFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!CODEX_SUBAGENT_KNOWN_KEYS.has(key)) {
      extraFields[key] = value;
    }
  }
  if (Object.keys(extraFields).length > 0) {
    result.extraFields = extraFields;
  }

  return result;
}

export function serializeSubagentToml(agent: CodexSubagentDefinition): string {
  const doc: Record<string, unknown> = {
    name: agent.name,
    description: agent.description,
    developer_instructions: agent.developerInstructions,
  };

  if (agent.nicknameCandidates && agent.nicknameCandidates.length > 0) {
    doc.nickname_candidates = agent.nicknameCandidates;
  }
  if (agent.model) {
    doc.model = agent.model;
  }
  if (agent.modelReasoningEffort) {
    doc.model_reasoning_effort = agent.modelReasoningEffort;
  }
  if (agent.sandboxMode) {
    doc.sandbox_mode = agent.sandboxMode;
  }

  if (agent.extraFields) {
    for (const [key, value] of Object.entries(agent.extraFields)) {
      doc[key] = value;
    }
  }

  return stringifyToml(doc);
}
