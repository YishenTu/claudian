import {
  parsePiSessionContent,
  type PiSessionEntry,
  resolvePiActivePath,
} from '@/providers/pi/history/PiHistoryStore';

describe('PiHistoryStore', () => {
  it('parses linear user and assistant messages', () => {
    const content = [
      JSON.stringify({ type: 'session', id: 's1' }),
      JSON.stringify({ id: 'u1', type: 'entry', message: { role: 'user', content: 'Hello' } }),
      JSON.stringify({
        id: 'a1',
        type: 'entry',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'Thinking' },
            { type: 'text', text: 'Hi' },
          ],
        },
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      content: 'Hello',
      role: 'user',
      userMessageId: 'u1',
    });
    expect(messages[1]).toMatchObject({
      assistantMessageId: 'a1',
      content: 'Hi',
      contentBlocks: [
        { type: 'thinking', content: 'Thinking' },
        { type: 'text', content: 'Hi' },
      ],
      role: 'assistant',
    });
  });

  it('attaches tool results to the previous assistant tool call', () => {
    const content = [
      JSON.stringify({
        id: 'a1',
        type: 'entry',
        message: {
          role: 'assistant',
          content: [
            { id: 'tool-1', input: { path: 'a.md' }, name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        result: { content: [{ text: 'file contents', type: 'text' }] },
        toolCallId: 'tool-1',
        type: 'toolResult',
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content);

    expect(messages[0].toolCalls).toEqual([{
      id: 'tool-1',
      input: { file_path: 'a.md', path: 'a.md' },
      name: 'Read',
      result: 'file contents',
      status: 'completed',
    }]);
  });

  it('attaches real Pi message-role tool results to shared renderer tool calls', () => {
    const content = [
      JSON.stringify({
        id: 'a1',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { arguments: { path: 'a.md' }, id: 'tool-1', name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr1',
        parentId: 'a1',
        type: 'message',
        message: {
          content: [{ text: 'file contents', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'tool-1',
          toolName: 'read',
        },
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content);

    expect(messages[0].toolCalls).toEqual([{
      id: 'tool-1',
      input: { file_path: 'a.md', path: 'a.md' },
      name: 'Read',
      result: 'file contents',
      status: 'completed',
    }]);
    expect(messages[0].contentBlocks).toEqual([{ toolId: 'tool-1', type: 'tool_use' }]);
  });

  it('merges Pi assistant continuations split by tool results into one chat message', () => {
    const content = [
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'Hide scrollbars' } }),
      JSON.stringify({
        id: 'a1',
        parentId: 'u1',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Inspecting snippets' },
            { arguments: { path: '.obsidian' }, id: 'ls-1', name: 'ls', type: 'toolCall' },
            { arguments: { path: '.obsidian/snippets' }, id: 'ls-2', name: 'ls', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr1',
        parentId: 'a1',
        type: 'message',
        message: {
          content: [{ text: 'appearance.json\nsnippets/', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'ls-1',
          toolName: 'ls',
        },
      }),
      JSON.stringify({
        id: 'tr2',
        parentId: 'tr1',
        type: 'message',
        message: {
          content: [{ text: 'existing.css', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'ls-2',
          toolName: 'ls',
        },
      }),
      JSON.stringify({
        id: 'a2',
        parentId: 'tr2',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { arguments: { path: '.obsidian/appearance.json' }, id: 'read-1', name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr3',
        parentId: 'a2',
        type: 'message',
        message: {
          content: [{ text: '{"enabledCssSnippets":[]}', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'read-1',
          toolName: 'read',
        },
      }),
      JSON.stringify({
        id: 'a3',
        parentId: 'tr3',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Creating snippet' },
            { arguments: { path: '.obsidian/snippets/hide-scrollbars.css', content: 'css' }, id: 'write-1', name: 'write', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr4',
        parentId: 'a3',
        type: 'message',
        message: {
          content: [{ text: 'Successfully wrote file', type: 'text' }],
          isError: false,
          role: 'toolResult',
          toolCallId: 'write-1',
          toolName: 'write',
        },
      }),
      JSON.stringify({
        id: 'a4',
        parentId: 'tr4',
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done.' }],
        },
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content);

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      assistantMessageId: 'a4',
      content: 'Done.',
      role: 'assistant',
    });
    expect(messages[1].contentBlocks).toEqual([
      { type: 'thinking', content: 'Inspecting snippets' },
      { type: 'tool_use', toolId: 'ls-1' },
      { type: 'tool_use', toolId: 'ls-2' },
      { type: 'tool_use', toolId: 'read-1' },
      { type: 'thinking', content: 'Creating snippet' },
      { type: 'tool_use', toolId: 'write-1' },
      { type: 'text', content: 'Done.' },
    ]);
    expect(messages[1].toolCalls?.map(toolCall => ({
      id: toolCall.id,
      result: toolCall.result,
      status: toolCall.status,
    }))).toEqual([
      { id: 'ls-1', result: 'appearance.json\nsnippets/', status: 'completed' },
      { id: 'ls-2', result: 'existing.css', status: 'completed' },
      { id: 'read-1', result: '{"enabledCssSnippets":[]}', status: 'completed' },
      { id: 'write-1', result: 'Successfully wrote file', status: 'completed' },
    ]);
  });

  it('hydrates Pi write/edit tool calls with diff data for stored rendering', () => {
    const content = [
      JSON.stringify({
        id: 'a1',
        type: 'message',
        message: {
          role: 'assistant',
          content: [
            {
              arguments: {
                edits: [{ oldText: 'old', newText: 'new' }],
                path: 'notes/a.md',
              },
              id: 'edit-1',
              name: 'edit',
              type: 'toolCall',
            },
          ],
        },
      }),
      JSON.stringify({
        id: 'tr1',
        parentId: 'a1',
        type: 'message',
        message: {
          content: [{ text: 'Edited notes/a.md', type: 'text' }],
          details: {
            diff: '--- a/notes/a.md\n+++ b/notes/a.md\n@@ -1 +1 @@\n-old\n+new',
          },
          isError: false,
          role: 'toolResult',
          toolCallId: 'edit-1',
          toolName: 'edit',
        },
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content);

    expect(messages[0].toolCalls?.[0]).toMatchObject({
      id: 'edit-1',
      input: {
        edits: [{ oldText: 'old', newText: 'new' }],
        file_path: 'notes/a.md',
        path: 'notes/a.md',
      },
      name: 'Edit',
      result: 'Edited notes/a.md',
      status: 'completed',
    });
    expect(messages[0].toolCalls?.[0].diffData).toMatchObject({
      filePath: 'notes/a.md',
      stats: { added: 1, removed: 1 },
    });
    expect(messages[0].toolCalls?.[0].diffData?.diffLines.map(line => line.text)).toEqual(['old', 'new']);
  });

  it('resolves only the active branch path', () => {
    const entries: PiSessionEntry[] = [
      { id: 'root', raw: {}, type: 'entry' },
      { id: 'left', parentId: 'root', raw: {}, type: 'entry' },
      { id: 'right', parentId: 'root', raw: {}, type: 'entry' },
    ];

    expect(resolvePiActivePath(entries, 'left').map(entry => entry.id)).toEqual(['root', 'left']);
    expect(resolvePiActivePath(entries).map(entry => entry.id)).toEqual(['root', 'right']);
  });

  it('keeps id-less tool results attached to the active branch', () => {
    const content = [
      JSON.stringify({
        id: 'root',
        type: 'entry',
        message: { role: 'user', content: 'Read the active file' },
      }),
      JSON.stringify({
        id: 'left',
        parentId: 'root',
        type: 'entry',
        message: {
          role: 'assistant',
          content: [
            { id: 'tool-left', input: { path: 'left.md' }, name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        result: { content: [{ text: 'left contents', type: 'text' }] },
        toolCallId: 'tool-left',
        type: 'toolResult',
      }),
      JSON.stringify({
        id: 'right',
        parentId: 'root',
        type: 'entry',
        message: {
          role: 'assistant',
          content: [
            { id: 'tool-right', input: { path: 'right.md' }, name: 'read', type: 'toolCall' },
          ],
        },
      }),
      JSON.stringify({
        result: { content: [{ text: 'right contents', type: 'text' }] },
        toolCallId: 'tool-right',
        type: 'toolResult',
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content, { leafEntryId: 'left' });

    expect(messages[1].toolCalls).toEqual([{
      id: 'tool-left',
      input: { file_path: 'left.md', path: 'left.md' },
      name: 'Read',
      result: 'left contents',
      status: 'completed',
    }]);
  });

  it('ignores malformed lines and maps compaction boundaries', () => {
    const content = [
      'not-json',
      JSON.stringify({ id: 'c1', type: 'compaction' }),
    ].join('\n');

    expect(parsePiSessionContent(content)[0].contentBlocks).toEqual([{ type: 'context_compacted' }]);
  });
});
