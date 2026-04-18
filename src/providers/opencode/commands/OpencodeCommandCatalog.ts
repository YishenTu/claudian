import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
} from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';

const OPENCODE_COMPACT_COMMAND: ProviderCommandEntry = {
  id: 'opencode-builtin-compact',
  providerId: 'opencode',
  kind: 'command',
  name: 'compact',
  description: 'Compact conversation history',
  content: '',
  scope: 'system',
  source: 'builtin',
  isEditable: false,
  isDeletable: false,
  displayPrefix: '/',
  insertPrefix: '/',
};

export class OpencodeCommandCatalog implements ProviderCommandCatalog {
  private runtimeCommands: ProviderCommandEntry[] = [];

  setRuntimeCommands(commands: ProviderCommandEntry[]): void {
    this.runtimeCommands = commands;
  }

  async listDropdownEntries(context: { includeBuiltIns: boolean }): Promise<ProviderCommandEntry[]> {
    const commands = this.runtimeCommands;
    return context.includeBuiltIns ? [OPENCODE_COMPACT_COMMAND, ...commands] : commands;
  }

  async listVaultEntries(): Promise<ProviderCommandEntry[]> {
    return [];
  }

  async saveVaultEntry(_entry: ProviderCommandEntry): Promise<void> {
  }

  async deleteVaultEntry(_entry: ProviderCommandEntry): Promise<void> {
  }

  getDropdownConfig(): ProviderCommandDropdownConfig {
    return {
      providerId: 'opencode',
      triggerChars: ['/'],
      builtInPrefix: '/',
      skillPrefix: '$',
      commandPrefix: '/',
    };
  }

  async refresh(): Promise<void> {
  }
}
