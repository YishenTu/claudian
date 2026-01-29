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

    it('should start with no MCP mentions', () => {
      expect(state.getMentionedMcpServers().size).toBe(0);
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
      state.attachContextFile('ctx/file.ts', '/abs/ctx/file.ts');
      state.addMentionedMcpServer('server1');

      state.resetForNewConversation();

      expect(state.isSessionStarted()).toBe(false);
      expect(state.hasSentCurrentNote()).toBe(false);
      expect(state.getAttachedFiles().size).toBe(0);
      expect(state.getMentionedMcpServers().size).toBe(0);
    });
  });

  describe('resetForLoadedConversation', () => {
    it('should set state based on whether conversation has messages', () => {
      state.attachFile('file1.md');
      state.attachContextFile('ctx/file.ts', '/abs/ctx/file.ts');
      state.addMentionedMcpServer('server1');

      state.resetForLoadedConversation(true);

      expect(state.isSessionStarted()).toBe(true);
      expect(state.hasSentCurrentNote()).toBe(true);
      expect(state.getAttachedFiles().size).toBe(0);
      expect(state.getMentionedMcpServers().size).toBe(0);
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
      state.attachContextFile('ctx/b.ts', '/abs/b.ts');
      state.clearAttachments();
      expect(state.getAttachedFiles().size).toBe(0);
    });
  });

  describe('context file attachments', () => {
    it('should attach a context file with path mapping', () => {
      state.attachContextFile('ctx/file.ts', '/absolute/path/file.ts');
      expect(state.getAttachedFiles().has('/absolute/path/file.ts')).toBe(true);
    });

    it('should transform context mentions in text', () => {
      state.attachContextFile('ctx/file.ts', '/absolute/path/file.ts');
      const result = state.transformContextMentions('Look at ctx/file.ts for details');
      expect(result).toBe('Look at /absolute/path/file.ts for details');
    });

    it('should replace multiple occurrences of the same mention', () => {
      state.attachContextFile('ctx/a.ts', '/abs/a.ts');
      const result = state.transformContextMentions('ctx/a.ts and ctx/a.ts');
      expect(result).toBe('/abs/a.ts and /abs/a.ts');
    });

    it('should handle multiple different context files', () => {
      state.attachContextFile('ctx/a.ts', '/abs/a.ts');
      state.attachContextFile('ctx/b.ts', '/abs/b.ts');
      const result = state.transformContextMentions('ctx/a.ts and ctx/b.ts');
      expect(result).toBe('/abs/a.ts and /abs/b.ts');
    });

    it('should return text unchanged when no context files', () => {
      const text = 'no mentions here';
      expect(state.transformContextMentions(text)).toBe(text);
    });

    it('should handle regex special characters in display names', () => {
      state.attachContextFile('file (1).ts', '/abs/file (1).ts');
      const result = state.transformContextMentions('See file (1).ts');
      expect(result).toBe('See /abs/file (1).ts');
    });
  });

  describe('MCP server mentions', () => {
    it('should add a mentioned MCP server', () => {
      state.addMentionedMcpServer('server1');
      expect(state.getMentionedMcpServers().has('server1')).toBe(true);
    });

    it('should return a copy of mentioned servers', () => {
      state.addMentionedMcpServer('server1');
      const servers = state.getMentionedMcpServers();
      servers.add('server2');
      expect(state.getMentionedMcpServers().has('server2')).toBe(false);
    });

    it('should clear MCP mentions', () => {
      state.addMentionedMcpServer('server1');
      state.clearMcpMentions();
      expect(state.getMentionedMcpServers().size).toBe(0);
    });

    it('should set mentioned MCP servers and return true when changed', () => {
      const changed = state.setMentionedMcpServers(new Set(['a', 'b']));
      expect(changed).toBe(true);
      expect(state.getMentionedMcpServers()).toEqual(new Set(['a', 'b']));
    });

    it('should return false when setting same servers', () => {
      state.setMentionedMcpServers(new Set(['a', 'b']));
      const changed = state.setMentionedMcpServers(new Set(['a', 'b']));
      expect(changed).toBe(false);
    });

    it('should return true when sizes differ', () => {
      state.setMentionedMcpServers(new Set(['a']));
      const changed = state.setMentionedMcpServers(new Set(['a', 'b']));
      expect(changed).toBe(true);
    });

    it('should return true when same size but different contents', () => {
      state.setMentionedMcpServers(new Set(['a', 'b']));
      const changed = state.setMentionedMcpServers(new Set(['a', 'c']));
      expect(changed).toBe(true);
    });
  });
});
