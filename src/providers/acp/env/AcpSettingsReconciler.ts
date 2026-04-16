import type { ProviderSettingsReconciler } from '../../../core/providers/types';
import type { Conversation } from '../../../core/types';
import { getAcpProviderSettings, setAcpProviderSettings } from '../settings';

/**
 * ACP settings reconciler.
 * Handles environment-based settings changes and session invalidation.
 */
export const acpSettingsReconciler: ProviderSettingsReconciler = {
  reconcileModelWithEnvironment(
    settings: Record<string, unknown>,
    conversations: Conversation[],
  ): { changed: boolean; invalidatedConversations: Conversation[] } {
    const currentSettings = getAcpProviderSettings(settings);
    const currentAgents = currentSettings.agents.map(a => a.id).join(',');

    // Check if any agent configuration has changed
    // For MVP, we just invalidate all ACP conversations if agents changed
    const invalidations: Conversation[] = [];

    for (const conv of conversations) {
      if (conv.providerId === 'acp' && conv.sessionId) {
        // Check if the agent for this conversation still exists
        const agentExists = currentSettings.agents.some(a => a.id === conv.sessionId);
        if (!agentExists) {
          invalidations.push(conv);
        }
      }
    }

    return { changed: false, invalidatedConversations: invalidations };
  },

  normalizeModelVariantSettings(_settings: Record<string, unknown>): boolean {
    // ACP doesn't have model variants in MVP
    return false;
  },
};
