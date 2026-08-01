import type { SlashCommand } from '../../types';
import type { ProviderId } from '../types';
import type { ProviderCommandEntry } from './ProviderCommandEntry';

export interface ProviderCommandDropdownConfig {
  providerId: ProviderId;
  triggerChars: string[];
  builtInPrefix: string;
  skillPrefix: string;
  commandPrefix: string;
}

export interface ProviderCommandListContext {
  includeBuiltIns: boolean;
  /** Cancels provider-owned work when the requesting discovery is abandoned. */
  signal?: AbortSignal;
  /** Request-scoped provider command snapshot. Undefined falls back to catalog-owned state. */
  commandSnapshot?: readonly SlashCommand[];
  /** Whether provider-global command state may satisfy a request without a snapshot. */
  allowCachedCommandSnapshot?: boolean;
}

export interface ProviderCommandCatalog {
  listDropdownEntries(context: ProviderCommandListContext): Promise<ProviderCommandEntry[]>;
  setCommandSnapshot(commands: SlashCommand[]): void;
  getDropdownConfig(): ProviderCommandDropdownConfig;
  refresh(): Promise<void>;
}
