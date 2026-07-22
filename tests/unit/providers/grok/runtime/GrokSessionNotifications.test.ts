import {
  GROK_SESSION_UPDATE_NOTIFICATION_METHODS,
  GROK_WRAPPED_SESSION_NOTIFICATION_METHOD,
  parseGrokSessionNotification,
} from '@/providers/grok/runtime/GrokSessionNotifications';

describe('GrokSessionNotifications', () => {
  const notification = {
    sessionId: 'session-1',
    update: {
      content: { text: 'hello', type: 'text' },
      sessionUpdate: 'agent_message_chunk',
    },
  };

  it.each(GROK_SESSION_UPDATE_NOTIFICATION_METHODS)(
    'accepts the direct %s session update alias',
    (method) => {
      expect(parseGrokSessionNotification(method, notification)).toEqual(notification);
    },
  );

  it('unwraps only the exact xAI session notification envelope', () => {
    expect(parseGrokSessionNotification(GROK_WRAPPED_SESSION_NOTIFICATION_METHOD, {
      method: 'x.ai/session_notification',
      params: notification,
    })).toEqual(notification);
    expect(parseGrokSessionNotification(GROK_WRAPPED_SESSION_NOTIFICATION_METHOD, {
      method: '_x.ai/session_notification',
      params: notification,
    })).toBeNull();
    expect(parseGrokSessionNotification(GROK_WRAPPED_SESSION_NOTIFICATION_METHOD, notification))
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
