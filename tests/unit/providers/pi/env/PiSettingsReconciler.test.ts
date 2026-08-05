import '@/providers';

import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import { isVersionedRuntimeInputFingerprint } from '@/core/providers/settings/RuntimeInputFingerprint';
import type { Conversation } from '@/core/types';
import { piSettingsReconciler } from '@/providers/pi/env/PiSettingsReconciler';

describe('piSettingsReconciler', () => {
  it('invalidates Pi conversations when Pi session/config environment changes', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          enabled: true,
          environmentHash: 'PI_CODING_AGENT_SESSION_DIR=/old',
          environmentVariables: 'PI_CODING_AGENT_SESSION_DIR=/new\nPI_OFFLINE=1',
        },
      },
    };
    const piConversation = {
      id: 'pi-conversation',
      messages: [],
      providerId: 'pi',
      providerState: {
        futureResumeCursor: { token: 'keep-me' },
        leafEntryId: 'assistant-1',
        sessionFile: '/old/session.jsonl',
      },
      sessionId: 'session-1',
    } as unknown as Conversation;
    const claudeConversation = {
      id: 'claude-conversation',
      messages: [],
      providerId: 'claude',
      providerState: { providerSessionId: 'claude-session' },
      sessionId: 'claude-session',
    } as unknown as Conversation;

    const result = piSettingsReconciler.reconcileModelWithEnvironment(
      settings,
      [piConversation, claudeConversation],
    );

    expect(result.changed).toBe(true);
    expect(result.invalidatedConversations).toEqual([piConversation]);
    expect(piConversation.sessionId).toBeNull();
    expect(piConversation.providerState).toEqual({
      futureResumeCursor: { token: 'keep-me' },
      previousSessions: [{
        leafEntryId: 'assistant-1',
        sessionFile: '/old/session.jsonl',
        sessionId: 'session-1',
      }],
    });
    expect(claudeConversation.sessionId).toBe('claude-session');
    const fingerprint = (settings.providerConfigs as any).pi.environmentHash;
    expect(isVersionedRuntimeInputFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).not.toContain('/new');
  });

  it('migrates a matching legacy environment fingerprint before coordinator invalidation', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          enabled: true,
          environmentHash: 'PI_OFFLINE=1',
          environmentVariables: 'PI_OFFLINE=1',
        },
      },
    };
    const conversation = {
      id: 'pi-conversation',
      messages: [],
      providerId: 'pi',
      providerState: {
        leafEntryId: 'assistant-1',
        sessionFile: '/sessions/current.jsonl',
        sessionId: 'current-session',
      },
      sessionId: 'current-session',
    } as unknown as Conversation;

    expect(piSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    const result = ProviderSettingsCoordinator.reconcileProviders(
      settings,
      [conversation],
      ['pi'],
    );

    expect(result).toMatchObject({
      changed: false,
      environmentChangedProviderIds: [],
      invalidatedConversations: [],
      sessionInvalidationProviderIds: [],
    });
    expect(conversation.sessionId).toBe('current-session');
    expect(conversation.providerState).toMatchObject({
      leafEntryId: 'assistant-1',
      sessionFile: '/sessions/current.jsonl',
      sessionId: 'current-session',
    });
    expect(isVersionedRuntimeInputFingerprint(
      (settings.providerConfigs as any).pi.environmentHash,
    )).toBe(true);
  });

  it('converts pending forks into replayable previous sessions idempotently', () => {
    const conversation = {
      id: 'pi-pending-fork',
      messages: [],
      providerId: 'pi',
      providerState: {
        forkSource: {
          resumeAt: 'assistant-1',
          sessionId: 'source-session',
        },
        forkSourceSessionFile: '/sessions/source.jsonl',
        futureResumeCursor: { token: 'keep-me' },
      },
      sessionId: null,
    } as unknown as Conversation;

    expect(piSettingsReconciler.invalidateConversationSessions([conversation])).toEqual([
      conversation,
    ]);
    expect(conversation.providerState).toEqual({
      futureResumeCursor: { token: 'keep-me' },
      previousSessions: [{
        leafEntryId: 'assistant-1',
        sessionFile: '/sessions/source.jsonl',
        sessionId: 'source-session',
      }],
    });
    expect(piSettingsReconciler.invalidateConversationSessions([conversation])).toEqual([]);
  });

  it('normalizes malformed Pi model selections instead of preserving invalid ids', () => {
    const settings: Record<string, unknown> = {
      model: 'pi:missing-slash',
      providerConfigs: {
        pi: {},
      },
      savedProviderModel: {
        pi: 'pi:also-invalid',
      },
      titleGenerationModel: 'pi:invalid-title',
    };

    expect(piSettingsReconciler.normalizeModelVariantSettings(settings)).toBe(true);
    expect(settings.model).toBe('');
    expect(settings.titleGenerationModel).toBe('');
    expect(settings.savedProviderModel).toEqual({});
  });
});
