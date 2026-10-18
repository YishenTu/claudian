import type { SlashCommand } from '@/core/types';

import { isRecord, OpencodeHTTPError, pollOpencodeUntil } from '../http/OpencodeHTTPClient';
import { listOpencodeThinkingLevels, loadOpencodeNativeModels, type OpencodeNativeModel } from '../http/OpencodeNativeModelCatalog';
import type { OpencodeServerLease } from '../http/OpencodeServerService';
import type {
  OpencodeMetadataCatalogResult,
  OpencodeMetadataProbe,
  OpencodeMetadataWarmResult,
} from './OpencodeMetadataService';

/** V2 catalog reads share native credentials without creating a native session. */
export class OpencodeV2MetadataProbe implements OpencodeMetadataProbe {
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
    // A fresh native instance lists no commands until its catalog loads; built-ins always follow.
    const [commands, skills] = await Promise.all([
      pollOpencodeUntil(async () => (await this.read('command', signal)).filter(isNamedRecord), commands => commands.length > 0, 5_000, signal),
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
      : this.models = await loadOpencodeNativeModels(this.client, ownedSignal, rawModelId);
    const model = models.find(model => model.rawId === rawModelId);
    if (!model) throw new Error('OpenCode model is no longer available. Refresh the model catalog.');
    return { rawModelId, models, thinkingLevels: listOpencodeThinkingLevels(model) };
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
