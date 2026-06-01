import type { Conversation } from '@/core/types';
import { piSettingsReconciler } from '@/providers/pi/env/PiSettingsReconciler';

describe('piSettingsReconciler', () => {
  it('invalidates Pi conversations when Pi session/config environment changes', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        pi: {
          environmentHash: 'PI_CODING_AGENT_SESSION_DIR=/old',
          environmentVariables: 'PI_CODING_AGENT_SESSION_DIR=/new\nPI_OFFLINE=1',
        },
      },
    };
    const piConversation = {
      id: 'pi-conversation',
      messages: [],
      providerId: 'pi',
      providerState: { sessionFile: '/old/session.jsonl' },
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
    expect(piConversation.providerState).toBeUndefined();
    expect(claudeConversation.sessionId).toBe('claude-session');
    expect((settings.providerConfigs as any).pi.environmentHash).toBe(
      'PI_CODING_AGENT_SESSION_DIR=/new|PI_OFFLINE=1',
    );
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
    expect(settings.model).toBe('pi');
    expect(settings.titleGenerationModel).toBe('');
    expect(settings.savedProviderModel).toEqual({});
  });
});
