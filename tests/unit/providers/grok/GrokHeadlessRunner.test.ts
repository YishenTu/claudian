import {
  buildGrokHeadlessArgs,
  extractGrokEventError,
  extractGrokEventText,
  extractGrokSessionId,
} from '@/providers/grok/runtime/GrokHeadlessRunner';

describe('GrokHeadlessRunner helpers', () => {
  it('builds headless args with streaming JSON and sandbox profile', () => {
    expect(buildGrokHeadlessArgs({
      cwd: '/vault',
      promptFile: '/tmp/prompt.txt',
      model: 'grok-4.5',
      effort: 'high',
      sessionId: 'sess-1',
      permissionMode: 'normal',
      safeMode: 'workspace',
      systemRules: 'Be concise',
    })).toEqual([
      '--cwd',
      '/vault',
      '--no-alt-screen',
      '--output-format',
      'streaming-json',
      '-m',
      'grok-4.5',
      '--effort',
      'high',
      '--system-prompt-override',
      'Be concise',
      '--resume',
      'sess-1',
      '--sandbox',
      'workspace',
      '--prompt-file',
      '/tmp/prompt.txt',
    ]);
  });

  it('uses always-approve for yolo and plan permission mode when selected', () => {
    expect(buildGrokHeadlessArgs({
      cwd: '/vault',
      promptFile: '/tmp/p.txt',
      permissionMode: 'yolo',
    })).toContain('--always-approve');

    expect(buildGrokHeadlessArgs({
      cwd: '/vault',
      promptFile: '/tmp/p.txt',
      permissionMode: 'plan',
    })).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
  });

  it('extracts assistant text and session ids from streaming events', () => {
    expect(extractGrokEventText({
      method: 'session/update',
      params: {
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      },
    })).toBe('hello');

    expect(extractGrokSessionId({
      params: { sessionId: 'abc-123' },
    })).toBe('abc-123');

    expect(extractGrokEventError({
      type: 'error',
      message: 'boom',
    })).toBe('boom');
  });
});
