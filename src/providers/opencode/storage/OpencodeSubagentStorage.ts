import type { HomeFileAdapter } from '../../../core/storage/HomeFileAdapter';
import type { VaultFileAdapter } from '../../../core/storage/VaultFileAdapter';
import type { OpencodeSubagentDefinition } from '../agents/OpencodeAgentMentionProvider';

export interface OpencodeSubagentStorage {
  loadAll(): Promise<OpencodeSubagentDefinition[]>;
  load(id: string): Promise<OpencodeSubagentDefinition | null>;
  save(agent: OpencodeSubagentDefinition): Promise<void>;
  delete(agent: OpencodeSubagentDefinition): Promise<void>;
}

export class OpencodeSubagentStorageImpl implements OpencodeSubagentStorage {
  constructor(
    private vaultAdapter: VaultFileAdapter,
    private homeAdapter: HomeFileAdapter,
  ) {}

  async loadAll(): Promise<OpencodeSubagentDefinition[]> {
    return [];
  }

  async load(_id: string): Promise<OpencodeSubagentDefinition | null> {
    return null;
  }

  async save(_agent: OpencodeSubagentDefinition): Promise<void> {
  }

  async delete(_agent: OpencodeSubagentDefinition): Promise<void> {
  }
}
