import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
} from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import type { SlashCommand } from '../../../core/types';
import { isSkill } from '../../../utils/slashCommand';
import type { SkillStorage } from '../storage/SkillStorage';
import type { SlashCommandStorage } from '../storage/SlashCommandStorage';

function slashCommandToEntry(cmd: SlashCommand): ProviderCommandEntry {
  const skill = isSkill(cmd);
  return {
    id: cmd.id,
    providerId: 'claude',
    kind: skill ? 'skill' : 'command',
    name: cmd.name,
    description: cmd.description,
    content: cmd.content,
    argumentHint: cmd.argumentHint,
    allowedTools: cmd.allowedTools,
    model: cmd.model,
    disableModelInvocation: cmd.disableModelInvocation,
    userInvocable: cmd.userInvocable,
    context: cmd.context,
    agent: cmd.agent,
    hooks: cmd.hooks,
    scope: cmd.source === 'sdk' ? 'runtime' : 'vault',
    source: cmd.source ?? 'user',
    isEditable: cmd.source !== 'sdk',
    isDeletable: cmd.source !== 'sdk',
    displayPrefix: '/',
    insertPrefix: '/',
  };
}

function entryToSlashCommand(entry: ProviderCommandEntry): SlashCommand {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    content: entry.content,
    argumentHint: entry.argumentHint,
    allowedTools: entry.allowedTools,
    model: entry.model,
    disableModelInvocation: entry.disableModelInvocation,
    userInvocable: entry.userInvocable,
    context: entry.context,
    agent: entry.agent,
    hooks: entry.hooks,
    source: entry.source,
    kind: entry.kind,
  };
}

// SDK built-in skills that have no meaning inside Claudian
const BUILTIN_HIDDEN_COMMANDS = new Set([
  'context', 'cost', 'debug', 'extra-usage', 'heapdump', 'init',
  'insights', 'loop', 'schedule', 'security-review', 'simplify', 'update-config',
]);

export type CommandProbe = () => Promise<SlashCommand[]>;

export class ClaudeCommandCatalog implements ProviderCommandCatalog {
  private sdkCommands: SlashCommand[] = [];
  private probePromise: Promise<void> | null = null;

  constructor(
    private commandStorage: SlashCommandStorage,
    private skillStorage: SkillStorage,
    private probe?: CommandProbe,
  ) {}

  setRuntimeCommands(commands: SlashCommand[]): void {
    this.sdkCommands = commands;
  }

  invalidateCache(): void {
    this.sdkCommands = [];
    this.probePromise = null;
  }

  async listDropdownEntries(context: { includeBuiltIns: boolean }): Promise<ProviderCommandEntry[]> {
    void context;
    // SDK commands already include vault commands/skills (the SDK scans
    // .claude/commands/ and .claude/skills/ internally). No file scan needed.
    // When the cache is empty (cold start, no active runtime), probe the SDK.
    if (this.sdkCommands.length === 0 && this.probe) {
      await this.ensureProbed();
    }
    const runtimeEntries = this.sdkCommands
      .filter(cmd => !BUILTIN_HIDDEN_COMMANDS.has(cmd.name.toLowerCase()))
      .map(slashCommandToEntry);
    if (runtimeEntries.length > 0) {
      return runtimeEntries;
    }
    return this.listVaultEntries();
  }

  /** Probe the SDK for commands. Deduplicates concurrent calls. */
  private async ensureProbed(): Promise<void> {
    if (!this.probe) return;
    if (!this.probePromise) {
      this.probePromise = this.probe().then((commands) => {
        // Only apply probe results if the runtime hasn't provided fresher data
        if (this.sdkCommands.length === 0 && commands.length > 0) {
          this.sdkCommands = commands;
        }
      }).catch(() => {
        // Probe is best-effort
      }).finally(() => {
        this.probePromise = null;
      });
    }
    await this.probePromise;
  }

  async listVaultEntries(): Promise<ProviderCommandEntry[]> {
    const commands = await this.commandStorage.loadAll();
    const skills = await this.skillStorage.loadAll();
    return [...commands, ...skills].map(slashCommandToEntry);
  }

  async saveVaultEntry(entry: ProviderCommandEntry): Promise<void> {
    const cmd = entryToSlashCommand(entry);
    if (entry.kind === 'skill') {
      await this.skillStorage.save(cmd);
    } else {
      await this.commandStorage.save(cmd);
    }
  }

  async deleteVaultEntry(entry: ProviderCommandEntry): Promise<void> {
    if (entry.kind === 'skill') {
      await this.skillStorage.delete(entry.id);
    } else {
      await this.commandStorage.delete(entry.id);
    }
  }

  getDropdownConfig(): ProviderCommandDropdownConfig {
    return {
      providerId: 'claude',
      triggerChars: ['/'],
      builtInPrefix: '/',
      skillPrefix: '/',
      commandPrefix: '/',
    };
  }

  async refresh(): Promise<void> {
    // Claude revalidation happens externally via setRuntimeCommands
  }
}
