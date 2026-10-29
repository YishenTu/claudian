import type { createClaudianAPI } from '@/features/chat/session-messaging/ClaudianAPI';

/** For fixtures without chat views: opening a session is not modeled and fails loudly. */
export const unmodeledChatViews: Parameters<typeof createClaudianAPI>[1] = {
  openSession: async () => { throw new Error('Chat views are not modeled by this fixture'); },
};
