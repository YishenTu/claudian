import type { SlashCommand } from '../../types';
import type { ProviderId } from '../types';
import type { ProviderCommandEntry } from './ProviderCommandEntry';

export interface ProviderCommandDropdownConfig {
  providerId: ProviderId;
  triggerChars: string[];
  builtInPrefix: string;
  skillPrefix: string;
  commandPrefix: string;
  /** Fetch current entries on each picker opening; filtering retains the open snapshot. */
  refreshOnOpen?: boolean;
  /**
   * Discovery deadline in milliseconds. Omitted uses the shared picker deadline;
   * 'provider-owned' means the provider bounds discovery itself.
   */
  discoveryTimeoutMs?: number | 'provider-owned';
}

export interface ProviderCommandListContext {
  includeBuiltIns: boolean;
  /** Cancels provider-owned work when the requesting discovery is abandoned. */
  signal?: AbortSignal;
  /** What a live session or command loader reported; the catalog lists exactly these. Undefined lets the catalog discover. */
  commandSnapshot?: readonly SlashCommand[];
}

export interface ProviderCommandCatalog {
  listDropdownEntries(context: ProviderCommandListContext): Promise<ProviderCommandEntry[]>;
  getDropdownConfig(): ProviderCommandDropdownConfig;
  refresh(): Promise<void>;
}
