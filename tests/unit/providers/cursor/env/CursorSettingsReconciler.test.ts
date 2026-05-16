import type { Conversation } from '@/core/types';
import { cursorSettingsReconciler } from '@/providers/cursor/env/CursorSettingsReconciler';

function buildConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    providerId: 'cursor',
    title: '',
    createdAt: 0,
    updatedAt: 0,
    sessionId: 'chat-abc',
    providerState: { threadId: 'chat-abc' },
    messages: [],
    ...overrides,
  };
}

describe('cursorSettingsReconciler', () => {
  it('reports no changes when env hash matches saved hash', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        cursor: {
          environmentVariables: 'CURSOR_API_KEY=abc',
          environmentHash: 'CURSOR_API_KEY=abc',
        },
      },
    };
    const conv = buildConversation();

    const result = cursorSettingsReconciler.reconcileModelWithEnvironment(settings, [conv]);

    expect(result.changed).toBe(false);
    expect(result.invalidatedConversations).toEqual([]);
    expect(conv.sessionId).toBe('chat-abc');
  });

  it('invalidates cursor conversations when env hash changes', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        cursor: {
          environmentVariables: 'CURSOR_API_KEY=new-key',
          environmentHash: 'CURSOR_API_KEY=old-key',
        },
      },
    };
    const conv = buildConversation();

    const result = cursorSettingsReconciler.reconcileModelWithEnvironment(settings, [conv]);

    expect(result.changed).toBe(true);
    expect(result.invalidatedConversations).toEqual([conv]);
    expect(conv.sessionId).toBeNull();
    expect(conv.providerState).toBeUndefined();
  });

  it('does not invalidate non-cursor conversations on env change', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        cursor: {
          environmentVariables: 'CURSOR_API_KEY=new-key',
          environmentHash: 'CURSOR_API_KEY=old-key',
        },
      },
    };
    const cursorConv = buildConversation();
    const claudeConv = buildConversation({ id: 'conv-2', providerId: 'claude' });

    const result = cursorSettingsReconciler.reconcileModelWithEnvironment(
      settings,
      [cursorConv, claudeConv],
    );

    expect(result.invalidatedConversations).toEqual([cursorConv]);
    expect(claudeConv.sessionId).toBe('chat-abc');
    expect(claudeConv.providerState).toEqual({ threadId: 'chat-abc' });
  });

  it('updates settings.environmentHash to the current hash', () => {
    const settings: Record<string, unknown> = {
      providerConfigs: {
        cursor: {
          environmentVariables: 'CURSOR_API_KEY=new-key',
          environmentHash: 'CURSOR_API_KEY=old-key',
        },
      },
    };

    cursorSettingsReconciler.reconcileModelWithEnvironment(settings, []);

    const updatedConfig = (settings.providerConfigs as { cursor: { environmentHash: string } }).cursor;
    expect(updatedConfig.environmentHash).toBe('CURSOR_API_KEY=new-key');
  });

  it('normalizeModelVariantSettings falls unknown models back to the primary cursor model', () => {
    const settings: Record<string, unknown> = { model: 'not-a-cursor-model' };
    const changed = cursorSettingsReconciler.normalizeModelVariantSettings(settings);
    expect(changed).toBe(true);
    expect(settings.model).toBe('auto');
  });

  it('normalizeModelVariantSettings keeps recognized models unchanged', () => {
    const settings: Record<string, unknown> = { model: 'gpt-5.5-extra-high' };
    const changed = cursorSettingsReconciler.normalizeModelVariantSettings(settings);
    expect(changed).toBe(false);
    expect(settings.model).toBe('gpt-5.5-extra-high');
  });
});
