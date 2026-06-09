import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createPiForkSessionFile,
  parsePiSessionContent,
  parsePiSessionEntries,
  type PiSessionEntry,
  resolvePiActivePath,
  resolvePiEntryPath,
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

  it('preserves hidden XML context wrappers in raw user content', () => {
    const content = [
      JSON.stringify({
        id: 'u1',
        type: 'entry',
        message: {
          role: 'user',
          content: 'Summarize this\n\n<current_note>\nnotes/today.md\n</current_note>',
        },
      }),
    ].join('\n');

    const messages = parsePiSessionContent(content);

    expect(messages[0]).toMatchObject({
      content: 'Summarize this\n\n<current_note>\nnotes/today.md\n</current_note>',
      role: 'user',
    });
    expect(messages[0].displayContent).toBeUndefined();
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

  it('resolves a strict entry path for fork checkpoints without sibling branches', () => {
    const entries = parsePiSessionEntries([
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ id: 'u2', parentId: 'a1', type: 'message', message: { role: 'user', content: 'Next branch' } }),
      JSON.stringify({ id: 'a2', parentId: 'u2', type: 'message', message: { role: 'assistant', content: 'Later' } }),
    ].join('\n')).entries;

    expect(resolvePiEntryPath(entries, 'a1').map(entry => entry.id)).toEqual(['u1', 'a1']);
  });

  it('truncates linear Pi sessions through the requested checkpoint', () => {
    const content = [
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ id: 'u2', type: 'message', message: { role: 'user', content: 'Later' } }),
      JSON.stringify({ id: 'a2', type: 'message', message: { role: 'assistant', content: 'Do not include' } }),
    ].join('\n');
    const entries = parsePiSessionEntries(content).entries;

    expect(resolvePiEntryPath(entries, 'a1').map(entry => entry.id)).toEqual(['u1', 'a1']);
    expect(parsePiSessionContent(content, { leafEntryId: 'a1' }).map(message => message.content)).toEqual([
      'First',
      'Done',
    ]);
  });

  it('keeps id-less trailing entries during normal linear hydration', () => {
    const content = [
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ type: 'custom_message', content: 'Trailing notice' }),
    ].join('\n');

    expect(parsePiSessionContent(content).map(message => message.content)).toEqual([
      'First',
      'Done',
      'Trailing notice',
    ]);
    expect(parsePiSessionContent(content, { leafEntryId: 'a1' }).map(message => message.content)).toEqual([
      'First',
      'Done',
    ]);
  });

  it('creates a self-contained Pi fork session file at the assistant checkpoint', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fork-'));
    const sourceFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sourceFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'source-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/source-cwd' }),
      JSON.stringify({ id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'First' } }),
      JSON.stringify({ id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'Done' } }),
      JSON.stringify({ id: 'u2', parentId: 'a1', type: 'message', message: { role: 'user', content: 'Do not copy' } }),
    ].join('\n'));

    const forked = await createPiForkSessionFile(sourceFile, 'a1', {
      now: new Date('2026-02-03T04:05:06.789Z'),
      sessionId: 'fork-session',
      targetCwd: '/target-cwd',
    });
    const forkedContent = await fs.readFile(forked.sessionFile, 'utf-8');
    const forkedLines = forkedContent.trim().split('\n').map(line => JSON.parse(line));

    expect(forked).toEqual({
      leafEntryId: 'a1',
      parentSession: sourceFile,
      sessionFile: path.join(dir, '2026-02-03T04-05-06-789Z_fork-session.jsonl'),
      sessionId: 'fork-session',
    });
    expect(forkedLines).toEqual([
      {
        cwd: '/target-cwd',
        id: 'fork-session',
        parentSession: sourceFile,
        timestamp: '2026-02-03T04:05:06.789Z',
        type: 'session',
        version: 3,
      },
      { id: 'u1', parentId: null, type: 'message', message: { role: 'user', content: 'First' } },
      { id: 'a1', parentId: 'u1', type: 'message', message: { role: 'assistant', content: 'Done' } },
    ]);
  });

  it('includes active id-less tool results when creating linear Pi fork files', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-fork-linear-'));
    const sourceFile = path.join(dir, 'source.jsonl');
    await fs.writeFile(sourceFile, [
      JSON.stringify({ type: 'session', version: 3, id: 'source-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/source-cwd' }),
      JSON.stringify({ id: 'u1', type: 'message', message: { role: 'user', content: 'Read a file' } }),
      JSON.stringify({
        id: 'a1',
        type: 'message',
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
      JSON.stringify({ id: 'u2', type: 'message', message: { role: 'user', content: 'Do not copy' } }),
    ].join('\n'));

    const forked = await createPiForkSessionFile(sourceFile, 'a1', {
      now: new Date('2026-02-03T04:05:06.789Z'),
      sessionId: 'fork-session',
    });
    const forkedContent = await fs.readFile(forked.sessionFile, 'utf-8');
    const forkedLines = forkedContent.trim().split('\n').map(line => JSON.parse(line));

    expect(forkedLines.map(line => line.id)).toEqual(['fork-session', 'u1', 'a1', undefined]);
    expect(forkedLines[3]).toMatchObject({
      toolCallId: 'tool-1',
      type: 'toolResult',
    });
    expect(parsePiSessionContent(forkedContent)[1].toolCalls).toEqual([{
      id: 'tool-1',
      input: { file_path: 'a.md', path: 'a.md' },
      name: 'Read',
      result: 'file contents',
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
