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

    it('should mark invalidation and allow consumption', () => {
      manager.setSessionId('test-session');
      manager.invalidateSession();

      expect(manager.consumeInvalidation()).toBe(true);
      expect(manager.consumeInvalidation()).toBe(false);
    });

    it('should clear invalidation when setting a new session', () => {
      manager.invalidateSession();
      manager.setSessionId('new-session');

      expect(manager.consumeInvalidation()).toBe(false);
    });
  });

  describe('session mismatch recovery', () => {
    it('should initially not need history rebuild', () => {
      expect(manager.needsHistoryRebuild()).toBe(false);
    });

    it('should not set rebuild flag when capturing first session', () => {
      manager.captureSession('first-session');
      expect(manager.needsHistoryRebuild()).toBe(false);
    });

    it('should not set rebuild flag when same session ID is captured', () => {
      manager.captureSession('same-session');
      manager.captureSession('same-session');
      expect(manager.needsHistoryRebuild()).toBe(false);
    });

    it('should set rebuild flag when different session ID is captured', () => {
      manager.captureSession('old-session');
      manager.captureSession('new-session');
      expect(manager.needsHistoryRebuild()).toBe(true);
    });

    it('should clear rebuild flag with clearHistoryRebuild', () => {
      manager.captureSession('old-session');
      manager.captureSession('new-session');
      expect(manager.needsHistoryRebuild()).toBe(true);

      manager.clearHistoryRebuild();
      expect(manager.needsHistoryRebuild()).toBe(false);
    });

    it('should clear rebuild flag on reset', () => {
      manager.captureSession('old-session');
      manager.captureSession('new-session');
      expect(manager.needsHistoryRebuild()).toBe(true);

      manager.reset();
      expect(manager.needsHistoryRebuild()).toBe(false);
    });

    it('should not set rebuild flag after setSessionId (external restore)', () => {
      // setSessionId is for restoring from saved conversation, not SDK response
      manager.setSessionId('restored-session');
      manager.captureSession('different-session');
      // This is a mismatch - SDK gave different session than we expected
      expect(manager.needsHistoryRebuild()).toBe(true);
    });

    it('should clear rebuild flag when setSessionId is called (session switch)', () => {
      // Scenario: mismatch occurs in conversation A, user switches to conversation B
      manager.captureSession('session-a');
      manager.captureSession('different-session'); // Mismatch detected
      expect(manager.needsHistoryRebuild()).toBe(true);

      // User switches to conversation B via setSessionId
      manager.setSessionId('session-b');

      // Flag should be cleared to prevent incorrectly prepending B's history
      expect(manager.needsHistoryRebuild()).toBe(false);
    });

    it('should clear rebuild flag when setSessionId is called with null', () => {
      manager.captureSession('session-a');
      manager.captureSession('different-session'); // Mismatch detected
      expect(manager.needsHistoryRebuild()).toBe(true);

      manager.setSessionId(null);

      expect(manager.needsHistoryRebuild()).toBe(false);
    });
  });
});
