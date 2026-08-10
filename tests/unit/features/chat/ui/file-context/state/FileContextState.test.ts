import { FileContextState } from '@/features/chat/ui/file-context/state/FileContextState';

describe('FileContextState', () => {
  let state: FileContextState;

  beforeEach(() => {
    state = new FileContextState();
  });

  describe('initial state', () => {
    it('should start with no attached files', () => {
      expect(state.getAttachedFiles().size).toBe(0);
    });

    it('should start with session not started', () => {
      expect(state.isSessionStarted()).toBe(false);
    });

    it('should start with current note not sent', () => {
      expect(state.hasSentCurrentNote()).toBe(false);
    });

  });

  describe('session lifecycle', () => {
    it('should mark session as started', () => {
      state.startSession();
      expect(state.isSessionStarted()).toBe(true);
    });

    it('should mark current note as sent', () => {
      state.markCurrentNoteSent();
      expect(state.hasSentCurrentNote()).toBe(true);
    });
  });

  describe('resetForNewConversation', () => {
    it('should reset all state', () => {
      state.startSession();
      state.markCurrentNoteSent();
      state.attachFile('file1.md');

      state.resetForNewConversation();

      expect(state.isSessionStarted()).toBe(false);
      expect(state.hasSentCurrentNote()).toBe(false);
      expect(state.getAttachedFiles().size).toBe(0);
    });
  });

  describe('resetForLoadedConversation', () => {
    it('should set state based on whether conversation has messages', () => {
      state.attachFile('file1.md');

      state.resetForLoadedConversation(true);

      expect(state.isSessionStarted()).toBe(true);
      expect(state.hasSentCurrentNote()).toBe(true);
      expect(state.getAttachedFiles().size).toBe(0);
    });

    it('should not mark as started when no messages', () => {
      state.resetForLoadedConversation(false);

      expect(state.isSessionStarted()).toBe(false);
      expect(state.hasSentCurrentNote()).toBe(false);
    });
  });

  describe('file attachments', () => {
    it('should attach a file', () => {
      state.attachFile('test.md');
      expect(state.getAttachedFiles().has('test.md')).toBe(true);
    });

    it('should return a copy of attached files (not the internal set)', () => {
      state.attachFile('test.md');
      const files = state.getAttachedFiles();
      files.add('other.md');
      expect(state.getAttachedFiles().has('other.md')).toBe(false);
    });

    it('should detach a file', () => {
      state.attachFile('test.md');
      state.detachFile('test.md');
      expect(state.getAttachedFiles().has('test.md')).toBe(false);
    });

    it('should set attached files replacing existing', () => {
      state.attachFile('old.md');
      state.setAttachedFiles(['new1.md', 'new2.md']);
      const files = state.getAttachedFiles();
      expect(files.has('old.md')).toBe(false);
      expect(files.has('new1.md')).toBe(true);
      expect(files.has('new2.md')).toBe(true);
    });

    it('should clear all attachments', () => {
      state.attachFile('a.md');
      state.clearAttachments();
      expect(state.getAttachedFiles().size).toBe(0);
    });
  });

});
