import type {
  ProviderCommandCatalog,
  ProviderCommandDropdownConfig,
  ProviderCommandListContext,
} from '../../../core/providers/commands/ProviderCommandCatalog';
import type { ProviderCommandEntry } from '../../../core/providers/commands/ProviderCommandEntry';
import type { ProviderVaultEntryRepository } from '../../../core/providers/commands/ProviderVaultEntryRepository';
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

export type CommandProbe = (signal?: AbortSignal) => Promise<SlashCommand[]>;

export class ClaudeCommandCatalog implements ProviderCommandCatalog, ProviderVaultEntryRepository {
  private runtimeCommands: SlashCommand[] = [];
  private probedCommands: SlashCommand[] | null = null;
  private probePromise: Promise<SlashCommand[]> | null = null;

  constructor(
    private commandStorage: SlashCommandStorage,
    private skillStorage: SkillStorage,
    private probe?: CommandProbe,
  ) {}

  setRuntimeCommands(commands: SlashCommand[]): void {
    this.runtimeCommands = commands.map(command => ({ ...command }));
    if (commands.length === 0) {
      this.probedCommands = null;
    }
  }

  async listDropdownEntries(context: ProviderCommandListContext): Promise<ProviderCommandEntry[]> {
    context.signal?.throwIfAborted();
    // SDK commands already include vault commands/skills (the SDK scans
    // .claude/commands/ and .claude/skills/ internally). No file scan needed.
    let commands = context.runtimeCommands;
    if (commands === undefined) {
      const allowCachedRuntimeCommands = context.allowCachedRuntimeCommands !== false;
      if (allowCachedRuntimeCommands && this.runtimeCommands.length > 0) {
        commands = this.runtimeCommands;
      } else {
        const probedCommands = await this.ensureProbed(context.signal);
        commands = allowCachedRuntimeCommands && this.runtimeCommands.length > 0
          ? this.runtimeCommands
          : probedCommands;
      }
    }
    const runtimeEntries = commands
      .filter(cmd => !BUILTIN_HIDDEN_COMMANDS.has(cmd.name.toLowerCase()))
      .map(slashCommandToEntry);
    if (runtimeEntries.length > 0) {
      return runtimeEntries;
    }
    return this.listVaultEntries(context.signal);
  }

  /** Probe the SDK for commands. Deduplicates concurrent calls. */
  private async ensureProbed(signal?: AbortSignal): Promise<SlashCommand[]> {
    signal?.throwIfAborted();
    if (this.probedCommands) return this.probedCommands;
    if (!this.probe) return [];
    if (signal) {
      try {
        const commands = await this.probe(signal);
        signal.throwIfAborted();
        this.probedCommands = commands.map(command => ({ ...command }));
      } catch {
        signal.throwIfAborted();
        this.probedCommands = [];
      }
      return this.probedCommands;
    }
    if (!this.probePromise) {
      this.probePromise = this.probe().then((commands) => {
        this.probedCommands = commands.map(command => ({ ...command }));
        return this.probedCommands;
      }).catch(() => {
        // Probe is best-effort
        this.probedCommands = [];
        return this.probedCommands;
      }).finally(() => {
        this.probePromise = null;
      });
    }
    return await this.probePromise;
  }

  async listVaultEntries(signal?: AbortSignal): Promise<ProviderCommandEntry[]> {
    signal?.throwIfAborted();
    const commands = await this.commandStorage.loadAll();
    signal?.throwIfAborted();
    const skills = await this.skillStorage.loadAll();
    signal?.throwIfAborted();
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
    this.probedCommands = null;
  }
}
