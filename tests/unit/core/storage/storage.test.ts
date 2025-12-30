/**
 * Storage module tests.
 *
 * Tests for SessionStorage (JSONL), SlashCommandStorage, and StorageService (migration).
 */

import type { ChatMessage, Conversation, SlashCommand } from '@/core/types';
import { parseSlashCommandContent } from '@/utils/slashCommand';

// ============================================================================
// SessionStorage Tests (JSONL format)
// ============================================================================

describe('SessionStorage JSONL format', () => {
  describe('parseJSONL', () => {
    it('should parse valid JSONL with meta and messages', () => {
      const jsonl = [
        '{"type":"meta","id":"conv-123","title":"Test","createdAt":1000,"updatedAt":2000,"sessionId":"sess-1"}',
        '{"type":"message","message":{"id":"msg-1","role":"user","content":"Hello","timestamp":1001}}',
        '{"type":"message","message":{"id":"msg-2","role":"assistant","content":"Hi","timestamp":1002}}',
      ].join('\n');

      const conversation = parseJSONLHelper(jsonl);

      expect(conversation).not.toBeNull();
      expect(conversation!.id).toBe('conv-123');
      expect(conversation!.title).toBe('Test');
      expect(conversation!.createdAt).toBe(1000);
      expect(conversation!.updatedAt).toBe(2000);
      expect(conversation!.sessionId).toBe('sess-1');
      expect(conversation!.messages).toHaveLength(2);
      expect(conversation!.messages[0].role).toBe('user');
      expect(conversation!.messages[0].content).toBe('Hello');
      expect(conversation!.messages[1].role).toBe('assistant');
    });

    it('should handle empty content', () => {
      const conversation = parseJSONLHelper('');
      expect(conversation).toBeNull();
    });

    it('should handle content with only whitespace lines', () => {
      const conversation = parseJSONLHelper('\n   \n  \n');
      expect(conversation).toBeNull();
    });

    it('should skip malformed lines gracefully', () => {
      const jsonl = [
        '{"type":"meta","id":"conv-123","title":"Test","createdAt":1000,"updatedAt":2000,"sessionId":null}',
        'not valid json',
        '{"type":"message","message":{"id":"msg-1","role":"user","content":"Hello","timestamp":1001}}',
      ].join('\n');

      const conversation = parseJSONLHelper(jsonl);

      expect(conversation).not.toBeNull();
      expect(conversation!.messages).toHaveLength(1);
    });

    it('should return null if no meta record found', () => {
      const jsonl = '{"type":"message","message":{"id":"msg-1","role":"user","content":"Hello","timestamp":1001}}';

      const conversation = parseJSONLHelper(jsonl);
      expect(conversation).toBeNull();
    });

    it('should parse lastResponseAt when present', () => {
      const jsonl = '{"type":"meta","id":"conv-123","title":"Test","createdAt":1000,"updatedAt":2000,"lastResponseAt":1500,"sessionId":null}';

      const conversation = parseJSONLHelper(jsonl);
      expect(conversation!.lastResponseAt).toBe(1500);
    });

    it('should parse attachedFiles when present', () => {
      const jsonl = '{"type":"meta","id":"conv-123","title":"Test","createdAt":1000,"updatedAt":2000,"sessionId":null,"attachedFiles":["file1.md","file2.txt"]}';

      const conversation = parseJSONLHelper(jsonl);
      expect(conversation!.attachedFiles).toEqual(['file1.md', 'file2.txt']);
    });
  });

  describe('serializeToJSONL', () => {
    it('should serialize conversation to valid JSONL', () => {
      const conversation: Conversation = {
        id: 'conv-456',
        title: 'My Chat',
        createdAt: 5000,
        updatedAt: 6000,
        sessionId: 'sess-abc',
        messages: [
          { id: 'msg-1', role: 'user', content: 'Question', timestamp: 5001 },
          { id: 'msg-2', role: 'assistant', content: 'Answer', timestamp: 5002 },
        ],
      };

      const jsonl = serializeToJSONLHelper(conversation);
      const lines = jsonl.split('\n');

      expect(lines).toHaveLength(3);

      const meta = JSON.parse(lines[0]);
      expect(meta.type).toBe('meta');
      expect(meta.id).toBe('conv-456');
      expect(meta.title).toBe('My Chat');
      expect(meta.sessionId).toBe('sess-abc');

      const msg1 = JSON.parse(lines[1]);
      expect(msg1.type).toBe('message');
      expect(msg1.message.role).toBe('user');

      const msg2 = JSON.parse(lines[2]);
      expect(msg2.type).toBe('message');
      expect(msg2.message.role).toBe('assistant');
    });

    it('should strip image data when serializing', () => {
      const conversation: Conversation = {
        id: 'conv-img',
        title: 'Image Chat',
        createdAt: 1000,
        updatedAt: 2000,
        sessionId: null,
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'See image',
            timestamp: 1001,
            images: [
              {
                id: 'img-1',
                name: 'test.png',
                mediaType: 'image/png',
                data: 'base64-data-should-be-stripped',
                cachePath: '.claude/cache/abc123.png',
                size: 1024,
                source: 'paste',
              },
            ],
          },
        ],
      };

      const jsonl = serializeToJSONLHelper(conversation);
      const lines = jsonl.split('\n');
      const msgRecord = JSON.parse(lines[1]);

      expect(msgRecord.message.images).toHaveLength(1);
      expect(msgRecord.message.images[0].name).toBe('test.png');
      expect(msgRecord.message.images[0].cachePath).toBe('.claude/cache/abc123.png');
      expect(msgRecord.message.images[0].data).toBeUndefined();
    });

    it('should preserve image data without cachePath or filePath', () => {
      const conversation: Conversation = {
        id: 'conv-inline',
        title: 'Inline Image',
        createdAt: 1000,
        updatedAt: 2000,
        sessionId: null,
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Inline image',
            timestamp: 1001,
            images: [
              {
                id: 'img-1',
                name: 'inline.png',
                mediaType: 'image/png',
                data: 'inline-base64-data',
                size: 512,
                source: 'paste',
              },
            ],
          },
        ],
      };

      const jsonl = serializeToJSONLHelper(conversation);
      const msgRecord = JSON.parse(jsonl.split('\n')[1]);

      expect(msgRecord.message.images[0].data).toBe('inline-base64-data');
    });

    it('should preserve lastResponseAt in serialization', () => {
      const conversation: Conversation = {
        id: 'conv-lr',
        title: 'Test',
        createdAt: 1000,
        updatedAt: 2000,
        lastResponseAt: 1500,
        sessionId: null,
        messages: [],
      };

      const jsonl = serializeToJSONLHelper(conversation);
      const meta = JSON.parse(jsonl.split('\n')[0]);

      expect(meta.lastResponseAt).toBe(1500);
    });

    it('should round-trip conversation correctly', () => {
      const original: Conversation = {
        id: 'conv-rt',
        title: 'Round Trip',
        createdAt: 1000,
        updatedAt: 2000,
        lastResponseAt: 1500,
        sessionId: 'sess-rt',
        attachedFiles: ['a.md', 'b.md'],
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', timestamp: 1001 },
          { id: 'msg-2', role: 'assistant', content: 'World', timestamp: 1002 },
        ],
      };

      const jsonl = serializeToJSONLHelper(original);
      const parsed = parseJSONLHelper(jsonl);

      expect(parsed).not.toBeNull();
      expect(parsed!.id).toBe(original.id);
      expect(parsed!.title).toBe(original.title);
      expect(parsed!.createdAt).toBe(original.createdAt);
      expect(parsed!.updatedAt).toBe(original.updatedAt);
      expect(parsed!.lastResponseAt).toBe(original.lastResponseAt);
      expect(parsed!.sessionId).toBe(original.sessionId);
      expect(parsed!.attachedFiles).toEqual(original.attachedFiles);
      expect(parsed!.messages).toHaveLength(2);
    });
  });
});

// ============================================================================
// SlashCommandStorage Tests
// ============================================================================

describe('SlashCommandStorage', () => {
  describe('filePathToId', () => {
    it('should convert flat file path to ID', () => {
      const id = filePathToIdHelper('.claude/commands/review.md');
      expect(id).toBe('cmd-review');
    });

    it('should convert nested file path to ID with double-dash', () => {
      const id = filePathToIdHelper('.claude/commands/code/refactor.md');
      expect(id).toBe('cmd-code--refactor');
    });

    it('should convert deeply nested path to ID', () => {
      const id = filePathToIdHelper('.claude/commands/a/b/c.md');
      expect(id).toBe('cmd-a--b--c');
    });

    it('should not collide for a-b vs a/b', () => {
      const idDash = filePathToIdHelper('.claude/commands/a-b.md');
      const idSlash = filePathToIdHelper('.claude/commands/a/b.md');

      // a-b.md -> cmd-a-_b (dash escaped)
      // a/b.md -> cmd-a--b (slash encoded)
      expect(idDash).toBe('cmd-a-_b');
      expect(idSlash).toBe('cmd-a--b');
      expect(idDash).not.toBe(idSlash);
    });

    it('should not collide for a--b vs a/b', () => {
      const idDoubleDash = filePathToIdHelper('.claude/commands/a--b.md');
      const idSlash = filePathToIdHelper('.claude/commands/a/b.md');

      // a--b.md -> cmd-a-_-_b (both dashes escaped)
      // a/b.md  -> cmd-a--b (slash encoded)
      expect(idDoubleDash).toBe('cmd-a-_-_b');
      expect(idSlash).toBe('cmd-a--b');
      expect(idDoubleDash).not.toBe(idSlash);
    });

    it('should handle mixed dashes and slashes', () => {
      const id = filePathToIdHelper('.claude/commands/a/b-c.md');
      // a/b-c.md -> cmd-a--b-_c
      expect(id).toBe('cmd-a--b-_c');
    });
  });

  describe('filePathToName', () => {
    it('should extract name from flat file', () => {
      const name = filePathToNameHelper('.claude/commands/review.md');
      expect(name).toBe('review');
    });

    it('should extract nested name with slashes', () => {
      const name = filePathToNameHelper('.claude/commands/code/refactor.md');
      expect(name).toBe('code/refactor');
    });
  });

  describe('parseFile', () => {
    it('should parse command with full frontmatter', () => {
      const content = `---
description: Review code for issues
argument-hint: "[file] [focus]"
allowed-tools:
  - Read
  - Grep
model: claude-sonnet-4-5
---
Review this code: $ARGUMENTS`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Review code for issues');
      expect(parsed.argumentHint).toBe('[file] [focus]');
      expect(parsed.allowedTools).toEqual(['Read', 'Grep']);
      expect(parsed.model).toBe('claude-sonnet-4-5');
      expect(parsed.promptContent).toBe('Review this code: $ARGUMENTS');
    });

    it('should parse command with minimal frontmatter', () => {
      const content = `---
description: Simple command
---
Do something`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Simple command');
      expect(parsed.argumentHint).toBeUndefined();
      expect(parsed.allowedTools).toBeUndefined();
      expect(parsed.model).toBeUndefined();
      expect(parsed.promptContent).toBe('Do something');
    });

    it('should handle content without frontmatter', () => {
      const content = 'Just a prompt without frontmatter';

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBeUndefined();
      expect(parsed.promptContent).toBe('Just a prompt without frontmatter');
    });

    it('should handle inline array syntax for allowed-tools', () => {
      const content = `---
allowed-tools: [Read, Write, Bash]
---
Prompt`;

      const parsed = parseSlashCommandContent(content);
      expect(parsed.allowedTools).toEqual(['Read', 'Write', 'Bash']);
    });

    it('should handle quoted values', () => {
      const content = `---
description: "Value with: colon"
argument-hint: 'Single quoted'
---
Prompt`;

      const parsed = parseSlashCommandContent(content);

      expect(parsed.description).toBe('Value with: colon');
      expect(parsed.argumentHint).toBe('Single quoted');
    });
  });

  describe('serializeCommand', () => {
    it('should serialize command to markdown with frontmatter', () => {
      const command: SlashCommand = {
        id: 'cmd-test',
        name: 'test',
        description: 'Test command',
        argumentHint: '[arg]',
        allowedTools: ['Read', 'Write'],
        model: 'claude-sonnet-4-5',
        content: 'Original prompt',
      };

      const serialized = serializeCommandHelper(command);

      expect(serialized).toContain('---');
      expect(serialized).toContain('description: Test command');
      expect(serialized).toContain('argument-hint: [arg]');
      expect(serialized).toContain('allowed-tools:');
      expect(serialized).toContain('  - Read');
      expect(serialized).toContain('  - Write');
      expect(serialized).toContain('model: claude-sonnet-4-5');
      expect(serialized).toContain('Original prompt');
    });

    it('should quote description with special characters', () => {
      const command: SlashCommand = {
        id: 'cmd-special',
        name: 'special',
        description: 'Has: colon and # hash',
        content: 'Prompt',
      };

      const serialized = serializeCommandHelper(command);
      expect(serialized).toContain('description: "Has: colon and # hash"');
    });

    it('should handle command without optional fields', () => {
      const command: SlashCommand = {
        id: 'cmd-minimal',
        name: 'minimal',
        content: 'Just prompt',
      };

      const serialized = serializeCommandHelper(command);

      expect(serialized).toContain('---');
      expect(serialized).not.toContain('description:');
      expect(serialized).not.toContain('argument-hint:');
      expect(serialized).not.toContain('allowed-tools:');
      expect(serialized).not.toContain('model:');
      expect(serialized).toContain('Just prompt');
    });
  });
});

// ============================================================================
// StorageService Migration Tests
// ============================================================================

describe('StorageService migration', () => {
  describe('needsMigration', () => {
    it('should return false for null data', () => {
      expect(needsMigrationHelper(null)).toBe(false);
    });

    it('should return true if conversations exist', () => {
      const data = {
        conversations: [{ id: 'conv-1', title: 'Test', messages: [] }],
      };
      expect(needsMigrationHelper(data)).toBe(true);
    });

    it('should return true if slashCommands exist', () => {
      const data = {
        slashCommands: [{ id: 'cmd-1', name: 'test', content: 'prompt' }],
      };
      expect(needsMigrationHelper(data)).toBe(true);
    });

    it('should return true if settings fields exist', () => {
      const data = {
        model: 'claude-sonnet-4-5',
        thinkingBudget: 'high',
      };
      expect(needsMigrationHelper(data)).toBe(true);
    });

    it('should return false for empty object', () => {
      expect(needsMigrationHelper({})).toBe(false);
    });

    it('should return false if only state fields exist', () => {
      // activeConversationId is excluded from hasSettings check
      const stateOnlyData = {
        activeConversationId: 'conv-1',
        lastEnvHash: 'hash',
        lastClaudeModel: 'haiku',
        lastCustomModel: 'custom',
        migrationVersion: 2,
      };
      expect(needsMigrationHelper(stateOnlyData)).toBe(false);
    });
  });
});

// ============================================================================
// SlashCommandManager nested command detection
// ============================================================================

describe('SlashCommandManager nested commands', () => {
  describe('detectCommand regex', () => {
    it('should detect flat command', () => {
      const match = '/review file.ts'.match(/^\/([a-zA-Z0-9_/-]+)(?:\s+([\s\S]*))?$/);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('review');
      expect(match![2]).toBe('file.ts');
    });

    it('should detect nested command with slash', () => {
      const match = '/code/review file.ts'.match(/^\/([a-zA-Z0-9_/-]+)(?:\s+([\s\S]*))?$/);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('code/review');
      expect(match![2]).toBe('file.ts');
    });

    it('should detect deeply nested command', () => {
      const match = '/a/b/c arg'.match(/^\/([a-zA-Z0-9_/-]+)(?:\s+([\s\S]*))?$/);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('a/b/c');
      expect(match![2]).toBe('arg');
    });

    it('should detect command with no args', () => {
      const match = '/code/refactor'.match(/^\/([a-zA-Z0-9_/-]+)(?:\s+([\s\S]*))?$/);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('code/refactor');
      expect(match![2]).toBeUndefined();
    });

    it('should handle command with hyphen', () => {
      const match = '/my-command arg'.match(/^\/([a-zA-Z0-9_/-]+)(?:\s+([\s\S]*))?$/);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('my-command');
    });

    it('should handle command with underscore', () => {
      const match = '/my_command arg'.match(/^\/([a-zA-Z0-9_/-]+)(?:\s+([\s\S]*))?$/);
      expect(match).not.toBeNull();
      expect(match![1]).toBe('my_command');
    });
  });
});

// ============================================================================
// Helper Functions (mimic internal logic for testing)
// ============================================================================

interface SessionMetaRecord {
  type: 'meta';
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastResponseAt?: number;
  sessionId: string | null;
  attachedFiles?: string[];
}

interface SessionMessageRecord {
  type: 'message';
  message: ChatMessage;
}

type SessionRecord = SessionMetaRecord | SessionMessageRecord;

function parseJSONLHelper(content: string): Conversation | null {
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  let meta: SessionMetaRecord | null = null;
  const messages: ChatMessage[] = [];

  for (const line of lines) {
    try {
      const record = JSON.parse(line) as SessionRecord;
      if (record.type === 'meta') {
        meta = record;
      } else if (record.type === 'message') {
        messages.push(record.message);
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (!meta) return null;

  return {
    id: meta.id,
    title: meta.title,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    lastResponseAt: meta.lastResponseAt,
    sessionId: meta.sessionId,
    messages,
    attachedFiles: meta.attachedFiles,
  };
}

function serializeToJSONLHelper(conversation: Conversation): string {
  const lines: string[] = [];

  const meta: SessionMetaRecord = {
    type: 'meta',
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastResponseAt: conversation.lastResponseAt,
    sessionId: conversation.sessionId,
    attachedFiles: conversation.attachedFiles,
  };
  lines.push(JSON.stringify(meta));

  for (const message of conversation.messages) {
    // Strip image data
    const storedMessage = { ...message };
    if (storedMessage.images) {
      storedMessage.images = storedMessage.images.map(img => {
        if (!img.cachePath && !img.filePath) {
          return img as typeof img;
        }
        const { data: _, ...rest } = img;
        return rest as typeof img;
      });
    }
    const record: SessionMessageRecord = {
      type: 'message',
      message: storedMessage,
    };
    lines.push(JSON.stringify(record));
  }

  return lines.join('\n');
}

const COMMANDS_PATH = '.claude/commands';

function filePathToIdHelper(filePath: string): string {
  const relativePath = filePath
    .replace(`${COMMANDS_PATH}/`, '')
    .replace(/\.md$/, '');
  const escaped = relativePath
    .replace(/-/g, '-_')   // Escape dashes first
    .replace(/\//g, '--'); // Then encode slashes
  return `cmd-${escaped}`;
}

function filePathToNameHelper(filePath: string): string {
  return filePath
    .replace(`${COMMANDS_PATH}/`, '')
    .replace(/\.md$/, '');
}

function serializeCommandHelper(command: SlashCommand): string {
  const lines: string[] = ['---'];

  if (command.description) {
    lines.push(`description: ${yamlStringHelper(command.description)}`);
  }
  if (command.argumentHint) {
    lines.push(`argument-hint: ${yamlStringHelper(command.argumentHint)}`);
  }
  if (command.allowedTools && command.allowedTools.length > 0) {
    lines.push('allowed-tools:');
    for (const tool of command.allowedTools) {
      lines.push(`  - ${tool}`);
    }
  }
  if (command.model) {
    lines.push(`model: ${command.model}`);
  }

  lines.push('---');

  // Extract prompt content (strip existing frontmatter if present)
  const parsed = parseSlashCommandContent(command.content);
  lines.push(parsed.promptContent);

  return lines.join('\n');
}

function yamlStringHelper(value: string): string {
  if (value.includes(':') || value.includes('#') || value.includes('\n') ||
      value.startsWith(' ') || value.endsWith(' ')) {
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function needsMigrationHelper(legacyData: any): boolean {
  if (!legacyData) return false;

  const hasConversations = legacyData.conversations && legacyData.conversations.length > 0;
  const hasSlashCommands = legacyData.slashCommands && legacyData.slashCommands.length > 0;
  const stateKeys = new Set([
    'conversations',
    'slashCommands',
    'activeConversationId',
    'lastEnvHash',
    'lastClaudeModel',
    'lastCustomModel',
    'migrationVersion',
  ]);
  const hasSettings = Object.keys(legacyData).some(key => !stateKeys.has(key));

  return hasConversations || hasSlashCommands || hasSettings;
}
