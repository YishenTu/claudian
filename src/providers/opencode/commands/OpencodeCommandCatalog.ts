import type { ProviderCommandEntry } from '@/core/providers/commands/ProviderCommandEntry';
import { RuntimeCommandCatalog } from '@/core/providers/commands/RuntimeCommandCatalog';
import type { SlashCommand } from '@/core/types';

function slashCommandToEntry(command: SlashCommand): ProviderCommandEntry {
  return {
    id: command.id,
    providerId: 'opencode',
    kind: 'command',
    name: command.name,
    description: command.description,
    content: command.content,
    argumentHint: command.argumentHint,
    allowedTools: command.allowedTools,
    model: command.model,
    disableModelInvocation: command.disableModelInvocation,
    userInvocable: command.userInvocable,
    context: command.context,
    agent: command.agent,
    hooks: command.hooks,
    scope: 'runtime',
    source: command.source ?? 'sdk',
    isEditable: false,
    isDeletable: false,
    displayPrefix: '/',
    insertPrefix: '/',
  };
}

export class OpencodeCommandCatalog extends RuntimeCommandCatalog {
  private nativeVersion: 1 | 2 | undefined;

  setNativeVersion(version: 1 | 2 | undefined): void { this.nativeVersion = version; }

  override getDropdownConfig() {
    // A picker can be assembled before passive version detection finishes.
    const config = super.getDropdownConfig();
    Object.defineProperty(config, 'refreshOnOpen', { enumerable: true, get: () => this.nativeVersion === 2 || undefined });
    return config;
  }

  constructor() {
    super({
      dropdownConfig: {
        builtInPrefix: '/',
        commandPrefix: '/',
        // Discovery chains internal step bounds with fallbacks.
        discoveryTimeoutMs: 'provider-owned',
        providerId: 'opencode',
        skillPrefix: '/',
        triggerChars: ['/'],
      },
      projectEntry: slashCommandToEntry,
    });
  }
}
