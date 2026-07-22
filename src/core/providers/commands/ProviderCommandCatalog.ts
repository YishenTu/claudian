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
  /** Request-scoped runtime snapshot. Undefined falls back to catalog-owned state. */
  runtimeCommands?: readonly SlashCommand[];
  /** Whether provider-global runtime state may satisfy a request without a snapshot. */
  allowCachedRuntimeCommands?: boolean;
}

export interface ProviderCommandCatalog {
  listDropdownEntries(context: ProviderCommandListContext): Promise<ProviderCommandEntry[]>;
  setRuntimeCommands(commands: SlashCommand[]): void;
  getDropdownConfig(): ProviderCommandDropdownConfig;
  refresh(): Promise<void>;
}
