import {
  buildCursorCreateChatLaunchSpec,
  buildCursorLaunchSpec,
} from '@/providers/cursor/runtime/CursorLaunchSpecBuilder';

describe('buildCursorLaunchSpec', () => {
  it('builds the canonical streaming arg list', () => {
    const spec = buildCursorLaunchSpec({
      cliPath: '/usr/local/bin/cursor-agent',
      prompt: 'hello world',
      envText: '',
    });

    expect(spec.command).toBe('/usr/local/bin/cursor-agent');
    expect(spec.args).toEqual([
      '--print',
      '--output-format', 'stream-json',
      '--stream-partial-output',
      '--force',
      'hello world',
    ]);
  });

  it('appends --resume when threadId is provided', () => {
    const spec = buildCursorLaunchSpec({
      cliPath: 'cursor-agent',
      prompt: 'follow up',
      envText: '',
      threadId: 'chat-123',
    });

    expect(spec.args).toContain('--resume');
    expect(spec.args[spec.args.indexOf('--resume') + 1]).toBe('chat-123');
  });

  it('appends --model when model is provided', () => {
    const spec = buildCursorLaunchSpec({
      cliPath: 'cursor-agent',
      prompt: 'q',
      envText: '',
      model: 'gpt-5',
    });

    const idx = spec.args.indexOf('--model');
    expect(idx).toBeGreaterThan(-1);
    expect(spec.args[idx + 1]).toBe('gpt-5');
  });

  it('passes --workspace and sets spawnCwd when workspaceCwd is provided', () => {
    const spec = buildCursorLaunchSpec({
      cliPath: 'cursor-agent',
      prompt: 'q',
      envText: '',
      workspaceCwd: '/Users/me/vault',
    });

    const idx = spec.args.indexOf('--workspace');
    expect(idx).toBeGreaterThan(-1);
    expect(spec.args[idx + 1]).toBe('/Users/me/vault');
    expect(spec.spawnCwd).toBe('/Users/me/vault');
  });

  it('keeps the prompt as the final positional argument', () => {
    const spec = buildCursorLaunchSpec({
      cliPath: 'cursor-agent',
      prompt: 'final prompt text',
      envText: '',
      threadId: 'chat-1',
      model: 'sonnet-4',
      workspaceCwd: '/tmp',
    });

    expect(spec.args[spec.args.length - 1]).toBe('final prompt text');
  });

  it('omits --force when autoApprove is false', () => {
    const spec = buildCursorLaunchSpec({
      cliPath: 'cursor-agent',
      prompt: 'q',
      envText: '',
      autoApprove: false,
    });
    expect(spec.args).not.toContain('--force');
  });

  it('merges env overrides with process.env', () => {
    const spec = buildCursorLaunchSpec({
      cliPath: 'cursor-agent',
      prompt: 'q',
      envText: 'CURSOR_API_KEY=abc\nCUSTOM_VAR=xyz',
    });

    expect(spec.env.CURSOR_API_KEY).toBe('abc');
    expect(spec.env.CUSTOM_VAR).toBe('xyz');
    expect(typeof spec.env.PATH).toBe('string');
  });
});

describe('buildCursorCreateChatLaunchSpec', () => {
  it('builds the create-chat invocation', () => {
    const spec = buildCursorCreateChatLaunchSpec({
      cliPath: '/usr/local/bin/cursor-agent',
      envText: 'CURSOR_API_KEY=abc',
      workspaceCwd: '/Users/me/vault',
    });

    expect(spec.command).toBe('/usr/local/bin/cursor-agent');
    expect(spec.args).toEqual(['create-chat']);
    expect(spec.spawnCwd).toBe('/Users/me/vault');
    expect(spec.env.CURSOR_API_KEY).toBe('abc');
  });
});
