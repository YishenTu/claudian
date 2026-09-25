import { parseGrokSessionNotification } from '@/providers/grok/runtime/GrokSessionNotifications';

describe('GrokSessionNotifications', () => {
  const notification = {
    sessionId: 'session-1',
    update: {
      content: { text: 'hello', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    },
  };

  it.each(['x.ai/session/update', '_x.ai/session/update'])(
    'accepts the direct %s session update alias',
    (method) => {
      expect(parseGrokSessionNotification(method, notification)).toEqual(notification);
    },
  );

  it('unwraps only the exact xAI session notification envelope', () => {
    expect(parseGrokSessionNotification('_x.ai/session_notification', {
      method: 'x.ai/session_notification',
      params: notification,
    })).toEqual(notification);
    expect(parseGrokSessionNotification('_x.ai/session_notification', {
      method: '_x.ai/session_notification',
      params: notification,
    })).toBeNull();
    expect(parseGrokSessionNotification('_x.ai/session_notification', notification))
      .toBeNull();
  });

  it('rejects malformed and unrelated notifications', () => {
    expect(parseGrokSessionNotification('session/update', notification)).toBeNull();
    expect(parseGrokSessionNotification('_x.ai/session/update', {
      sessionId: 'session-1',
      update: null,
    })).toBeNull();
    expect(parseGrokSessionNotification('_x.ai/session/update', {
      sessionId: ' ',
      update: notification.update,
    })).toBeNull();
  });
});
