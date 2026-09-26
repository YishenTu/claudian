import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { createForkTestEnvironment, type ForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';

import { ClaudeExecutionBackend } from '@/providers/claude/execution/ClaudeExecutionBackend';

function createNativeClaude() {
  const sessions = new Map<string, string[]>([['claude-source', []]]);
  const launches: sdk.Options[] = [];
  const prompts: Array<{ sessionId: string; context: string[] }> = [];
  let ordinal = 0;
  jest.spyOn(sdk, 'query').mockImplementation(({ prompt, options }) => {
    const config = options!;
    launches.push(config);
    const generator = async function* () {
      let sessionId = config.resume ?? 'claude-source';
      if (config.forkSession) {
        const source = sessions.get(sessionId)!;
        const checkpoint = source.indexOf(config.resumeSessionAt!);
        if (checkpoint < 0) throw new Error('Fork checkpoint not found');
        sessionId = 'claude-child';
        sessions.set(sessionId, source.slice(0, checkpoint + 1));
      }
      if (typeof prompt === 'string') throw new Error('Expected streaming SDK input');
      for await (const input of prompt) {
        if (input.type !== 'user') throw new Error('Expected an SDK user message');
        const context = sessions.get(sessionId)!;
        prompts.push({ sessionId, context: [...context] });
        const id = `claude-assistant-${++ordinal}`;
        yield { type: 'system', subtype: 'init', session_id: sessionId };
        yield {
          type: 'assistant', uuid: id, session_id: sessionId,
          message: { id: `msg-${ordinal}`, role: 'assistant', content: [{ type: 'text', text: `Reply ${ordinal}` }], usage: { input_tokens: 10, output_tokens: 5 } },
        };
        context.push(id);
        yield { type: 'result', subtype: 'success', session_id: sessionId, result: `Reply ${ordinal}`, is_error: false,
          duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 10, output_tokens: 5 } };
      }
    };
    return Object.assign(generator(), {
      interrupt: async () => undefined,
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      setMaxThinkingTokens: async () => undefined,
      applyFlagSettings: async () => undefined,
      setMcpServers: async () => ({ added: [], removed: [], errors: {} }),
      supportedCommands: async () => [],
      getContextUsage: async () => ({ rawMaxTokens: 200_000 }),
    }) as unknown as ReturnType<typeof sdk.query>;
  });
  return { sessions, launches, prompts };
}

describe('Claude fork integration', () => {
  let env: ForkTestEnvironment;
  beforeEach(async () => {
    env = await createForkTestEnvironment();
  });
  afterEach(async () => { await env.dispose(); jest.restoreAllMocks(); });

  it('resumes at the live SDK UUID in a new session and preserves the source and accepted input prefix', async () => {
    const native = createNativeClaude();
    const backend = new ClaudeExecutionBackend(env.host);
    const source = await env.open(backend);
    const selected = await env.send(source, 'Remember apples');
    await env.send(source, 'Remember pears');
    expect(selected.assistantMessageId).toBe('claude-assistant-1');
    const child = await env.fork(source, selected);
    expect(child?.messages).toHaveLength(2);
    const fork = await env.open(backend, child!);
    await env.send(fork, 'Continue here');
    expect(native.launches.at(-1)).toMatchObject({ resume: 'claude-source', resumeSessionAt: 'claude-assistant-1', forkSession: true });
    expect(native.prompts.at(-1)).toEqual({ sessionId: 'claude-child', context: ['claude-assistant-1'] });
    expect(child!.sessionId).toBe('claude-child');
    expect(native.sessions.get('claude-source')).toEqual(['claude-assistant-1', 'claude-assistant-2']);
    await env.send(source, 'Keep original going');
    expect(native.prompts.at(-1)).toEqual({ sessionId: 'claude-source', context: ['claude-assistant-1', 'claude-assistant-2'] });
  });

  it('surfaces an unavailable SDK checkpoint without sending a child prompt or altering the source', async () => {
    const native = createNativeClaude();
    const backend = new ClaudeExecutionBackend(env.host);
    const source = await env.open(backend);
    const selected = await env.send(source, 'Remember apples');
    const child = await env.fork(source, selected);
    native.sessions.set('claude-source', []);
    const fork = await env.open(backend, child!);
    await expect(env.send(fork, 'Cannot continue')).rejects.toThrow(/checkpoint/i);
    expect(native.sessions.get('claude-source')).toEqual([]);
    expect(native.sessions.has('claude-child')).toBe(false);
    expect(native.prompts).toHaveLength(1);
  });
});
