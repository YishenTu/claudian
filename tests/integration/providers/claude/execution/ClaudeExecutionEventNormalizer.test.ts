import { buildSDKMessage } from '@test/helpers/sdkMessages';

import { encodeSessionMessage } from '@/core/session-tools/sessionMessageEnvelope';
import { ClaudeExecutionEventNormalizer } from '@/providers/claude/execution/ClaudeExecutionEventNormalizer';
import { parseSDKMessageToChat } from '@/providers/claude/history/sdkMessageParsing';

const msg = buildSDKMessage;

describe('ClaudeExecutionEventNormalizer tool calls', () => {
  it('maps Linux file input and patch paths at the neutral event boundary', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();
    const executionTarget = { method: 'wsl', platformFamily: 'unix', platformOs: 'linux', distroName: 'Ubuntu' } as const;
    const native = msg({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit',
      input: { file_path: '/mnt/c/Vault/note.md', old_string: '/home/me/literal text', new_string: 'text' },
    }] } });
    expect(normalizer.normalize(native, 'requested', { executionTarget })).toContainEqual(expect.objectContaining({
      type: 'output', event: expect.objectContaining({ type: 'tool_started', input: {
        file_path: 'C:\\Vault\\note.md', old_string: '/home/me/literal text', new_string: 'text',
      } }),
    }));
    expect(native).toMatchObject({ message: { content: [{ input: { file_path: '/mnt/c/Vault/note.md' } }] } });
    const result = normalizer.normalize(msg({ type: 'user', message: { content: [{
      type: 'tool_result', tool_use_id: 'edit-1', content: 'edited',
    }] }, tool_use_result: { filePath: '/home/me/vault/note.md', structuredPatch: [{
      oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'],
    }] } }), 'requested', { executionTarget });
    expect(result).toContainEqual(expect.objectContaining({ type: 'output', event: expect.objectContaining({
      type: 'tool_completed', resultDetails: expect.objectContaining({ diff: expect.objectContaining({
        filePath: '\\\\wsl$\\Ubuntu\\home\\me\\vault\\note.md',
      }) }),
    }) }));
  });

  it('passes a subagent tool call through under its native name and subagent scope', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();
    const events = normalizer.normalize(msg({
      type: 'assistant',
      parent_tool_use_id: 'agent-1',
      message: {
        content: [{
          type: 'tool_use',
          id: 'create-1',
          name: 'TaskCreate',
          input: { subject: 'Subagent work' },
        }],
      },
    }), 'requested');

    expect(events).toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({
        type: 'tool_started',
        toolCallId: 'create-1',
        name: 'TaskCreate',
        toolScope: { kind: 'subagent', subagentId: 'agent-1' },
      }),
    }));
  });
});

describe('ClaudeExecutionEventNormalizer tool results', () => {
  function completeTool(name: string, input: Record<string, unknown>, toolUseResult: unknown, content = 'done') {
    const normalizer = new ClaudeExecutionEventNormalizer();
    normalizer.normalize(msg({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool-1', name, input }] },
    }), 'requested');
    const events = normalizer.normalize(msg({
      type: 'user',
      tool_use_result: toolUseResult,
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content }] },
    }), 'requested');
    const completed = events.find(event => event.type === 'output' && event.event.type === 'tool_completed');
    if (completed?.type !== 'output' || completed.event.type !== 'tool_completed') throw new Error('Missing completion');
    return completed.event;
  }

  it.each([false, true])('decodes a native structured patch without displaying EOF markers (markers: %s)', markers => {
    const completed = completeTool('Edit', { file_path: 'notes/a.md', old_string: 'old', new_string: 'new' }, {
      filePath: '/vault/notes/a.md',
      oldString: 'old',
      newString: 'new',
      structuredPatch: [{
        oldStart: 3, oldLines: 2, newStart: 3, newLines: 2,
        lines: [' keep', '-old', ...(markers ? ['\\ No newline at end of file'] : []),
          '+new', ...(markers ? ['\\ No newline at end of file'] : [])],
      }],
    });

    expect(completed.resultDetails).toEqual({
      diff: {
        filePath: '/vault/notes/a.md',
        diffLines: [
          { type: 'equal', text: 'keep', oldLineNum: 3, newLineNum: 3 },
          { type: 'delete', text: 'old', oldLineNum: 4 },
          { type: 'insert', text: 'new', newLineNum: 4 },
        ],
        stats: { added: 1, removed: 1 },
      },
    });
    expect(completed.providerPayload).toBeUndefined();
  });


  it('keeps a subagent result native for the task-result interpreter', () => {
    const launch = { isAsync: true, status: 'async_launched', agentId: 'agent-1' };
    const completed = completeTool('Agent', { description: 'Research', run_in_background: true }, launch, 'Launched');

    expect(completed.providerPayload).toEqual({ rawOutput: launch });
    expect(completed.resultDetails).toBeUndefined();
  });
});

describe('ClaudeExecutionEventNormalizer api error messages', () => {
  const RESET_TEXT = "You've hit your session limit · resets 4:10pm (Europe/Berlin)";
  const AUTH_FALLBACK = 'Claude authentication failed. Sign in again or check your API key.';

  const apiErrorMessage = (content: unknown[], error = 'rate_limit') => msg({
    type: 'assistant',
    error,
    isApiErrorMessage: true,
    apiErrorStatus: error === 'rate_limit' ? 429 : 401,
    message: { model: '<synthetic>', content },
  });

  function expectAuthenticationOverrideGuidance(message: string): void {
    expect(message).toContain('If the same CLI works with a subscription separately');
    expect(message).toContain('inherited ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN');
    expect(message).toContain('Settings → Claudian → Providers → Claude Code → Environment → Custom variables');
    expect(message).toContain('Claude only');
    expect(message).toContain('only for the conflicting credential you intend to disable');
    expect(message).toContain('ANTHROPIC_API_KEY=');
    expect(message).toContain('ANTHROPIC_AUTH_TOKEN=');
    expect(message).not.toMatch(/subscription (?:was |has been )?detected/i);
    expect(message).not.toMatch(/process\.env/);
  }

  function nativeError(events: ReturnType<ClaudeExecutionEventNormalizer['normalize']>): string {
    const error = events.find(event => event.type === 'native_error');
    if (error?.type !== 'native_error') throw new Error('Missing native error');
    return error.message;
  }

  it('uses the human-readable text of a synthetic API error message as the native error message', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(
      apiErrorMessage([{ type: 'text', text: RESET_TEXT }]),
      'requested',
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: RESET_TEXT,
    }));
  });

  it('does not also emit the API error text as assistant output', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(
      apiErrorMessage([{ type: 'text', text: RESET_TEXT }]),
      'requested',
    );

    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({ type: 'text_delta' }),
    }));
    expect(events).not.toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({ type: 'assistant_message_started' }),
    }));
  });

  it('falls back to the described error code when the API error message has no text block', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(apiErrorMessage([]), 'requested');

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: 'Claude rate limit reached. Try again later.',
    }));
  });

  it('falls back to the described error code when the API error text is only whitespace', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(
      apiErrorMessage([{ type: 'text', text: '  \n\t ' }]),
      'requested',
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: 'Claude rate limit reached. Try again later.',
    }));
  });

  it('ignores the (no content) placeholder on API error messages', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(
      apiErrorMessage([{ type: 'text', text: '(no content)' }]),
      'requested',
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: 'Claude rate limit reached. Try again later.',
    }));
  });

  it('joins multiple text blocks of an API error message', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(
      apiErrorMessage([
        { type: 'text', text: 'first line' },
        { type: 'text', text: 'second line' },
      ]),
      'requested',
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: 'first line\nsecond line',
    }));
  });

  it('surfaces API error text even after partial text streamed earlier in the turn', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    normalizer.normalize(msg({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Partial ' },
      },
    }), 'requested');

    const events = normalizer.normalize(
      apiErrorMessage([{ type: 'text', text: RESET_TEXT }]),
      'requested',
    );

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: RESET_TEXT,
    }));
  });

  it('keeps partial prose as a reply for an error on a real model message', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(msg({
      type: 'assistant',
      error: 'max_output_tokens',
      message: {
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'Partial response' }],
      },
    }), 'requested');

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: 'Claude reached the output token limit for this response.',
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({ type: 'text_delta', text: 'Partial response' }),
    }));
  });

  it('uses synthetic max_output_tokens prose as the error without echoing it as a reply', () => {
    const prose = "API Error: Claude's response exceeded the 32000 output token maximum.";
    const events = new ClaudeExecutionEventNormalizer().normalize(msg({
      type: 'assistant',
      error: 'max_output_tokens',
      message: { model: '<synthetic>', content: [{ type: 'text', text: prose }] },
    }), 'requested');

    expect(events).toContainEqual({ type: 'native_error', message: prose });
    expect(events.filter(event => event.type === 'output')).toEqual([]);
  });

  it('keeps native authentication prose and adds provider-only override guidance without assistant text', () => {
    const prose = 'API Error: 401 Invalid authentication credentials';
    const inheritedKey = 'sk-ant-test-inherited-key';
    const inheritedToken = 'sk-ant-test-inherited-token';
    const previousKey = process.env.ANTHROPIC_API_KEY;
    const previousToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = inheritedKey;
    process.env.ANTHROPIC_AUTH_TOKEN = inheritedToken;
    try {
      const events = new ClaudeExecutionEventNormalizer().normalize(
        apiErrorMessage([{ type: 'text', text: prose }], 'authentication_failed'),
        'requested',
      );
      const message = nativeError(events);

      expect(message.startsWith(prose)).toBe(true);
      expect(message).not.toBe(prose);
      expectAuthenticationOverrideGuidance(message);
      expect(message).not.toContain(inheritedKey);
      expect(message).not.toContain(inheritedToken);
      expect(events.filter(event => event.type === 'output')).toEqual([]);
    } finally {
      if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousKey;
      if (previousToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
      else process.env.ANTHROPIC_AUTH_TOKEN = previousToken;
    }
  });

  it.each([
    ['empty', []],
    ['whitespace', [{ type: 'text', text: '  \n\t ' }]],
  ])('appends the override hint to the fallback when synthetic authentication content is %s', (_label, content) => {
    const events = new ClaudeExecutionEventNormalizer().normalize(
      apiErrorMessage(content, 'authentication_failed'),
      'requested',
    );
    const message = nativeError(events);

    expect(message.startsWith(AUTH_FALLBACK)).toBe(true);
    expect(message).not.toContain('  \n\t ');
    expectAuthenticationOverrideGuidance(message);
    expect(events.filter(event => event.type === 'output')).toEqual([]);
  });

  it('keeps partial assistant text when a real model message fails authentication', () => {
    const events = new ClaudeExecutionEventNormalizer().normalize(msg({
      type: 'assistant',
      error: 'authentication_failed',
      message: {
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'Partial response' }],
      },
    }), 'requested');
    const message = nativeError(events);

    expect(message.startsWith(AUTH_FALLBACK)).toBe(true);
    expect(message).not.toContain('Partial response');
    expectAuthenticationOverrideGuidance(message);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({ type: 'text_delta', text: 'Partial response' }),
    }));
  });

  it('leaves synthetic assistant messages without an error field unchanged', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(msg({
      type: 'assistant',
      message: {
        model: '<synthetic>',
        content: [{ type: 'text', text: 'No response requested.' }],
      },
    }), 'requested');

    expect(events).not.toContainEqual(expect.objectContaining({ type: 'native_error' }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'output',
      event: expect.objectContaining({ type: 'text_delta', text: 'No response requested.' }),
    }));
  });

  it('keeps result-error messages using the transformer content', () => {
    const normalizer = new ClaudeExecutionEventNormalizer();

    const events = normalizer.normalize(msg({
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['SDK reported an execution error'],
    }), 'requested');

    expect(events).toContainEqual(expect.objectContaining({
      type: 'native_error',
      message: 'SDK reported an execution error',
    }));
  });
});

describe('Claude task notification presentation', () => {
  it.each([false, true])('settles tasks without inserting transcript content with background transition=%s', backgrounded => {
    const normalizer = new ClaudeExecutionEventNormalizer();
    normalizer.normalize(msg({ type: 'system', subtype: 'task_started', task_id: 'sync',
      tool_use_id: 'sync-tool', is_backgrounded: false }), 'requested');
    if (backgrounded) {
      normalizer.normalize(msg({ type: 'system', subtype: 'task_updated', task_id: 'sync',
        patch: { is_backgrounded: true } }), 'requested');
    }
    // Native tasks outlive requested turns and may complete on the background channel.
    normalizer.reset('requested');
    const events = normalizer.normalize(msg({ type: 'system', subtype: 'task_notification',
      task_id: 'sync', tool_use_id: 'sync-tool', status: 'completed', summary: 'Agent answer' }), 'background');
    expect(events).toContainEqual(expect.objectContaining({ type: 'async_subagent_completion' }));
    expect(events.filter(event => event.type === 'output')).toEqual([]);
    // Resuming a foreground agent registers it in the background under the same task ID.
    normalizer.normalize(msg({ type: 'system', subtype: 'task_started', task_id: 'sync',
      is_backgrounded: true }), 'requested');
    const resumed = normalizer.normalize(msg({ type: 'system', subtype: 'task_notification',
      task_id: 'sync', status: 'completed', summary: 'Second answer' }), 'background');
    expect(resumed).toContainEqual(expect.objectContaining({ type: 'async_subagent_completion' }));
    expect(resumed.filter(event => event.type === 'output')).toEqual([]);
  });

  it.each(['b0ziu71bi', 'af5dfc0e508259ca4'])('exposes completion content only as lifecycle for task %s', (taskId) => {
    const events = new ClaudeExecutionEventNormalizer().normalize(msg({
      type: 'system', subtype: 'task_notification', task_id: taskId,
      status: 'completed', summary: 'Background work finished.',
    }), 'background');
    expect(events).toContainEqual({
      type: 'async_subagent_completion', event: expect.objectContaining({ result: 'Background work finished.' }),
    });
  });

  it('does not display native notifications excluded from the transcript', () => {
    const events = new ClaudeExecutionEventNormalizer().normalize(msg({
      type: 'system', subtype: 'task_notification', task_id: 'watcher',
      status: 'completed', summary: 'Watcher update.', skip_transcript: true,
    }), 'background');
    expect(events.filter(event => event.type === 'output')).toEqual([]);
  });
});

it('uses main-only SDK result usage and wall duration, excluding cumulative model usage', () => {
  const normalizer = new ClaudeExecutionEventNormalizer();
  const events = normalizer.normalize(msg({ type: 'result', subtype: 'success',
    duration_ms: 2500, duration_api_ms: 1000, usage: { output_tokens: 125 },
    modelUsage: { child: { outputTokens: 900 } },
  }), 'requested');
  expect(events).toContainEqual({ type: 'result', turnStats: { outputTokens: 125, durationMs: 2500 } });
});

it('omits throughput for success-subtype API errors', () => {
  const events = new ClaudeExecutionEventNormalizer().normalize(msg({ type: 'result', subtype: 'success',
    is_error: true, api_error_status: 500, duration_ms: 2500, usage: { output_tokens: 125 },
  }), 'requested');
  expect(events.find(event => event.type === 'result')).not.toHaveProperty('turnStats', expect.anything());
});

describe('Claude session message normalization', () => {
  it.each(['claudian_list_destinations', 'claudian_send_message'])('normalizes %s in live output and native history', name => {
    const rawName = `mcp__claudian_sessions__${name}`;
    const native = { type: 'assistant' as const, message: { content: [
      { type: 'tool_use' as const, id: 'session-tool', name: rawName, input: {} },
    ] } };
    const expected = { name, providerPayload: { rawName } };
    expect(new ClaudeExecutionEventNormalizer().normalize(msg(native), 'requested'))
      .toContainEqual(expect.objectContaining({ type: 'output', event: expect.objectContaining(expected) }));
    expect(parseSDKMessageToChat(native)?.toolCalls?.[0]).toMatchObject(expected);
  });

  it('retains the sender and unwraps a session envelope in history', () => {
    const content = encodeSessionMessage({ from: 'Research', sessionId: 'sender', text: 'Found it' });
    expect(parseSDKMessageToChat({ type: 'user', message: { content } })).toMatchObject({
      displayContent: 'Found it', sessionMessage: { from: 'Research', sessionId: 'sender' },
    });
  });
});
