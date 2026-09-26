import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as sdk from '@anthropic-ai/claude-agent-sdk';
import { createForkTestEnvironment, type ForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';

import { ClaudeExecutionBackend } from '@/providers/claude/execution/ClaudeExecutionBackend';

import { traceSideChild } from './SideChatNativeTracer';

function createNativeClaude() {
  const sessions = new Map<string, string[]>([['claude-source', []]]);
  const launches: sdk.Options[] = [];
  const prompts: Array<{ sessionId: string; context: string[]; text: string }> = [];
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
        const content = input.message.content;
        const text = typeof content === 'string'
          ? content
          : content.map(block => (block.type === 'text' ? block.text : '')).join('');
        prompts.push({ context: [...context], sessionId, text });
        const id = `claude-assistant-${++ordinal}`;
        yield { session_id: sessionId, subtype: 'init', type: 'system' };
        yield {
          message: { content: [{ text: `Reply ${ordinal}`, type: 'text' }], id: `msg-${ordinal}`, role: 'assistant', usage: { input_tokens: 10, output_tokens: 5 } },
          session_id: sessionId, type: 'assistant', uuid: id,
        };
        context.push(id);
        yield {
          duration_api_ms: 1, duration_ms: 1, is_error: false, num_turns: 1,
          result: `Reply ${ordinal}`, session_id: sessionId, subtype: 'success',
          total_cost_usd: 0, type: 'result', usage: { input_tokens: 10, output_tokens: 5 },
        };
      }
    };
    return Object.assign(generator(), {
      applyFlagSettings: async () => undefined,
      getContextUsage: async () => ({ rawMaxTokens: 200_000 }),
      interrupt: async () => undefined,
      setMaxThinkingTokens: async () => undefined,
      setMcpServers: async () => ({ added: [], errors: {}, removed: [] }),
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      supportedCommands: async () => [],
    }) as unknown as ReturnType<typeof sdk.query>;
  });
  return { launches, prompts, sessions };
}

function createToolingClaude(sideEffect: () => Promise<void>) {
  const requests: Array<{ permissionMode?: string; toolName: string; decision: string }> = [];
  jest.spyOn(sdk, 'query').mockImplementation(({ prompt, options }) => {
    const config = options!;
    const generator = async function* () {
      let sessionId = config.resume ?? 'claude-source';
      if (config.forkSession) sessionId = 'claude-child';
      if (typeof prompt === 'string') throw new Error('Expected streaming SDK input');
      for await (const _input of prompt) {
        void _input;
        yield { session_id: sessionId, subtype: 'init', type: 'system' };
        const decision = (await config.canUseTool!('Write', { file_path: 'side-note.md' }, {
          signal: new AbortController().signal, suggestions: undefined, toolUseID: 'tool-1',
        } as never))!;
        requests.push({ decision: decision.behavior, permissionMode: config.permissionMode, toolName: 'Write' });
        if (decision.behavior === 'allow') await sideEffect();
        yield {
          message: { content: [{ text: decision.behavior, type: 'text' }], id: 'msg-tool', role: 'assistant', usage: { input_tokens: 1, output_tokens: 1 } },
          session_id: sessionId, type: 'assistant', uuid: 'claude-assistant-tool',
        };
        yield {
          duration_api_ms: 1, duration_ms: 1, is_error: false, num_turns: 1, result: decision.behavior,
          session_id: sessionId, subtype: 'success', total_cost_usd: 0, type: 'result',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
    };
    return Object.assign(generator(), {
      applyFlagSettings: async () => undefined,
      getContextUsage: async () => ({ rawMaxTokens: 200_000 }),
      interrupt: async () => undefined,
      setMaxThinkingTokens: async () => undefined,
      setMcpServers: async () => ({ added: [], errors: {}, removed: [] }),
      setModel: async () => undefined,
      setPermissionMode: async () => undefined,
      supportedCommands: async () => [],
    }) as unknown as ReturnType<typeof sdk.query>;
  });
  return { requests };
}

describe('Claude side-chat native child', () => {
  let env: ForkTestEnvironment;
  beforeEach(async () => {
    env = await createForkTestEnvironment();
  });
  afterEach(async () => { await env.dispose(); jest.restoreAllMocks(); });

  it('answers from source context and its own turns while the parent keeps its own history and Claudian record', async () => {
    const native = createNativeClaude();
    const backend = new ClaudeExecutionBackend(env.host);
    const source = await env.open(backend);
    const checkpoint = await env.send(source, 'Remember A');
    const conversationsBefore = env.repository.list().map(conversation => conversation.id);

    const child = await traceSideChild(env, source, checkpoint, backend);
    const first = await child!.send('Also remember B');
    expect(first.accepted).toBe(true);
    expect(native.launches.at(-1)).toMatchObject({ forkSession: true, resume: 'claude-source', resumeSessionAt: 'claude-assistant-1' });
    expect(native.prompts.at(-1)).toMatchObject({ context: ['claude-assistant-1'], sessionId: 'claude-child' });
    expect(native.launches.at(-1)?.persistSession).toBe(false);
    expect(child!.session.canCool()).toBe(false);

    const second = await child!.send('Use A and B');
    expect(second.accepted).toBe(true);
    expect(native.prompts.at(-1)).toMatchObject({ context: ['claude-assistant-1', 'claude-assistant-2'], sessionId: 'claude-child' });

    await env.send(source, 'Continue with A only');
    expect(native.prompts.at(-1)).toMatchObject({ context: ['claude-assistant-1'], sessionId: 'claude-source' });
    expect(native.sessions.get('claude-source')).toEqual(['claude-assistant-1', 'claude-assistant-4']);
    expect(env.repository.list().map(conversation => conversation.id)).toEqual(conversationsBefore);
    await child!.dispose();
  });

  it('does not refork or resume the parent when the child continues after a later main turn', async () => {
    const native = createNativeClaude();
    const backend = new ClaudeExecutionBackend(env.host);
    const source = await env.open(backend);
    const checkpoint = await env.send(source, 'Remember A');
    const child = await traceSideChild(env, source, checkpoint, backend, {
      beforeStart: async () => { await env.send(source, 'Main moves on'); },
    });
    await child!.send('Side first');
    const forkLaunches = native.launches.filter(launch => launch.forkSession);
    expect(forkLaunches).toHaveLength(1);
    expect(forkLaunches[0]).toMatchObject({ resumeSessionAt: 'claude-assistant-1' });

    await child!.send('Side second');
    expect(native.launches.filter(launch => launch.forkSession)).toHaveLength(1);
    expect(native.prompts.at(-1)).toMatchObject({ sessionId: 'claude-child' });
    expect(native.sessions.get('claude-child')).toEqual([
      'claude-assistant-1', 'claude-assistant-3', 'claude-assistant-4',
    ]);
    await child!.dispose();
  });

  it('reports an unavailable captured checkpoint without starting the child or changing the source', async () => {
    const native = createNativeClaude();
    const backend = new ClaudeExecutionBackend(env.host);
    const source = await env.open(backend);
    const checkpoint = await env.send(source, 'Remember A');
    const child = await traceSideChild(env, source, checkpoint, backend, {
      beforeStart: async () => { native.sessions.set('claude-source', []); },
    });
    const turn = await child!.send('Cannot start');
    expect(turn.accepted).toBe(false);
    expect(turn.terminal).toBe('execution_error');
    expect(turn.errorMessage).toMatch(/checkpoint/i);
    expect(native.sessions.has('claude-child')).toBe(false);
    await child!.dispose();
  });

  it('runs a benign fixture tool under the copied permission policy and keeps its effect after disposal', async () => {
    createNativeClaude();
    const backend = new ClaudeExecutionBackend(env.host);
    const source = await env.open(backend);
    const checkpoint = await env.send(source, 'Remember A');
    const written = path.join(env.root, 'side-note.md');
    jest.restoreAllMocks();
    const tooling = createToolingClaude(async () => { await fs.writeFile(written, 'from side chat'); });

    const child = await traceSideChild(env, source, checkpoint, backend, {
      interactionPort: {
        askUserQuestion: async () => { throw new Error('Unexpected question'); },
        dismissInteraction: () => undefined,
        requestApproval: async request => ({ decision: 'allow', interactionId: request.interactionId }),
      },
    });
    const turn = await child!.send('Write a note');
    expect(turn.terminal).toBe('turn_completed');
    expect(tooling.requests).toEqual([{ decision: 'allow', permissionMode: 'acceptEdits', toolName: 'Write' }]);
    await child!.dispose();
    expect(await fs.readFile(written, 'utf8')).toBe('from side chat');
  });

  it('denies a fixture tool when the side owner rejects the approval', async () => {
    createNativeClaude();
    const backend = new ClaudeExecutionBackend(env.host);
    const source = await env.open(backend);
    const checkpoint = await env.send(source, 'Remember A');
    const written = path.join(env.root, 'denied-note.md');
    jest.restoreAllMocks();
    const tooling = createToolingClaude(async () => { await fs.writeFile(written, 'should not exist'); });

    const child = await traceSideChild(env, source, checkpoint, backend, {
      interactionPort: {
        askUserQuestion: async () => { throw new Error('Unexpected question'); },
        dismissInteraction: () => undefined,
        requestApproval: async request => ({ decision: 'deny', interactionId: request.interactionId }),
      },
    });
    const turn = await child!.send('Write a note');
    expect(turn.terminal).toBe('turn_completed');
    expect(tooling.requests.at(-1)?.decision).toBe('deny');
    await expect(fs.access(written)).rejects.toThrow();
    await child!.dispose();
  });
});
