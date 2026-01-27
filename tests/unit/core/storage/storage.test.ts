import type { ChatMessage, Conversation } from '@/core/types';
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

    it('should parse currentNote when present', () => {
      const jsonl = '{"type":"meta","id":"conv-123","title":"Test","createdAt":1000,"updatedAt":2000,"sessionId":null,"currentNote":"file1.md"}';

      const conversation = parseJSONLHelper(jsonl);
      expect(conversation!.currentNote).toBe('file1.md');
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

    it('should preserve image data when serializing', () => {
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
                data: 'base64-image-data',
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
      // Image data is preserved as single source of truth
      expect(msgRecord.message.images[0].data).toBe('base64-image-data');
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
        currentNote: 'a.md',
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
      expect(parsed!.currentNote).toBe(original.currentNote);
      expect(parsed!.messages).toHaveLength(2);
    });
  });
});

// ============================================================================
// SlashCommandStorage Tests
// ============================================================================

describe('SlashCommandStorage', () => {
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

    // Block scalar tests moved to tests/unit/utils/slashCommand.test.ts
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
  currentNote?: string;
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
    currentNote: meta.currentNote,
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
    currentNote: conversation.currentNote,
  };
  lines.push(JSON.stringify(meta));

  for (const message of conversation.messages) {
    // Image data is preserved as single source of truth
    const record: SessionMessageRecord = {
      type: 'message',
      message,
    };
    lines.push(JSON.stringify(record));
  }

  return lines.join('\n');
}

