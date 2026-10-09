import type {
  ProviderConversationHistoryService,
  ProviderConversationSessionAvailability,
  ProviderHistoryInput,
  ProviderHistoryPathContext,
  ProviderHistoryUpdate,
} from '@/core/providers/types';

import { encodeDeepSeekModelId } from '../models';
import { type DeepSeekReader,DeepSeekRemoteError, isRecord } from '../remote/DeepSeekRemoteClient';
import type { DeepSeekHost } from '../runtime/DeepSeekHost';
import { decodeDeepSeekCheckpoint, decodeDeepSeekState } from '../types';
import { loadDeepSeekHistory } from './DeepSeekHistoryStore';
import { readDeepSeekProjection } from './DeepSeekJournal';

export class DeepSeekConversationHistoryService implements ProviderConversationHistoryService {
  constructor(private readonly resolveHost: (context?: ProviderHistoryPathContext) => Promise<DeepSeekHost>) {}

  resolveSessionIdForConversation(input: ProviderHistoryInput | null): string | null {
    return input?.sessionId ?? decodeDeepSeekState(input?.providerState)?.pendingFork?.sessionId ?? null;
  }

  isPendingForkConversation(input: ProviderHistoryInput): boolean { return !!decodeDeepSeekState(input.providerState)?.pendingFork; }

  hasConversationModelRecoverySource(input: ProviderHistoryInput): boolean { return !!this.resolveSessionIdForConversation(input); }

  async recoverConversationModelSelection(input: ProviderHistoryInput, _vaultPath: string | null, context?: ProviderHistoryPathContext): Promise<string | null> {
    const id = this.resolveSessionIdForConversation(input);
    if (!id) return null;
    return this.read(input, context, async client => {
      const projection = await readDeepSeekProjection(client, id);
      const selection = projection.values.modelSelection;
      if (!isRecord(selection)) return null;
      const model = selection.next ?? selection.lastUsed;
      return isRecord(model) && typeof model.provider === 'string' && typeof model.model === 'string'
        ? encodeDeepSeekModelId(model.provider, model.model) : null;
    }).catch(() => null);
  }

  async getConversationSessionAvailability(input: ProviderHistoryInput, _vaultPath: string | null, context?: ProviderHistoryPathContext): Promise<ProviderConversationSessionAvailability> {
    const id = this.resolveSessionIdForConversation(input);
    if (!id) return 'unknown';
    try {
      await this.read(input, context, client => readDeepSeekProjection(client, id));
      return 'available';
    } catch (error) { return error instanceof DeepSeekRemoteError && error.code === 'session/missing' ? 'missing' : 'unknown'; }
  }

  async hydrateConversationHistory(input: ProviderHistoryInput, _vaultPath: string | null, context?: ProviderHistoryPathContext): Promise<ProviderHistoryUpdate> {
    const id = this.resolveSessionIdForConversation(input);
    if (!id) return {};
    const state = decodeDeepSeekState(input.providerState);
    return this.read(input, context, async client => {
      const projection = await readDeepSeekProjection(client, id);
      const cut = state?.pendingFork?.atSeq ?? projection.asOfSeq;
      if (cut > projection.asOfSeq) throw new Error('DeepSeek fork checkpoint is not present in native history.');
      const messages = await loadDeepSeekHistory(client, id, cut);
      return { messages };
    });
  }

  buildForkProviderState(sourceSessionId: string, resumeAt: string, sourceProviderState?: Record<string, unknown>): Record<string, unknown> {
    const source = decodeDeepSeekState(sourceProviderState);
    if (!source) throw new Error('DeepSeek native storage and preset identity are required for a fork.');
    return { ...source, pendingFork: { sessionId: sourceSessionId, atSeq: decodeDeepSeekCheckpoint(resumeAt) } };
  }

  buildPersistedProviderState(input: ProviderHistoryInput): Record<string, unknown> | undefined {
    const state = decodeDeepSeekState(input.providerState);
    return state ? { ...state } : undefined;
  }

  private async read<T>(input: ProviderHistoryInput, context: ProviderHistoryPathContext | undefined, operation: (client: DeepSeekReader) => Promise<T>): Promise<T> {
    const host = await this.resolveHost(context);
    const state = decodeDeepSeekState(input.providerState);
    return host.read((reader, home) => {
      if (state && state.home !== home) throw new Error('DeepSeek history belongs to a different native store. Restore the original store binding before continuing.');
      return operation(reader);
    });
  }
}
