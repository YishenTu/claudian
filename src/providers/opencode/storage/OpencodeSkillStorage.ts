import type { HomeFileAdapter } from '../../../core/storage/HomeFileAdapter';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import type { OpencodeSkill } from '../types';

export class OpencodeSkillStorage {
  constructor(
    private vaultAdapter: VaultFileAdapter,
    private homeAdapter: HomeFileAdapter,
  ) {}

  async save(skill: OpencodeSkill): Promise<void> {
  }

  async load(name: string): Promise<OpencodeSkill | null> {
    return null;
  }

  async delete(name: string): Promise<void> {
  }

  async list(): Promise<OpencodeSkill[]> {
    return [];
  }
}
