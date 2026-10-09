import { normalizeProviderCommandDiscoveryItems } from '@/core/providers/commands/ProviderCommandDiscoveryResult';
import type { ProviderCommandLoader } from '@/core/providers/types';
import { getVaultPath } from '@/utils/path';

import { readDeepSeekSkills } from '../commands/DeepSeekCommandCatalog';
import { readDeepSeekProjection } from '../history/DeepSeekJournal';
import { type DeepSeekReader, isRecord } from '../remote/DeepSeekRemoteClient';
import type { DeepSeekHost } from '../runtime/DeepSeekHost';
import { getDeepSeekProviderSettings } from '../settings';
import { decodeDeepSeekState } from '../types';

const REQUIRES_SESSION = { status: 'requires-session', message: 'Send a message to load DeepSeek commands and skills for this conversation.' } as const;
/** Saved roots inspected when a blank tab looks for a catalog with its vault. */
const CATALOG_CANDIDATES = 20;
/** Both chat presets mount the same skill catalog; code mode changes tools only. Auxiliary presets mount none. */
const CHAT_PRESETS = new Set<unknown>(['claudian', 'claudian-code']);

/**
 * Native skills are keyed by session cwd and preset, and `skills/list` reads saved sessions without
 * activating them. Commands need a live Agent, so `/compact` joins once the conversation binds.
 */
export function createDeepSeekCommandLoader(deepseek: DeepSeekHost): ProviderCommandLoader {
  return {
    getCacheFingerprint: settings => `deepseek:commands:${getDeepSeekProviderSettings(settings).enabled}`,
    isAvailable: settings => getDeepSeekProviderSettings(settings).enabled,
    async loadCommands({ allowIsolatedMetadataCreation, conversation, plugin, readyCommandSnapshot, signal }) {
      signal?.throwIfAborted();
      if (readyCommandSnapshot) return normalizeProviderCommandDiscoveryItems(readyCommandSnapshot);
      const cwd = getVaultPath(plugin.app);
      if (!allowIsolatedMetadataCreation || !cwd) return REQUIRES_SESSION;
      try {
        const saved = decodeDeepSeekState(conversation?.providerState);
        const skills = await deepseek.read(async (reader, home) => {
          const own = saved && saved.home !== home ? undefined : conversation?.sessionId ?? saved?.pendingFork?.sessionId;
          const sessionId = own ?? await findCatalogSession(reader, cwd);
          return sessionId ? readDeepSeekSkills(reader, sessionId) : undefined;
        }, signal);
        return skills ? normalizeProviderCommandDiscoveryItems(skills) : REQUIRES_SESSION;
      } catch {
        signal?.throwIfAborted();
        return { status: 'error', message: 'Could not load DeepSeek skills.', retryable: true };
      }
    },
  };
}

async function findCatalogSession(reader: DeepSeekReader, cwd: string): Promise<string | undefined> {
  const listed = await reader.call('session/list', { _request: {} });
  if (!isRecord(listed) || !Array.isArray(listed.items)) throw new Error('Malformed DeepSeek session roster.');
  const roots = listed.items.filter(isRecord)
    .filter(row => typeof row.sessionId === 'string' && row.cwd === cwd && row.origin !== 'subagent')
    .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt))
    .slice(0, CATALOG_CANDIDATES);
  for (const row of roots) {
    const sessionId = row.sessionId as string;
    if (CHAT_PRESETS.has((await readDeepSeekProjection(reader, sessionId)).values.agentPreset)) return sessionId;
  }
  return undefined;
}
