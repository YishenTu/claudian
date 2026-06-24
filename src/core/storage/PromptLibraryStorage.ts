import { PROMPTS_PATH } from '../bootstrap/StoragePaths';
import type { VaultFileAdapter } from './VaultFileAdapter';

export interface StoredPrompt {
  id: string;
  name: string;
  content: string;
  updatedAt: number;
}

export function isStoredPrompt(value: unknown): value is StoredPrompt {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string'
    && typeof v.name === 'string'
    && typeof v.content === 'string'
    && typeof v.updatedAt === 'number';
}

export class PromptLibraryStorage {
  constructor(private adapter: VaultFileAdapter) {}

  async load(): Promise<StoredPrompt[]> {
    if (!(await this.adapter.exists(PROMPTS_PATH))) return [];
    try {
      const raw = await this.adapter.read(PROMPTS_PATH);
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isStoredPrompt);
    } catch {
      return [];
    }
  }

  async save(prompts: StoredPrompt[]): Promise<void> {
    const clean = prompts.filter(isStoredPrompt);
    await this.adapter.write(PROMPTS_PATH, JSON.stringify(clean, null, 2));
  }
}
