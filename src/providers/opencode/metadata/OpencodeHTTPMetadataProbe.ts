import type { SlashCommand } from '@/core/types';

import { isRecord, OpencodeHTTPError } from '../http/OpencodeHTTPClient';
import { listOpencodeThinkingLevels, loadOpencodeNativeModels, type OpencodeNativeModel } from '../http/OpencodeNativeModelCatalog';
import type { OpencodeServerLease } from '../http/OpencodeServerService';
import type {
  OpencodeMetadataCatalogResult,
  OpencodeMetadataProbe,
  OpencodeMetadataWarmResult,
} from './OpencodeMetadataService';

/** V2 catalog reads share native credentials without creating a native session. */
export class OpencodeHTTPMetadataProbe implements OpencodeMetadataProbe {
  private models: OpencodeNativeModel[] | null = null;

  constructor(private readonly client: OpencodeServerLease) {}

  async loadCatalog(signal?: AbortSignal): Promise<OpencodeMetadataCatalogResult> {
    const ownedSignal = this.client.signal(signal);
    this.models = await loadOpencodeNativeModels(this.client, ownedSignal);
    return { models: this.models };
  }

  async loadCommands(signal?: AbortSignal): Promise<SlashCommand[]> {
    const ownedSignal = this.client.signal(signal);
    await this.client.waitForActivation(ownedSignal);
    return this.readCommands(ownedSignal);
  }

  private async readCommands(signal: AbortSignal): Promise<SlashCommand[]> {
    // Empty is a valid current snapshot; native command/skill events announce later changes.
    const [commands, skills] = await Promise.all([
      this.read('command', signal).then(commands => commands.filter(isNamedRecord)),
      // Earlier V2 releases have no skill catalog route.
      this.read('skill', signal).catch((error: unknown): unknown[] => {
        if (error instanceof OpencodeHTTPError && error.status === 404) return [];
        throw error;
      }),
    ]);
    const names = new Set(commands.map(command => command.name));
    return [
      ...commands.map((command): SlashCommand => ({
        id: `opencode-command:${command.name}`,
        name: command.name,
        content: '',
        kind: 'command',
        source: 'sdk',
        ...(typeof command.description === 'string' ? { description: command.description } : {}),
      })),
      // V2 lists skills separately; a same-named command takes the slash invocation.
      ...skills.filter(isNamedRecord).flatMap((skill): SlashCommand[] => typeof skill.id !== 'string' || names.has(skill.id) ? [] : [{
        id: `opencode-skill:${skill.id}`,
        name: skill.id,
        content: '',
        kind: 'skill',
        source: 'sdk',
        ...(typeof skill.description === 'string' ? { description: skill.description } : {}),
      }]),
    ];
  }

  async warmModel(rawModelId: string, signal?: AbortSignal): Promise<OpencodeMetadataWarmResult> {
    const ownedSignal = this.client.signal(signal);
    ownedSignal.throwIfAborted();
    const models = this.models?.some(model => model.rawId === rawModelId)
      ? this.models
      : this.models = await loadOpencodeNativeModels(this.client, ownedSignal);
    const model = models.find(model => model.rawId === rawModelId);
    if (!model) throw new Error('OpenCode model is no longer available. Refresh the model catalog.');
    return { rawModelId, models, thinkingLevels: listOpencodeThinkingLevels(model) };
  }

  watchCatalog(onChange: () => Promise<void>, signal: AbortSignal): Promise<void> {
    return this.watch(['model.updated', 'provider.updated'], onChange, signal);
  }

  watchCommands(onChange: () => Promise<void>, signal: AbortSignal): Promise<void> {
    return this.watch(['command.updated', 'skill.updated'], onChange, signal);
  }

  /** Coalesce invalidations; eventless v2 servers retain a bounded startup discovery window. */
  private async watch(types: readonly string[], onChange: () => Promise<void>, signal: AbortSignal): Promise<void> {
    const ownedSignal = this.client.signal(signal);
    let wake = (): void => {};
    let changed = new Promise<void>(resolve => { wake = resolve; });
    let receivedEvent = false;
    let timer: number | undefined;
    const notify = (): void => wake();
    ownedSignal.addEventListener('abort', notify, { once: true });
    try {
      // Poll while admission is pending too; a connected stream alone does not prove catalog event support.
      const discoveryDeadline = Date.now() + 5_000;
      timer = window.setTimeout(notify, 250);
      void this.client.subscribe(event => {
        if (types.includes(event.type)) { receivedEvent = true; notify(); }
      }, notify, () => false).then(notify, notify);
      for (;;) {
        await changed;
        window.clearTimeout(timer);
        ownedSignal.throwIfAborted();
        changed = new Promise<void>(resolve => { wake = resolve; });
        // The first reread closes the initial read/subscription gap. Failed reads retain observation.
        try { await onChange(); } catch { ownedSignal.throwIfAborted(); }
        const remaining = discoveryDeadline - Date.now();
        if (!receivedEvent && remaining > 0) timer = window.setTimeout(notify, Math.min(250, remaining));
      }
    } finally {
      window.clearTimeout(timer);
      ownedSignal.removeEventListener('abort', notify);
    }
  }

  async dispose(): Promise<void> { await this.client.dispose(); }

  private async read(resource: 'command' | 'skill', signal: AbortSignal): Promise<unknown[]> {
    const result = await this.client.request(`/api/${resource}`, { signal });
    if (!isRecord(result) || !Array.isArray(result.data)) throw new Error('Invalid OpenCode catalog response.');
    return result.data as unknown[];
  }
}

function isNamedRecord(value: unknown): value is Record<string, unknown> & { name: string } {
  return isRecord(value) && typeof value.name === 'string';
}
