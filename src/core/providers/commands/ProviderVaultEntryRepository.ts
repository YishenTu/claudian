import type { ProviderCommandEntry } from './ProviderCommandEntry';

export interface ProviderVaultEntryRepository {
  listVaultEntries(): Promise<ProviderCommandEntry[]>;
  saveVaultEntry(entry: ProviderCommandEntry): Promise<void>;
  deleteVaultEntry(entry: ProviderCommandEntry): Promise<void>;
}
