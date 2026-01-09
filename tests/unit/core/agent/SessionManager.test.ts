import { SessionManager } from '@/core/agent/SessionManager';

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
  });

  describe('getSessionId and setSessionId', () => {
    it('should initially return null', () => {
      expect(manager.getSessionId()).toBeNull();
    });

    it('should set and get session ID', () => {
      manager.setSessionId('test-session-123');
      expect(manager.getSessionId()).toBe('test-session-123');
    });

    it('should allow setting session ID to null', () => {
      manager.setSessionId('some-session');
      manager.setSessionId(null);
      expect(manager.getSessionId()).toBeNull();
    });

    it('should set session model when defaultModel is provided', () => {
      manager.setSessionId('test-session', 'claude-sonnet-4-5');
      expect(manager.getSessionId()).toBe('test-session');
    });
  });

  describe('reset', () => {
    it('should reset session without throwing', () => {
      expect(() => manager.reset()).not.toThrow();
    });

    it('should clear session ID', () => {
      manager.setSessionId('some-session');
      expect(manager.getSessionId()).toBe('some-session');

      manager.reset();
      expect(manager.getSessionId()).toBeNull();
    });

    it('should clear interrupted state', () => {
      manager.markInterrupted();
      expect(manager.wasInterrupted()).toBe(true);

      manager.reset();
      expect(manager.wasInterrupted()).toBe(false);
    });
  });

  describe('interrupted state', () => {
    it('should initially not be interrupted', () => {
      expect(manager.wasInterrupted()).toBe(false);
    });

    it('should mark as interrupted', () => {
      manager.markInterrupted();
      expect(manager.wasInterrupted()).toBe(true);
    });

    it('should clear interrupted state', () => {
      manager.markInterrupted();
      manager.clearInterrupted();
      expect(manager.wasInterrupted()).toBe(false);
    });
  });

  describe('pending model', () => {
    it('should set and clear pending model without throwing', () => {
      expect(() => manager.setPendingModel('claude-opus-4-5')).not.toThrow();
      expect(() => manager.clearPendingModel()).not.toThrow();
    });
  });

  describe('captureSession', () => {
    it('should capture session ID and pending model', () => {
      manager.setPendingModel('claude-opus-4-5');
      manager.captureSession('new-session-id');

      expect(manager.getSessionId()).toBe('new-session-id');
    });
  });

  describe('invalidateSession', () => {
    it('should clear session ID and model', () => {
      manager.setSessionId('test-session', 'claude-sonnet-4-5');
      manager.invalidateSession();

      expect(manager.getSessionId()).toBeNull();
    });
  });
});
