import { CodexSessionManager } from '@/providers/codex/runtime/CodexSessionManager';

describe('CodexSessionManager', () => {
  let manager: CodexSessionManager;

  beforeEach(() => {
    manager = new CodexSessionManager();
  });

  describe('getThreadId and setThread', () => {
    it('should initially return null', () => {
      expect(manager.getThreadId()).toBeNull();
    });

    it('should set and get thread ID', () => {
      manager.setThread('thread_abc123');
      expect(manager.getThreadId()).toBe('thread_abc123');
    });

    it('should set session file path when provided', () => {
      manager.setThread('thread_abc123', '/path/to/session.jsonl');
      expect(manager.getSessionFilePath()).toBe('/path/to/session.jsonl');
    });

    it('clears the session file path when switching to a new thread without one', () => {
      manager.setThread('thread_1', '/path/to/first.jsonl');
      manager.setThread('thread_2');
      expect(manager.getThreadId()).toBe('thread_2');
      expect(manager.getSessionFilePath()).toBeNull();
    });

    it('retains the session file path when the same thread is re-applied without one', () => {
      manager.setThread('thread_1', '/path/to/first.jsonl');
      manager.setThread('thread_1');

      expect(manager.getSessionFilePath()).toBe('/path/to/first.jsonl');
    });
  });

  describe('getSessionFilePath', () => {
    it('should initially return null', () => {
      expect(manager.getSessionFilePath()).toBeNull();
    });
  });

  describe('reset', () => {
    it('should clear thread ID', () => {
      manager.setThread('thread_abc123');
      manager.reset();
      expect(manager.getThreadId()).toBeNull();
    });

    it('should clear session file path', () => {
      manager.setThread('thread_abc123', '/path/to/session.jsonl');
      manager.reset();
      expect(manager.getSessionFilePath()).toBeNull();
    });

    it('should clear invalidation state', () => {
      manager.invalidateSession();
      manager.reset();
      expect(manager.consumeInvalidation()).toBe(false);
    });
  });

  describe('invalidation', () => {
    it('should not be invalidated initially', () => {
      expect(manager.consumeInvalidation()).toBe(false);
    });

    it('should track invalidation', () => {
      manager.invalidateSession();
      expect(manager.consumeInvalidation()).toBe(true);
    });

    it('should consume invalidation (one-shot)', () => {
      manager.invalidateSession();
      expect(manager.consumeInvalidation()).toBe(true);
      expect(manager.consumeInvalidation()).toBe(false);
    });
  });
});
