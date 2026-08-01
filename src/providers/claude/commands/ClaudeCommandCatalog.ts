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

interface ActiveCommandProbe {
  readonly completion: Promise<void>;
  readonly controller: AbortController;
  resolveCompletion(): void;
}

export class ClaudeCommandCatalog implements ProviderCommandCatalog, ProviderVaultEntryRepository {
  private readonly activeProbes = new Set<ActiveCommandProbe>();
  private cacheGeneration = 0;
  private commandSnapshot: SlashCommand[] = [];
  private disposed = false;
  private disposePromise: Promise<void> | null = null;
  private quiescenceDepth = 0;
  private probedCommands: SlashCommand[] | null = null;
  private probePromise: Promise<SlashCommand[]> | null = null;
  private transitionActive = false;

  constructor(
    private commandStorage: SlashCommandStorage,
    private skillStorage: SkillStorage,
    private probe?: CommandProbe,
  ) {}

  setCommandSnapshot(commands: SlashCommand[]): void {
    if (this.probesBlocked) return;
    this.invalidateProbeCache();
    this.commandSnapshot = commands.map(command => ({ ...command }));
  }

  async listDropdownEntries(context: ProviderCommandListContext): Promise<ProviderCommandEntry[]> {
    context.signal?.throwIfAborted();
    // SDK commands already include vault commands/skills (the SDK scans
    // .claude/commands/ and .claude/skills/ internally). No file scan needed.
    let commands = context.commandSnapshot;
    if (commands === undefined) {
      const allowCachedCommandSnapshot = context.allowCachedCommandSnapshot !== false;
      if (allowCachedCommandSnapshot && this.commandSnapshot.length > 0) {
        commands = this.commandSnapshot;
      } else {
        const probedCommands = await this.ensureProbed(context.signal);
        commands = allowCachedCommandSnapshot && this.commandSnapshot.length > 0
          ? this.commandSnapshot
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
    if (this.probesBlocked) return [];
    if (this.probedCommands) return this.probedCommands;
    if (!this.probe) return [];
    if (signal) {
      return await this.runProbe(signal);
    }
    if (!this.probePromise) {
      const probePromise = this.runProbe().finally(() => {
        if (this.probePromise === probePromise) {
          this.probePromise = null;
        }
      });
      this.probePromise = probePromise;
    }
    return await this.probePromise;
  }

  private async runProbe(signal?: AbortSignal): Promise<SlashCommand[]> {
    const generation = this.cacheGeneration;
    let resolveCompletion!: () => void;
    const entry: ActiveCommandProbe = {
      completion: new Promise(resolve => { resolveCompletion = resolve; }),
      controller: new AbortController(),
      resolveCompletion: () => resolveCompletion(),
    };
    const onAbort = (): void => entry.controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    this.activeProbes.add(entry);
    try {
      entry.controller.signal.throwIfAborted();
      const commands = await this.probe?.(entry.controller.signal) ?? [];
      entry.controller.signal.throwIfAborted();
      if (this.disposed || generation !== this.cacheGeneration) return [];
      this.probedCommands = commands.map(command => ({ ...command }));
      return this.probedCommands;
    } catch {
      signal?.throwIfAborted();
      if (this.disposed || generation !== this.cacheGeneration) return [];
      this.probedCommands = [];
      return this.probedCommands;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.activeProbes.delete(entry);
      entry.resolveCompletion();
    }
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
    await this.quiesceForEnvironmentChange();
  }

  async quiesceForEnvironmentChange(): Promise<void> {
    this.quiescenceDepth += 1;
    try {
      await this.drainProbes();
    } finally {
      this.quiescenceDepth -= 1;
    }
  }

  async beginEnvironmentTransition(): Promise<void> {
    this.transitionActive = true;
    await this.drainProbes();
  }

  endEnvironmentTransition(): void {
    this.transitionActive = false;
  }

  private async drainProbes(): Promise<void> {
    const sharedProbe = this.probePromise;
    this.invalidateProbeCache();
    this.commandSnapshot = [];
    const active = [...this.activeProbes];
    await Promise.all([
      ...active.map(entry => entry.completion),
      ...(sharedProbe ? [sharedProbe.then(() => undefined)] : []),
    ]);
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.disposePromise = this.quiesceForEnvironmentChange();
    return this.disposePromise;
  }

  private invalidateProbeCache(): void {
    this.cacheGeneration += 1;
    this.probedCommands = null;
    for (const entry of this.activeProbes) {
      entry.controller.abort();
    }
  }

  private get probesBlocked(): boolean {
    return this.disposed || this.transitionActive || this.quiescenceDepth > 0;
  }
}
