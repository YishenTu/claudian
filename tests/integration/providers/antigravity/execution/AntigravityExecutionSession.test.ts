import * as fs from 'node:fs/promises';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { deferred } from '@test/helpers/ChatInputHarness';
import { answerApproval } from '@test/helpers/features/chat/approvalDecisionOptions';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { AntigravityNativeProcess,type CapturedAntigravityAgent } from '@test/helpers/providers/antigravity/AntigravityNativeProcess';
import { testDate, testTime } from '@test/helpers/testClock';
import { readWSLExec } from '@test/helpers/WSLLaunch';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import spawn from 'cross-spawn';

import { InlineEditService } from '@/core/auxiliary/InlineEditService';
import type {
  ProviderApprovalInteractionRequest,
  ProviderExecutionEvent,
  ProviderExecutionRequest,
  ProviderExecutionSession,
  ProviderInteractionPort,
  ProviderQuestionInteractionRequest,
  ProviderSessionConfig,
  ProviderSessionEvent,
  SteerableExecutionSession,
} from '@/core/execution';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ACPRequestPermissionRequest } from '@/providers/acp';
import { AntigravityExecutionBackend } from '@/providers/antigravity/execution/AntigravityExecutionBackend';
import { resolveAntigravityTranscriptPaths } from '@/providers/antigravity/history/AntigravityHistoryPaths';
import { updateAntigravityProviderSettings } from '@/providers/antigravity/settings';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));
// Forward the real filesystem, permitting faults only at its external I/O boundary.
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>() }));

const sessions: ProviderExecutionSession[] = [];
let spawned: AntigravityNativeProcess[] = [];
let vault: string;
const agents = new Map<string, CapturedAntigravityAgent>();
let spawnWaiters: Array<{ count: number; resolve: () => void }> = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(sessions.splice(0).map(session => session.dispose()));
  spawned = [];
  agents.clear();
  spawnWaiters = [];
  vi.mocked(spawn).mockReset();
  vi.restoreAllMocks();
});

async function createHost(overrides: Partial<ProviderHost> = {}): Promise<ProviderHost> {
  const { host } = await createProviderHostFixture({
    overrides: { getResolvedProviderCliPath: async () => 'agy', ...overrides },
    settings: { providerConfigs: { antigravity: { enabled: true } } },
  });
  vault = host.workingDirectory!;
  // agy's native store follows HOME; keep it inside the test vault.
  updateAntigravityProviderSettings(host.settings, { environmentVariables: `HOME=${vault}\nUSERPROFILE=${vault}` });
  return host;
}

/** Writes agy's full transcript for a native session under the test HOME, atomically for watchers. */
async function writeTranscript(sessionId: string, steps: readonly Record<string, unknown>[]): Promise<void> {
  const [transcriptPath] = resolveAntigravityTranscriptPaths(path.join(vault, '.gemini', 'antigravity-cli'), sessionId);
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  const temporary = `${transcriptPath}.tmp`;
  await writeFile(temporary, steps.map(step => JSON.stringify(step)).join('\n') + '\n');
  await rename(temporary, transcriptPath);
}

/** agy's transcript steps for a delegation. */
const transcriptSteps = {
  user: (index: number, text: string, at: string) => ({ content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`, created_at: at, source: 'USER_EXPLICIT', status: 'DONE', step_index: index, type: 'USER_INPUT' }),
  delegate: (index: number, at: string) => ({ created_at: at, status: 'DONE', step_index: index, tool_calls: [{ args: { Prompt: 'What is 17 * 23?', TypeName: 'self' }, name: 'invoke_subagent' }], type: 'PLANNER_RESPONSE' }),
  created: (index: number, subagent: string, at: string) => ({ content: `Created At: ${at}\nCreated the following subagent:\n{\n  "conversationId":  "${subagent}"\n}`, created_at: at, status: 'DONE', step_index: index, type: 'GENERIC' }),
  reply: (index: number, text: string, at: string) => ({ content: text, created_at: at, input_tokens: 100, status: 'DONE', step_index: index, type: 'PLANNER_RESPONSE' }),
};

/** The live update agy streams when the model delegates to a subagent. */
function invokeSubagent(toolCallId: string) {
  const rawInput = { Prompt: 'What is 17 * 23?', TypeName: 'self' };
  return { kind: 'other', name: 'invoke_subagent', rawInput, sessionUpdate: 'tool_call', status: 'in_progress', title: 'Run invoke_subagent', toolCallId };
}

/**
 * Collects the next background turn the session publishes. `reached` resolves once it has `count` events of `type`;
 * `completed` resolves with all its events when it completes.
 */
function backgroundTurn(session: ProviderExecutionSession) {
  const events: ProviderSessionEvent[] = [];
  const waiters: Array<{ count: number; resolve: () => void; type: ProviderSessionEvent['type'] }> = [];
  const countOf = (type: ProviderSessionEvent['type']) => events.filter(event => event.type === type).length;
  let resolveCompleted!: (events: ProviderSessionEvent[]) => void;
  const completed = new Promise<ProviderSessionEvent[]>(resolve => { resolveCompleted = resolve; });
  const unsubscribe = session.onEvent(event => {
    if (event.scope.kind !== 'background') return;
    events.push(event);
    for (const waiter of waiters.filter(entry => countOf(entry.type) >= entry.count)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
    if (event.type !== 'background_turn_completed') return;
    unsubscribe();
    resolveCompleted(events);
  });
  return {
    completed,
    events,
    reached: (type: ProviderSessionEvent['type'], count = 1) => (countOf(type) >= count
      ? Promise.resolve()
      : new Promise<void>(resolve => { waiters.push({ count, resolve, type }); })),
  };
}

function textOf(events: readonly (ProviderSessionEvent | ProviderExecutionEvent)[]): string[] {
  return events.flatMap(event => (event.type === 'text_delta' ? [event.text] : []));
}

function createInteractionPort() {
  return {
    askUserQuestion: vi.fn<ProviderInteractionPort['askUserQuestion']>(),
    dismissInteraction: vi.fn<ProviderInteractionPort['dismissInteraction']>(),
    requestApproval: vi.fn<ProviderInteractionPort['requestApproval']>(),
  } satisfies ProviderInteractionPort;
}

async function createSession(
  overrides: Partial<ProviderSessionConfig> = {},
  peerSetup: (peer: AntigravityNativeProcess) => void = () => {},
  hostOverrides: Partial<ProviderHost> = {},
): Promise<ProviderExecutionSession & SteerableExecutionSession> {
  vi.mocked(spawn).mockImplementation((_command, args) => {
    const index = args?.indexOf('--agent') ?? -1;
    const peer = new AntigravityNativeProcess(index >= 0 ? args?.[index + 1] : undefined, agents);
    peerSetup(peer);
    spawned.push(peer);
    spawnWaiters = spawnWaiters.filter(waiter => (spawned.length >= waiter.count ? (waiter.resolve(), false) : true));
    return peer.child;
  });
  const backend = new AntigravityExecutionBackend((await createHost(hostOverrides)).getRuntimeHost('antigravity'));
  const session = backend.createSession({
    interactionPort: createInteractionPort(),
    lifecycle: 'persistent',
    nativePersistence: 'enabled',
    workingDirectory: vault,
    ...overrides,
  }) as ProviderExecutionSession & SteerableExecutionSession;
  sessions.push(session);
  return session;
}

function request(
  text = 'hello',
  options: { instructions?: string; model?: string; permissionMode?: string; reasoning?: string } = {},
): ProviderExecutionRequest {
  return {
    configuration: {
      model: options.model ?? 'antigravity/gemini-4-argon',
      permissionMode: options.permissionMode ?? 'normal',
      reasoning: options.reasoning ?? 'high',
      systemInstructions: { instructions: options.instructions ?? 'Be exact.', kind: 'main-agent' },
    },
    input: [{ text, type: 'text' }],
    signal: new AbortController().signal,
    toolPolicy: { kind: 'provider-default' },
  };
}

function titleRequest(instructions = 'Title only.'): ProviderExecutionRequest {
  return {
    ...request(),
    configuration: { ...request().configuration, systemInstructions: { kind: 'explicit', purpose: 'title', instructions } },
    toolPolicy: { kind: 'passive' },
  };
}

/** The ACP session `_meta` agy 1.5.7 reads as a system-prompt append. */
function appendMeta(append: string) {
  return { antigravity: { systemPrompt: { append } } };
}

async function collect(events: AsyncIterable<ProviderExecutionEvent>): Promise<ProviderExecutionEvent[]> {
  const collected: ProviderExecutionEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

/** Resolves when the session has spawned its `count`-th agy process. */
async function spawnedProcess(count: number): Promise<AntigravityNativeProcess> {
  if (spawned.length < count) await new Promise<void>(resolve => { spawnWaiters.push({ count, resolve }); });
  return spawned[count - 1];
}

async function firstPeer(): Promise<AntigravityNativeProcess> {
  return spawnedProcess(1);
}

function permissionRequest(name: string, sessionId = 'session-new'): ACPRequestPermissionRequest {
  return {
    options: [
      { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
      { kind: 'reject_once', name: 'Deny', optionId: 'reject' },
    ],
    sessionId,
    toolCall: { kind: 'edit', name, title: name, toolCallId: 'tool-1' } as ACPRequestPermissionRequest['toolCall'],
  };
}

describe('AntigravityExecutionSession', () => {
  it('holds the first prompt until the immediate resume delivers the system prompt', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const list = vi.fn(async () => ({ sessions: [] }));
    const session = await createSession({ sessionTools: { list, read: vi.fn(), send: vi.fn() } }, peer => {
      peer.resumeGate = async () => {
        entered.resolve();
        await release.promise;
      };
    });
    const run = session.execute(request('hello', { instructions: 'Be exact.' }));
    const peer = await firstPeer();
    await entered.promise;
    expect(session.getSnapshot()).toMatchObject({ providerSessionId: 'session-new', providerState: { nativeConversationContextEstablished: false } });
    expect(peer.prompts).toHaveLength(0);
    release.resolve();
    await peer.waitForPrompts(1);
    // The first turn already runs under the prompt; a creation append would be stored and could not be replaced.
    expect(peer.prompts[0].appendsAtReceipt).toEqual(['Be exact.']);
    expect(peer.prompts[0].mcpServersAtReceipt).toEqual(peer.newRequests[0].mcpServers);
    expect(peer.resumeRequests[0].mcpServers).toEqual(peer.newRequests[0].mcpServers);
    await peer.callMCP('session-new', 'claudian_list_destinations', {});
    expect(list).toHaveBeenCalledTimes(1);
    peer.finishPrompt();
    await collect(run.events);
  });

  it('applies configuration from the immediate resume rather than stale session/new options', async () => {
    const session = await createSession({}, peer => {
      peer.resumeGate = () => {
        peer.configOptions = peer.configOptions.map(option => option.id === 'thought_level'
          ? { ...option, currentValue: 'high' } : option);
      };
    });
    const run = session.execute(request());
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    expect(peer.configRequests).toEqual([]);
    peer.finishPrompt();
    await collect(run.events);
  });

  it.each(['Resume temporarily rejected', 'Failed to read session session-new'])('retains the created id after %s and retries with the current route', async failure => {
    const first = await createSession({}, peer => { peer.resumeGate = () => { throw new Error(failure); }; });
    const failed = await collect(first.execute(request()).events);
    expect(failed.at(-1)).toMatchObject({ type: 'execution_error', recoverable: true, category: 'unknown' });
    expect(first.getSnapshot().providerSessionId).toBe('session-new');
    expect(spawned[0].prompts).toHaveLength(0);
    spawned[0].resumeGate = () => {};
    const retry = first.execute(request());
    await spawned[0].waitForPrompts(1);
    expect(spawned[0].newRequests).toHaveLength(1);
    expect(spawned[0].resumeRequests.map(value => value.sessionId)).toEqual(['session-new', 'session-new']);
    spawned[0].finishPrompt();
    await collect(retry.events);
    await first.dispose();
    // A fresh execution owner rebinds the retained session to a new host's MCP route.
    const list = vi.fn(async () => ({ sessions: [] }));
    const restored = await createSession({
      resumeSeed: { providerSessionId: 'session-new', providerState: first.getSnapshot().providerState },
      sessionTools: { list, read: vi.fn(), send: vi.fn() },
    });
    const run = restored.execute(request());
    const peer = await spawnedProcess(2);
    await peer.waitForPrompts(1);
    await peer.callMCP('session-new', 'claudian_list_destinations', {});
    expect(list).toHaveBeenCalledTimes(1);
    expect(peer.newRequests).toHaveLength(0);
    expect(peer.agentName).toBeUndefined();
    peer.finishPrompt();
    await collect(run.events);
  });

  it('retires a process cancelled between creation and resume without losing the native id', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const session = await createSession({}, peer => {
      peer.resumeGate = async () => { entered.resolve(); await release.promise; };
    });
    const run = session.execute(request());
    const peer = await firstPeer();
    await entered.promise;
    session.cancel();
    expect((await collect(run.events)).at(-1)).toMatchObject({ type: 'cancelled' });
    expect(peer.child.killed).toBe(true);
    expect(peer.prompts).toHaveLength(0);
    expect(session.getSnapshot().providerSessionId).toBe('session-new');
    release.resolve();
    const retry = session.execute(request());
    const next = await spawnedProcess(2);
    await next.waitForPrompts(1);
    expect(next.newRequests).toHaveLength(0);
    expect(next.agentName).toBeUndefined();
    next.finishPrompt();
    await collect(retry.events);
  });

  it.each([
    ['foreign', 'Someone else', 'Personal instructions.'],
    ['near-match description', 'Managed by Claudian. Do not edit. (customized)', 'Personal instructions.'],
    ['body-only marker', 'Someone else', 'Managed by Claudian. Do not edit.'],
  ].map(([label, description, body]) => [label, [
    '---', 'name: claudian-title', `description: ${description}`, 'mainAgent: true',
    'subagent: false', 'excludeDefaultComponents: true', 'tools: [read_file]', '---', body,
  ].join('\n')]).concat([
    ['malformed', '---\ndescription: [broken\n---\nbody'],
  ]))('refuses a %s file without changing it or creating a native session', async (_label, contents) => {
    const session = await createSession({}, peer => {
      void peer.waitForPrompts(1).then(() => peer.finishPrompt());
    });
    const file = path.join(vault, '.agents/agents/claudian-title/agent.md');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
    const events = await collect(session.execute(titleRequest()).events);
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: expect.stringContaining(file) });
    expect(await readFile(file, 'utf8')).toBe(contents);
    expect(spawned.flatMap(peer => peer.newRequests)).toEqual([]);
    expect(await readdir(path.dirname(file))).toEqual(['agent.md']);
  });

  it('captures native default-agent fallback when the selected file disappears before creation', async () => {
    const session = await createSession({}, peer => {
      void peer.waitForPrompts(1).then(() => peer.finishPrompt());
    }, {
      getResolvedProviderCliPath: async () => {
        await fs.unlink(path.join(vault, '.agents/agents/claudian-title/agent.md'));
        return 'agy';
      },
    });
    const events = await collect(session.execute(titleRequest()).events);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(spawned[0].agentName).toBe('claudian-title');
    expect(agents.get('session-new')).toEqual({ kind: 'default' });
    expect(spawned[0].newRequests).toHaveLength(1);
    expect(spawned[0].prompts).toHaveLength(1);
  });

  it.each(['readFile', 'mkdir', 'writeFile', 'rename'] as const)('preserves owned content and removes its temporary file on %s failure', async operation => {
    const first = await createSession();
    const cwd = vault;
    const run = first.execute(titleRequest());
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(run.events);
    const file = path.join(cwd, '.agents/agents/claudian-title/agent.md');
    const original = await readFile(file, 'utf8');
    await writeFile(path.join(path.dirname(file), 'user-note.md'), 'Keep this too.');
    const next = await createSession({ workingDirectory: cwd });
    const error = Object.assign(new Error(`Injected ${operation} failure`), { code: 'EACCES' });
    const fault = vi.spyOn(fs, operation).mockRejectedValueOnce(error);
    const events = await collect(next.execute(titleRequest('Changed prompt.')).events);
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: expect.stringContaining(file) });
    expect(fault).toHaveBeenCalled();
    fault.mockRestore();
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await readdir(path.dirname(file))).toEqual(['agent.md', 'user-note.md']);
    expect(spawned.flatMap(peer => peer.newRequests)).toHaveLength(1);
  });

  it('rewrites an owned file only for a changed new conversation', async () => {
    const first = await createSession();
    const cwd = vault;
    const run = first.execute(titleRequest('Be exact.'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(run.events);
    const file = path.join(cwd, '.agents/agents/claudian-title/agent.md');
    const initial = await stat(file);
    const stats = [];
    for (const [index, instructions] of ['Be exact.', 'New instructions.'].entries()) {
      const session = await createSession({ workingDirectory: cwd }, peer => { peer.newSessionId = `session-${index}`; });
      const nextRun = session.execute(titleRequest(instructions));
      const next = await spawnedProcess(index + 2);
      await next.waitForPrompts(1);
      expect(next.agents.get(`session-${index}`)).toMatchObject({ kind: 'custom', body: expect.stringMatching(new RegExp(`^${instructions}\n`)) });
      stats.push(await stat(file));
      expect(await readdir(path.dirname(file))).toEqual(['agent.md']);
      next.finishPrompt();
      await collect(nextRun.events);
    }
    expect(stats[0]).toMatchObject({ mtimeMs: initial.mtimeMs, ino: initial.ino });
    expect(agents.get('session-new')).toMatchObject({ kind: 'custom', body: expect.stringMatching(/^Be exact\.\n/) });
  });

  it('gives title requests passive guidance and an empty native tool list and MCP list', async () => {
    const session = await createSession();
    const run = session.execute({ ...request(), configuration: {
      ...request().configuration, systemInstructions: { kind: 'explicit', purpose: 'title', instructions: 'Title only.' },
    }, toolPolicy: { kind: 'passive' } });
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    expect(agents.get('session-new')).toMatchObject({ body: expect.stringContaining('Do not use any tools'), frontmatter: { name: 'claudian-title', tools: [] } });
    expect(peer.newRequests[0].mcpServers).toEqual([]);
    expect(peer.resumeRequests).toEqual([]);
    // Auxiliary sessions keep their prompt in the custom agent body, never in an append.
    expect(peer.prompts[0].appendsAtReceipt).toEqual([]);
    await expect(peer.requestPermission(permissionRequest('run_command'))).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    peer.finishPrompt();
    await collect(run.events);
  });

  it('lets real Inline Edit read its context and run a search while denying native writes', async () => {
    await createSession(); // Installs the authoritative native peer at the process boundary.
    const host = await createHost();
    const lifecycle = new ProviderExecutionLifecycleRegistry();
    const service = new InlineEditService({
      backend: new AntigravityExecutionBackend(host.getRuntimeHost('antigravity')),
      interactionPort: createInteractionPort(), lifecycleRegistry: lifecycle,
      nativePersistence: 'enabled', workingDirectory: vault,
    });
    onTestFinished(() => lifecycle.dispose());
    const context = path.join(vault, 'context.md');
    await writeFile(context, 'Replacement from the referenced file.');
    const result = service.send({ mode: 'selection', notePath: 'note.md', selectedText: 'draft', instruction: 'Use the context', contextFiles: ['context.md'] });
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    expect(peer.prompts[0].request.prompt).toEqual([expect.objectContaining({ text: expect.stringContaining('context.md') })]);
    expect(agents.get('session-new')).toMatchObject({ body: expect.stringContaining('Never modify files through tools'), frontmatter: { name: 'claudian-inline-edit', tools: ['read_file', 'search_web', 'run_command'] } });
    expect(peer.newRequests[0].mcpServers).toEqual([]);
    expect(peer.resumeRequests).toEqual([]);
    expect(peer.prompts[0].appendsAtReceipt).toEqual([]);
    const replacement = await peer.readContextFile('session-new', context);
    await expect(peer.requestPermission(permissionRequest('run_command'))).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    for (const name of ['write_file', 'edit_file']) {
      await expect(peer.requestPermission(permissionRequest(name))).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    }
    peer.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `<replacement>${replacement}</replacement>` } }, 'session-new');
    peer.finishPrompt();
    await expect(result).resolves.toEqual({ success: true, editedText: 'Replacement from the referenced file.' });
  });


  it('creates a main session on agy\'s default agent, prompts under the append and applies only changed settings', async () => {
    const session = await createSession();
    const run = session.execute(request('hello', { instructions: 'Be exact.', reasoning: 'high' }));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);

    expect(peer.agentName).toBeUndefined();
    expect(agents.get('session-new')).toEqual({ kind: 'default' });
    await expect(stat(path.join(vault, '.agents'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(peer.newRequests[0]._meta).toBeUndefined();
    expect(peer.resumeRequests).toEqual([{ _meta: appendMeta('Be exact.'), cwd: vault, mcpServers: [], sessionId: 'session-new' }]);
    expect(peer.prompts[0].appendsAtReceipt).toEqual(['Be exact.']);
    // The model and mode already match the session; only the thinking level differs.
    expect(peer.configRequests).toEqual([{ configId: 'thought_level', sessionId: 'session-new', value: 'high' }]);
    expect(peer.prompts[0].request).toEqual({ prompt: [{ text: 'hello', type: 'text' }], sessionId: 'session-new' });

    peer.emit({ content: { text: 'Hi.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    // After each model call agy reports the context it fills and the model's window.
    peer.emit({ sessionUpdate: 'usage_update', size: 1_048_576, used: 7_032 }, 'session-new');
    peer.emit({ sessionUpdate: 'usage_update', size: 1_048_576, used: 7_306 }, 'session-new');
    // The response sums every model call in the turn.
    peer.finishPrompt({
      stopReason: 'end_turn',
      usage: { cachedReadTokens: 5_073, inputTokens: 9_155, outputTokens: 110, totalTokens: 14_338 },
    });
    const events = await collect(run.events);

    expect(events.filter(event => event.type === 'text_delta')).toEqual([expect.objectContaining({ text: 'Hi.' })]);
    // The final meter shows agy's latest report rather than the turn's sum.
    expect(events.filter(event => event.type === 'usage_updated').at(-1)).toEqual(expect.objectContaining({
      usage: expect.objectContaining({
        contextTokens: 7_306, contextWindow: 1_048_576, inputTokens: 9_155, model: 'gemini-4-argon', percentage: 1,
      }),
    }));
    expect(events.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
    expect(session.getSnapshot().providerSessionId).toBe('session-new');
  });

  it('hides the context meter when agy reports no context usage', async () => {
    const session = await createSession();
    const run = session.execute(request('hello'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt({ stopReason: 'end_turn', usage: { inputTokens: 900_000, outputTokens: 2, totalTokens: 900_002 } });
    const events = await collect(run.events);

    // The summed usage is no measure of the context; reporting no context tokens or window hides the meter.
    expect(events).toContainEqual(expect.objectContaining({
      type: 'usage_updated',
      usage: expect.objectContaining({ contextTokens: 0, contextWindow: 0, inputTokens: 900_000, percentage: 0 }),
    }));
    expect(events.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
  });

  it('streams agy tool calls under their native names with normalized inputs and results', async () => {
    const session = await createSession();
    const run = session.execute(request('work'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    const tool = (toolCallId: string, name: string, args: Record<string, unknown>, kind: string, title: string) => ({
      args, kind, name, rawInput: args, sessionUpdate: 'tool_call', status: 'pending', title, toolCallId,
    });
    peer.emit(tool('read-1', 'read_file', { Path: '/vault/a.md' }, 'read', 'Read a.md'), 'session-new');
    peer.emit({ content: [{ content: { text: 'Tool completed', type: 'text' }, type: 'content' }],
      sessionUpdate: 'tool_call_update', status: 'completed', toolCallId: 'read-1' }, 'session-new');
    peer.emit(tool('bash-1', 'run_command', { CommandLine: 'false', toolSummary: 'Fail' }, 'execute', 'false'), 'session-new');
    peer.emit({ rawOutput: { exit_code: 1, output: 'Command exited with code 1.\n\nCommand output:\nboom\n' },
      sessionUpdate: 'tool_call_update', status: 'completed', toolCallId: 'bash-1' }, 'session-new');
    peer.emit(tool('bash-2', 'run_command', { CommandLine: 'echo ok' }, 'execute', 'echo ok'), 'session-new');
    peer.emit({ rawOutput: { exit_code: 0, output: 'Command exited with code 0.\n\nCommand output:\nok\n' },
      sessionUpdate: 'tool_call_update', status: 'completed', toolCallId: 'bash-2' }, 'session-new');
    // Captured agy 1.5.0 completions retain native name/input but carry no rawOutput or content.
    const outputlessTools = [
      tool('image-1', 'generate_image', { ImageName: 'blue_square', Prompt: 'A tiny solid blue square' }, 'other', 'Run generate_image'),
      tool('web-1', 'search_web', { query: 'Obsidian callouts' }, 'search', '"Obsidian callouts" on Web'),
      tool('task-1', 'manage_task', { Action: 'status', TaskId: 'session-new/task-2' }, 'other', 'Run manage_task'),
      tool('task-2', 'manage_task', { Action: 'send_input', Input: 'hello\n', TaskId: 'session-new/task-2' }, 'other', 'Run manage_task'),
      tool('task-3', 'manage_task', { Action: 'kill', TaskId: 'session-new/task-2' }, 'other', 'Run manage_task'),
      tool('task-4', 'manage_task', { Action: 'list' }, 'other', 'Run manage_task'),
      tool('res-1', 'list_resources', { ServerName: 'claudian_sessions' }, 'other', 'Run list_resources'),
    ];
    for (const update of outputlessTools) {
      peer.emit(update, 'session-new');
      peer.emit({ ...update, sessionUpdate: 'tool_call_update', status: 'completed' }, 'session-new');
    }
    // MCP servers from the user's agy config run through agy's generic dispatcher, which does stream output.
    const inherited = tool('mcp-1', 'call_mcp_tool', { Arguments: { nonce: 'n-1' }, ServerName: 'notes_server', ToolName: 'search_notes' },
      'execute', 'MCP Tool search_notes');
    peer.emit(inherited, 'session-new');
    peer.emit({ ...inherited, content: [{ content: { text: '{"hits":1}', type: 'text' }, type: 'content' }],
      rawOutput: '{"hits":1}', sessionUpdate: 'tool_call_update', status: 'completed' }, 'session-new');
    peer.finishPrompt();
    const events = await collect(run.events);

    const started = events.filter(event => event.type === 'tool_started');
    expect(started.filter((event, index) => started.findIndex(other => other.toolCallId === event.toolCallId) === index)).toEqual([
      expect.objectContaining({ input: expect.objectContaining({ file_path: '/vault/a.md' }), name: 'Read', toolCallId: 'read-1' }),
      expect.objectContaining({ input: expect.objectContaining({ command: 'false' }), name: 'Bash', toolCallId: 'bash-1' }),
      expect.objectContaining({ input: expect.objectContaining({ command: 'echo ok' }), name: 'Bash', toolCallId: 'bash-2' }),
      expect.objectContaining({ input: expect.objectContaining({ prompt: 'A tiny solid blue square' }), name: 'GenerateImage', toolCallId: 'image-1' }),
      expect.objectContaining({ input: expect.objectContaining({ query: 'Obsidian callouts' }), name: 'WebSearch', toolCallId: 'web-1' }),
      expect.objectContaining({ input: expect.objectContaining({ TaskId: 'session-new/task-2' }), name: 'BashOutput', toolCallId: 'task-1' }),
      expect.objectContaining({ input: expect.objectContaining({ chars: 'hello\n', session_id: 'session-new/task-2' }), name: 'write_stdin', toolCallId: 'task-2' }),
      expect.objectContaining({ input: expect.objectContaining({ TaskId: 'session-new/task-2' }), name: 'KillShell', toolCallId: 'task-3' }),
      expect.objectContaining({ input: expect.objectContaining({ Action: 'list' }), name: 'ManageTasks', toolCallId: 'task-4' }),
      expect.objectContaining({ input: expect.objectContaining({ server: 'claudian_sessions' }), name: 'ListMcpResources', toolCallId: 'res-1' }),
      expect.objectContaining({ input: { nonce: 'n-1' }, name: 'mcp__notes_server__search_notes', toolCallId: 'mcp-1' }),
    ]);
    const completed = events.filter(event => event.type === 'tool_completed');
    expect(completed.map(event => [event.toolCallId, event.content ?? '', event.isError ?? false])).toEqual([
      ['read-1', '', false],
      ['bash-1', 'exit: 1\nboom', true],
      ['bash-2', 'ok', false],
      ['image-1', '', false],
      ['web-1', '', false],
      ['task-1', '', false],
      ['task-2', '', false],
      ['task-3', '', false],
      ['task-4', '', false],
      ['res-1', '', false],
      ['mcp-1', '{"hits":1}', false],
    ]);
  });

  it('applies an advertised model and explicit effort together before prompting', async () => {
    const session = await createSession();
    const run = session.execute(request('hello', { model: 'antigravity/claude-sonnet-5-5', reasoning: 'high' }));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    expect((await collect(run.events)).at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(peer.configRequests.map(change => [change.configId, change.value])).toEqual([['model', 'claude-sonnet-5-5-high']]);
    expect(peer.configOptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'model', currentValue: 'claude-sonnet-5-5' }),
      expect.objectContaining({ id: 'thought_level', currentValue: 'high' }),
    ]));
  });

  it('runs a model that has no thinking level without setting one', async () => {
    const session = await createSession();
    const run = session.execute(request('hello', { model: 'antigravity/gpt-oss-120b-medium', reasoning: 'medium' }));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    const events = await collect(run.events);

    expect(peer.configRequests.map(change => [change.configId, change.value])).toEqual([['model', 'gpt-oss-120b-medium']]);
    expect(events.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
  });

  it.each<[string, string]>([
    ['acceptEdits', 'accept-edits'],
    ['auto', 'auto'],
    ['yolo', 'default'],
  ])('maps permission mode %s to native mode %s', async (permissionMode, nativeMode) => {
    const session = await createSession();
    const run = session.execute(request('hello', { permissionMode, reasoning: 'medium' }));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    expect(peer.configRequests).toEqual(nativeMode === 'default'
      ? []
      : [{ configId: 'mode', sessionId: 'session-new', value: nativeMode }]);
    peer.finishPrompt();
    await collect(run.events);
  });

  it('does not prompt when the native session rejects unsupported Auto mode', async () => {
    const session = await createSession({}, peer => {
      peer.configOptions = peer.configOptions.map(option => option.id === 'mode' && option.type === 'select'
        ? { ...option, options: option.options.filter(value => 'value' in value).filter(value => value.value !== 'auto') }
        : option);
    });
    const events = await collect(session.execute(request('hello', { permissionMode: 'auto' })).events);
    expect(events.at(-1)).toMatchObject({ type: 'execution_error' });
    expect(spawned[0].prompts).toHaveLength(0);
  });

  it('rejects a model the session does not advertise before prompting', async () => {
    const session = await createSession();
    const events = await collect(session.execute(request('hello', { model: 'antigravity/claude-opus' })).events);
    expect(events.at(-1)).toMatchObject({ category: 'configuration', type: 'execution_error' });
    expect(spawned[0].prompts).toHaveLength(0);
  });

  it('resumes the persisted session', async () => {
    const session = await createSession({ resumeSeed: { providerSessionId: 'session-existing', providerState: {} } });
    const run = session.execute(request());
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    expect(peer.resumeRequests.map(entry => entry.sessionId)).toEqual(['session-existing']);
    expect(peer.newRequests).toHaveLength(0);
    expect(peer.agentName).toBeUndefined();
    // The resume append is not stored natively, so a restored session gets the current prompt.
    expect(peer.prompts[0].appendsAtReceipt).toEqual(['Be exact.']);
    peer.finishPrompt();
    expect((await collect(run.events)).at(-1)?.type).toBe('turn_completed');
  });

  it('reports a session agy cannot read as missing instead of opening an empty one', async () => {
    const session = await createSession({ resumeSeed: { providerSessionId: 'session-gone', providerState: {} } });
    const events = await collect(session.execute(request()).events);

    expect(events.at(-1)).toMatchObject({
      category: 'provider-session-missing',
      type: 'execution_error',
    });
    expect(session.getSnapshot().providerSessionId).toBe('session-gone');
    expect(spawned[0].loadRequests).toEqual([]);
    expect(spawned[0].prompts).toHaveLength(0);
  });

  it('rebinds the open session to a changed system prompt before the next prompt', async () => {
    const session = await createSession({ resumeSeed: { providerSessionId: 'session-existing', providerState: {} } });
    const first = session.execute(request('one', { instructions: 'First.' }));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    expect(peer.prompts[0].appendsAtReceipt).toEqual(['First.']);
    peer.finishPrompt();
    await collect(first.events);

    const second = session.execute(request('two', { instructions: 'Second.' }));
    await peer.waitForPrompts(2);
    expect(spawned).toHaveLength(1);
    expect(peer.resumeRequests.map(entry => entry._meta)).toEqual([appendMeta('First.'), appendMeta('Second.')]);
    expect(peer.prompts[1].appendsAtReceipt).toEqual(['Second.']);
    peer.finishPrompt();
    await collect(second.events);

    const third = session.execute(request('three', { instructions: 'Second.' }));
    await peer.waitForPrompts(3);
    expect(peer.resumeRequests).toHaveLength(2);
    peer.finishPrompt();
    await collect(third.events);
  });

  it('accepts a turn agy completes without output, so the next prompt does not replay history', async () => {
    const session = await createSession();
    const first = session.execute(request('First question'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    const events = await collect(first.events);
    expect(events.some(event => event.type === 'turn_started')).toBe(true);
    expect(session.getSnapshot().providerState?.nativeConversationContextEstablished).toBe(true);

    const second = session.execute({
      ...request('Second question'),
      conversationHistory: [{ content: 'First question', id: 'user-1', role: 'user', timestamp: testDate().getTime() }],
    });
    await peer.waitForPrompts(2);
    expect(peer.prompts[1].request.prompt).toEqual([{ text: 'Second question', type: 'text' }]);
    peer.finishPrompt();
    await collect(second.events);
  });

  it('retires the process when a cancel interrupts a config change, so Ask mode is restored', async () => {
    // Real agy can resume the session after the process is replaced.
    const session = await createSession({}, peer => { peer.knownSessions.add('session-new'); });
    const first = session.execute(request('one', { reasoning: 'medium' }));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(first.events);

    let released!: () => void;
    let applied!: () => void;
    const modeApplied = new Promise<void>(resolve => { applied = resolve; });
    peer.configGate = () => new Promise<void>(resolve => { released = resolve; applied(); });
    const second = session.execute(request('two', { permissionMode: 'acceptEdits', reasoning: 'medium' }));
    await modeApplied;
    session.cancel();
    expect((await collect(second.events)).at(-1)).toMatchObject({ type: 'cancelled' });
    expect(peer.child.killed).toBe(true);
    released();

    const third = session.execute(request('three', { reasoning: 'medium' }));
    const replacement = await spawnedProcess(2);
    await replacement.waitForPrompts(1);
    expect(replacement.configOptions.find(option => option.id === 'mode')).toMatchObject({ currentValue: 'default' });
    // The replacement resumes the saved session and re-sends the current prompt, which agy does not store.
    expect(replacement.resumeRequests.map(entry => [entry.sessionId, entry._meta])).toEqual([['session-new', appendMeta('Be exact.')]]);
    replacement.finishPrompt();
    await collect(third.events);
  });

  it('does not spawn agy when the run is cancelled during CLI lookup', async () => {
    let lookupStarted!: () => void;
    const lookup = new Promise<void>(resolve => { lookupStarted = resolve; });
    let resolveCli!: (path: string) => void;
    const session = await createSession({}, () => {}, {
      getResolvedProviderCliPath: () => {
        lookupStarted();
        return new Promise<string>(resolve => { resolveCli = resolve; });
      },
    });
    const run = session.execute(request());
    await lookup;
    session.cancel();
    resolveCli('agy');

    expect((await collect(run.events)).at(-1)).toMatchObject({ type: 'cancelled' });
    expect(spawn).not.toHaveBeenCalled();
    expect(session.getStatus()).toBe('idle');
  });

  it('publishes the live session command list without the hidden built-ins', async () => {
    const session = await createSession({}, peer => {
      peer.availableCommands = ['goal', 'plan', 'teamwork', 'compact', 'swarm'].map(name => ({ description: name, name }));
    });
    expect(session.getCommandSnapshot?.()).toBeUndefined();
    const changed = new Promise<void>(resolve => {
      const unsubscribe = session.onEvent(event => {
        if (event.type !== 'commands_changed') return;
        unsubscribe();
        resolve();
      });
    });
    const run = session.execute(request());
    const peer = await firstPeer();
    await changed;
    await peer.waitForPrompts(1);
    expect(session.getCommandSnapshot?.()?.map(command => command.name)).toEqual(['goal', 'compact']);
    peer.finishPrompt();
    await collect(run.events);
  });

  it('allows every permission request in YOLO without asking', async () => {
    const session = await createSession();
    const run = session.execute(request('edit', { permissionMode: 'yolo' }));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    await expect(peer.requestPermission(permissionRequest('write_file')))
      .resolves.toEqual({ outcome: { optionId: 'allow', outcome: 'selected' } });
    peer.finishPrompt();
    await collect(run.events);
  });

  it.each([
    ['normal', 'allow', { optionId: 'allow', outcome: 'selected' }],
    ['normal', 'reject', { optionId: 'reject', outcome: 'selected' }],
    ['auto', 'allow', { optionId: 'allow', outcome: 'selected' }],
    ['auto', 'reject', { optionId: 'reject', outcome: 'selected' }],
  ] as const)('asks before a tool runs in %s mode and answers %s', async (permissionMode, value, outcome) => {
    const port = createInteractionPort();
    port.requestApproval.mockImplementation(async (approval: ProviderApprovalInteractionRequest) => ({
      interactionId: approval.interactionId, value,
    }));
    const session = await createSession({ interactionPort: port });
    const run = session.execute(request('edit', { permissionMode }));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);

    const permission = permissionRequest('write_file');
    const always = { _meta: { 'agy.security.warning': { message: 'Future shell calls may run without asking.' } },
      kind: 'allow_always' as const, name: 'Always allow', optionId: 'always' };
    permission.options.push(always);
    await expect(peer.requestPermission(permission)).resolves.toEqual({ outcome });
    expect(port.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ decisionOptions: expect.arrayContaining([{
        decision: 'allow-always', description: 'Future shell calls may run without asking.', label: 'Always allow', value: 'always',
      }]), kind: 'approval', toolName: 'Write' }),
      expect.any(AbortSignal),
    );
    peer.finishPrompt();
    await collect(run.events);
  });

  it('answers ask_question forms through the question UI', async () => {
    const port = createInteractionPort();
    port.askUserQuestion.mockImplementation(async (question: ProviderQuestionInteractionRequest) => ({
      answers: { q1: '2', q2: ['1', 'Something else'] },
      interactionId: question.interactionId,
    }));
    const session = await createSession({ interactionPort: port });
    const run = session.execute(request('ask me'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    expect(peer.initializeRequests[0].clientCapabilities).toEqual({ elicitation: { form: {} } });

    const reply = await peer.createElicitation({
      message: 'Answer these',
      mode: 'form',
      requestedSchema: {
        properties: {
          q1: { oneOf: [{ const: '1', title: 'Red' }, { const: '2', title: 'Blue' }], title: 'Color?', type: 'string' },
          q1_other: { title: 'Other', type: 'string' },
          q2: { items: { anyOf: [{ const: '1', title: 'Cats' }, { const: '2', title: 'Dogs' }] }, title: 'Pets?', type: 'array' },
          q2_other: { title: 'Other', type: 'string' },
        },
        type: 'object',
      },
      sessionId: 'session-new',
      toolCallId: 'tool-ask',
    });

    expect(port.askUserQuestion.mock.calls[0][0].input).toEqual({
      questions: [
        expect.objectContaining({ id: 'q1', multiSelect: false, question: 'Color?' }),
        expect.objectContaining({ id: 'q2', multiSelect: true, question: 'Pets?' }),
      ],
    });
    expect(reply).toEqual({ action: 'accept', content: { q1: '2', q2: ['1'], q2_other: 'Something else' } });
    // agy completes the tool without reporting the answers; the card shows the ones the user gave.
    const args = { questions: [
      { is_multi_select: false, options: ['Red', 'Blue'], question: 'Color?' },
      { is_multi_select: true, options: ['Cats', 'Dogs'], question: 'Pets?' },
    ] };
    const ask = { args, kind: 'other', name: 'ask_question', rawInput: args, title: 'Run ask_question', toolCallId: 'tool-ask' };
    peer.emit({ ...ask, sessionUpdate: 'tool_call', status: 'in_progress' }, 'session-new');
    peer.emit({ ...ask, sessionUpdate: 'tool_call_update', status: 'completed' }, 'session-new');
    peer.finishPrompt();
    const events = await collect(run.events);

    expect(events.find(event => event.type === 'tool_completed')).toEqual(expect.objectContaining({
      resultDetails: expect.objectContaining({ resolvedAnswers: { 'Color?': 'Blue', 'Pets?': ['Cats', 'Something else'] } }),
      toolCallId: 'tool-ask',
    }));
  });

  it('routes a subagent\'s relayed approval and question to the user in Ask mode, keeping the turn open after a denial', async () => {
    const port = createInteractionPort();
    port.requestApproval.mockImplementation(async (approval: ProviderApprovalInteractionRequest) => ({
      interactionId: approval.interactionId, value: 'reject',
    }));
    port.askUserQuestion.mockImplementation(async (question: ProviderQuestionInteractionRequest) => ({
      answers: { q1: '1' }, interactionId: question.interactionId,
    }));
    const session = await createSession({ interactionPort: port });
    const run = session.execute(request('Delegate'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    // Frames captured from agy 1.5.16 (default mode): the subagent's calls arrive on the parent session under
    // `<subagent>:call_…` ids, each streamed as pending only when it asks.
    const delegate = { kind: 'other', name: 'invoke_subagent', rawInput: { Prompt: 'Run `date > probe.txt`', TypeName: 'self' }, title: 'Run invoke_subagent', toolCallId: 'call-sub' };
    peer.emit({ ...delegate, sessionUpdate: 'tool_call', status: 'in_progress' }, 'session-new');
    peer.emit({ ...delegate, sessionUpdate: 'tool_call_update', status: 'completed' }, 'session-new');
    const command = { kind: 'execute', name: 'run_command', rawInput: { CommandLine: 'date > probe.txt' }, title: 'date > probe.txt', toolCallId: 'sub-1:call-1' };
    peer.emit({ ...command, sessionUpdate: 'tool_call', status: 'pending' }, 'session-new');
    await expect(peer.requestPermission({ ...permissionRequest('run_command'), toolCall: { ...command, sessionUpdate: 'tool_call', status: 'pending' } as ACPRequestPermissionRequest['toolCall'] }))
      .resolves.toEqual({ outcome: { optionId: 'reject', outcome: 'selected' } });
    peer.emit({ ...command, sessionUpdate: 'tool_call_update', status: 'in_progress' }, 'session-new');
    peer.emit({ ...command, rawOutput: 'permission check failed for unsandboxed "date > probe.txt": user denied permission to run command',
      sessionUpdate: 'tool_call_update', status: 'failed' }, 'session-new');
    const args = { questions: [{ is_multi_select: false, options: ['red', 'blue'], question: 'Pick a color' }] };
    const ask = { args, kind: 'other', name: 'ask_question', rawInput: args, title: 'Run ask_question', toolCallId: 'sub-1:call-2' };
    peer.emit({ ...ask, sessionUpdate: 'tool_call', status: 'pending' }, 'session-new');
    await expect(peer.createElicitation({
      message: 'The agent has a question.',
      mode: 'form',
      requestedSchema: {
        properties: {
          q1: { oneOf: [{ const: '1', title: 'red' }, { const: '2', title: 'blue' }], title: 'Pick a color', type: 'string' },
          q1_other: { description: 'Optional free-form answer to: Pick a color', title: 'Other', type: 'string' },
        },
        type: 'object',
      },
      sessionId: 'session-new',
      toolCallId: 'sub-1:call-2',
    })).resolves.toEqual({ action: 'accept', content: { q1: '1' } });
    peer.emit({ ...ask, sessionUpdate: 'tool_call_update', status: 'in_progress' }, 'session-new');
    peer.emit({ ...ask, sessionUpdate: 'tool_call_update', status: 'completed' }, 'session-new');
    peer.finishPrompt();
    const events = await collect(run.events);

    expect(port.requestApproval.mock.calls.map(([approval]) => [approval.toolName, approval.nativeContext]))
      .toEqual([['Bash', { sessionId: 'session-new', toolCallId: 'sub-1:call-1' }]]);
    // The question came after the denial, inside the same run, and both calls completed there before the turn did.
    expect(events.filter(event => event.type === 'tool_completed' || event.type === 'turn_completed')
      .map(event => (event.type === 'tool_completed' ? [event.toolCallId, event.isError ?? false] : event.type)))
      .toEqual([['call-sub', false], ['sub-1:call-1', true], ['sub-1:call-2', false], 'turn_completed']);
    expect(events.find(event => event.type === 'tool_completed' && event.toolCallId === 'sub-1:call-2')).toEqual(expect.objectContaining({
      resultDetails: expect.objectContaining({ resolvedAnswers: { 'Pick a color': 'red' } }),
    }));
  });

  it('streams what agy does after a turn as a background turn, including a background command it launched in the turn', async () => {
    const session = await createSession();
    const run = session.execute(request('Start the build'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    const build = { kind: 'execute', name: 'run_command', rawInput: { CommandLine: 'sleep 25 && echo BG-DONE' }, title: 'sleep 25 && echo BG-DONE', toolCallId: 'call-bg' };
    peer.emit({ ...build, sessionUpdate: 'tool_call', status: 'in_progress' }, 'session-new');
    peer.finishPrompt();
    await collect(run.events);
    expect(session.blocksIdleRelease?.()).toBe(false);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const background = backgroundTurn(session);
    // agy 1.5.10: the command's completion and the reply it wakes agy for stream after `end_turn`.
    peer.emit({ ...build, content: [{ content: { text: 'Command output:\nBG-DONE', type: 'text' }, type: 'content' }], sessionUpdate: 'tool_call_update', status: 'completed' }, 'session-new');
    peer.emit({ content: { text: 'The build finished.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    peer.emit({ sessionUpdate: 'usage_update', size: 1_048_576, used: 9_000 }, 'session-new');
    await background.reached('usage_updated');
    // Releasing the session would end agy's process mid-reply.
    expect(session.blocksIdleRelease?.()).toBe(true);
    expect(session.getStatus()).toBe('executing');
    await vi.advanceTimersByTimeAsync(1_000);
    const events = await background.completed;

    expect(events.map(event => event.type)).toEqual([
      'background_turn_started', 'tool_started', 'tool_completed', 'assistant_message_started', 'text_delta', 'usage_updated',
      'background_turn_completed',
    ]);
    expect(events[1]).toMatchObject({ input: { command: 'sleep 25 && echo BG-DONE' }, name: 'Bash', toolCallId: 'call-bg' });
    expect(events[2]).toMatchObject({ content: expect.stringContaining('BG-DONE'), isError: false, toolCallId: 'call-bg' });
    expect(events[4]).toMatchObject({ text: 'The build finished.' });
    expect(events.at(-1)).toMatchObject({ providerSessionId: 'session-new', reason: 'completed' });
    expect(session.blocksIdleRelease?.()).toBe(false);
    expect(session.getStatus()).toBe('idle');
  });

  it('keeps a background turn open across a model call that continues with a tool', async () => {
    const session = await createSession();
    const run = session.execute(request('Delegate'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(run.events);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const background = backgroundTurn(session);
    const read = { kind: 'read', name: 'read_file', rawInput: { AbsolutePath: '/vault/a.md' }, title: 'read_file', toolCallId: 'call-read' };
    peer.emit({ content: { text: 'Checking.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    // agy ends each model call with usage_update and streams the call's tools right after it.
    peer.emit({ sessionUpdate: 'usage_update', size: 1_048_576, used: 9_000 }, 'session-new');
    peer.emit({ ...read, sessionUpdate: 'tool_call', status: 'in_progress' }, 'session-new');
    await background.reached('tool_started');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(background.events.at(-1)?.type).toBe('tool_started');
    peer.emit({ ...read, sessionUpdate: 'tool_call_update', status: 'completed' }, 'session-new');
    peer.emit({ content: { text: 'Done.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    peer.emit({ sessionUpdate: 'usage_update', size: 1_048_576, used: 9_100 }, 'session-new');
    await background.reached('text_delta', 2);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(textOf(await background.completed)).toEqual(['Checking.', 'Done.']);
  });

  it.each([
    ['normal', true, { optionId: 'allow', outcome: 'selected' }],
    ['yolo', false, { optionId: 'allow', outcome: 'selected' }],
  ] as const)('decides approvals agy asks for after a %s turn under that turn\'s mode', async (permissionMode, asks, outcome) => {
    const port = createInteractionPort();
    port.requestApproval.mockImplementation(async (approval: ProviderApprovalInteractionRequest) => answerApproval(approval, 'allow'));
    const session = await createSession({ interactionPort: port });
    const run = session.execute(request('Start the build', { permissionMode }));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(run.events);

    const background = backgroundTurn(session);
    peer.emit({ kind: 'edit', name: 'write_file', rawInput: {}, sessionUpdate: 'tool_call', status: 'pending', title: 'write_file', toolCallId: 'tool-1' }, 'session-new');
    await background.reached('tool_started');
    // Before agy 1.5.10 sent these, Claudian answered every request between runs with `cancelled`.
    await expect(peer.requestPermission(permissionRequest('write_file'))).resolves.toEqual({ outcome });
    // The approval belongs to the background turn, whose closing supersedes it.
    const [started] = background.events;
    const turnId = started.scope.kind === 'background' ? started.scope.turnId : 'none';
    const asked = port.requestApproval.mock.calls.map(([approval]) => ({ kind: approval.kind, toolName: approval.toolName, turnId: approval.turnId }));
    expect(asked).toEqual(asks ? [{ kind: 'approval', toolName: 'Write', turnId }] : []);
  });

  it('ends the background turn when a denied tool fails, since agy does nothing more after a denial', async () => {
    const port = createInteractionPort();
    port.requestApproval.mockImplementation(async (approval: ProviderApprovalInteractionRequest) => ({
      interactionId: approval.interactionId, value: 'reject',
    }));
    const session = await createSession({ interactionPort: port });
    const run = session.execute(request('Start the build'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(run.events);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const background = backgroundTurn(session);
    const write = { kind: 'edit', name: 'write_file', rawInput: {}, title: 'write_file', toolCallId: 'tool-1' };
    peer.emit({ sessionUpdate: 'usage_update', size: 1_048_576, used: 9_000 }, 'session-new');
    peer.emit({ ...write, sessionUpdate: 'tool_call', status: 'pending' }, 'session-new');
    await expect(peer.requestPermission(permissionRequest('write_file'))).resolves.toEqual({ outcome: { optionId: 'reject', outcome: 'selected' } });
    // agy 1.5.10: the denied call fails and agy's reply ends there, with no usage_update.
    peer.emit({ ...write, sessionUpdate: 'tool_call_update', status: 'failed' }, 'session-new');
    await background.reached('tool_completed');
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await background.completed).at(-1)).toMatchObject({ reason: 'completed', type: 'background_turn_completed' });
    expect(session.blocksIdleRelease?.()).toBe(false);
  });

  it('denies what agy asks after an auxiliary request, without a background turn', async () => {
    const port = createInteractionPort();
    const session = await createSession({ interactionPort: port });
    const run = session.execute(titleRequest());
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(run.events);
    const events: ProviderSessionEvent[] = [];
    session.onEvent(event => events.push(event));

    peer.emit({ kind: 'edit', name: 'write_file', rawInput: {}, sessionUpdate: 'tool_call', status: 'pending', title: 'write_file', toolCallId: 'tool-1' }, 'session-new');
    await expect(peer.requestPermission(permissionRequest('write_file'))).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(port.requestApproval).not.toHaveBeenCalled();
    expect(events.filter(event => event.scope.kind === 'background')).toEqual([]);
  });

  it.each([true, false])('sends the next prompt only once agy\'s own reply has settled, so a fast answer stays in its run (usage update %s)', async reportsUsage => {
    const session = await createSession();
    const first = session.execute(request('Delegate'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(first.events);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const background = backgroundTurn(session);
    peer.emit({ content: { text: 'Late part one. ', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    await background.reached('text_delta');
    // agy finishes its own reply before it answers a prompt, then answers at once.
    const answered = peer.waitForPrompts(2).then(() => {
      peer.emit({ content: { text: 'Sure.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    });
    const second = session.execute(request('Meanwhile'));
    await vi.advanceTimersByTimeAsync(110_000);
    peer.emit({ content: { text: 'Late part two.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    await background.reached('text_delta', 2);
    if (reportsUsage) {
      peer.emit({ sessionUpdate: 'usage_update', size: 1_048_576, used: 9_000 }, 'session-new');
      await background.reached('usage_updated');
    }
    const delay = reportsUsage ? 1_000 : 120_000;
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(peer.prompts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(background.events.at(-1)?.type).toBe('background_turn_completed');
    await background.completed;
    await answered;
    peer.finishPrompt();
    const events = await collect(second.events);

    expect(textOf(background.events)).toEqual(['Late part one. ', 'Late part two.']);
    expect(textOf(events)).toEqual(['Sure.']);
  });

  it('still closes agy\'s settled reply when the next run changes a setting before prompting', async () => {
    const session = await createSession();
    const first = session.execute(request('Delegate', { reasoning: 'high' }));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(first.events);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const background = backgroundTurn(session);
    peer.emit({ content: { text: 'Late reply.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    peer.emit({ sessionUpdate: 'usage_update', size: 1_048_576, used: 9_000 }, 'session-new');
    await background.reached('usage_updated');
    // The new effort reaches agy, which reports the change as a config_option_update.
    const configured = deferred<void>();
    peer.configGate = () => { configured.resolve(); };
    const second = session.execute(request('Meanwhile', { reasoning: 'low' }));
    await configured.promise;
    // agy's stream is ordered, so the session has handled that update once it reports this later one.
    const commandsChanged = new Promise<void>(resolve => {
      const unsubscribe = session.onEvent(event => {
        if (event.type !== 'commands_changed') return;
        unsubscribe();
        resolve();
      });
    });
    peer.emit({ availableCommands: [{ description: 'Review', name: 'review' }], sessionUpdate: 'available_commands_update' }, 'session-new');
    await commandsChanged;
    await vi.advanceTimersByTimeAsync(1_000);
    await background.completed;
    await peer.waitForPrompts(2);
    peer.finishPrompt();

    expect((await collect(second.events)).at(-1)).toMatchObject({ type: 'turn_completed' });
  });

  it('stops agy\'s own reply and dismisses its pending approval when the next run is cancelled', async () => {
    const port = createInteractionPort();
    const asked = deferred<AbortSignal>();
    port.requestApproval.mockImplementation((_approval, signal) => {
      asked.resolve(signal);
      return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('dismissed'))); });
    });
    const session = await createSession({ interactionPort: port });
    const first = session.execute(request('Start the build'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(first.events);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const background = backgroundTurn(session);
    peer.emit({ kind: 'edit', name: 'write_file', rawInput: {}, sessionUpdate: 'tool_call', status: 'pending', title: 'write_file', toolCallId: 'tool-1' }, 'session-new');
    await background.reached('tool_started');
    void peer.requestPermission(permissionRequest('write_file'));
    const signal = await asked.promise;
    const second = session.execute(request('Meanwhile'));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(signal.aborted).toBe(false);
    expect(peer.prompts).toHaveLength(1);
    second.cancel();
    expect((await collect(second.events)).at(-1)).toMatchObject({ type: 'cancelled' });

    expect(signal.aborted).toBe(true);
    expect((await background.completed).at(-1)).toMatchObject({ reason: 'interrupted', type: 'background_turn_completed' });
    expect(peer.prompts).toHaveLength(1);
  });

  it('interrupts the background turn and dismisses its approval when the session is disposed', async () => {
    const port = createInteractionPort();
    const asked = deferred<AbortSignal>();
    port.requestApproval.mockImplementation((_approval, signal) => {
      asked.resolve(signal);
      return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('dismissed'))); });
    });
    const session = await createSession({ interactionPort: port });
    const run = session.execute(request('Start the build'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(run.events);

    const background = backgroundTurn(session);
    peer.emit({ kind: 'edit', name: 'write_file', rawInput: {}, sessionUpdate: 'tool_call', status: 'pending', title: 'write_file', toolCallId: 'tool-1' }, 'session-new');
    // Disposal ends agy's process, so agy never sees the answer; the prompt must still go away.
    void peer.requestPermission(permissionRequest('write_file'));
    const signal = await asked.promise;
    expect(signal.aborted).toBe(false);
    await session.dispose();

    expect(signal.aborted).toBe(true);
    expect((await background.completed).at(-1)).toMatchObject({ reason: 'interrupted', type: 'background_turn_completed' });
  });

  it('stops agy\'s own reply when the user stops background work', async () => {
    const session = await createSession();
    const run = session.execute(request('Start the build'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(run.events);
    expect(peer.cancelRequests).toEqual([]);

    const background = backgroundTurn(session);
    const sleep = { kind: 'execute', name: 'run_command', rawInput: { CommandLine: 'sleep 40' }, title: 'sleep 40', toolCallId: 'call-sleep' };
    peer.emit({ content: { text: 'Waiting for the build.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    peer.emit({ ...sleep, sessionUpdate: 'tool_call', status: 'in_progress' }, 'session-new');
    await background.reached('tool_started');
    session.cancel();

    expect(peer.cancelRequests).toEqual(['session-new']);
    expect((await background.completed).at(-1)).toMatchObject({ reason: 'interrupted', type: 'background_turn_completed' });
    // agy 1.5.10 then reports the calls its cancel ended, including a background command from an earlier turn.
    const later = backgroundTurn(session);
    peer.emit({ ...sleep, sessionUpdate: 'tool_call_update', status: 'failed' }, 'session-new');
    peer.emit({ kind: 'execute', name: 'run_command', sessionUpdate: 'tool_call_update', status: 'failed', title: 'npm run dev', toolCallId: 'call-dev' }, 'session-new');
    // agy's stream is ordered, so the session has handled both updates once it reports this later one.
    const commandsChanged = new Promise<void>(resolve => {
      const unsubscribe = session.onEvent(event => {
        if (event.type !== 'commands_changed') return;
        unsubscribe();
        resolve();
      });
    });
    peer.emit({ availableCommands: [{ description: 'Review', name: 'review' }], sessionUpdate: 'available_commands_update' }, 'session-new');
    await commandsChanged;
    expect(later.events).toEqual([]);
    expect(session.getStatus()).toBe('idle');
    expect(session.blocksIdleRelease?.()).toBe(false);
  });

  it('asks agy\'s questions after a turn in its background turn', async () => {
    const port = createInteractionPort();
    port.askUserQuestion.mockImplementation(async (question: ProviderQuestionInteractionRequest) => ({
      answers: { q1: '1' }, interactionId: question.interactionId,
    }));
    const session = await createSession({ interactionPort: port });
    const run = session.execute(request('Start the build'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(run.events);

    const background = backgroundTurn(session);
    const args = { questions: [{ is_multi_select: false, options: ['Ship', 'Wait'], question: 'Ship it?' }] };
    peer.emit({ args, kind: 'other', name: 'ask_question', rawInput: args, sessionUpdate: 'tool_call', status: 'in_progress', title: 'Run ask_question', toolCallId: 'tool-ask' }, 'session-new');
    await background.reached('tool_started');
    const reply = await peer.createElicitation({
      message: 'Answer this',
      mode: 'form',
      requestedSchema: {
        properties: { q1: { oneOf: [{ const: '1', title: 'Ship' }, { const: '2', title: 'Wait' }], title: 'Ship it?', type: 'string' } },
        type: 'object',
      },
      sessionId: 'session-new',
      toolCallId: 'tool-ask',
    });

    expect(reply).toEqual({ action: 'accept', content: { q1: '1' } });
    const [started] = background.events;
    expect(port.askUserQuestion.mock.calls.map(([question]) => question.turnId))
      .toEqual([started.scope.kind === 'background' ? started.scope.turnId : 'none']);
  });

  it('runs a session tool agy calls in its background turn', async () => {
    const list = vi.fn(async () => ({ sessions: [] }));
    const session = await createSession({ sessionTools: { list, read: vi.fn(), send: vi.fn() } });
    const run = session.execute(request('Start the build'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(run.events);

    const background = backgroundTurn(session);
    peer.emit({ kind: 'other', name: 'claudian_list_destinations', rawInput: {}, sessionUpdate: 'tool_call', status: 'in_progress', title: 'claudian_list_destinations', toolCallId: 'tool-mcp' }, 'session-new');
    await background.reached('tool_started');
    await peer.callMCP('session-new', 'claudian_list_destinations', {});
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('interrupts the background turn and dismisses its approval when agy exits between runs', async () => {
    const port = createInteractionPort();
    const asked = deferred<AbortSignal>();
    port.requestApproval.mockImplementation((_approval, signal) => {
      asked.resolve(signal);
      return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('dismissed'))); });
    });
    const session = await createSession({ interactionPort: port });
    const run = session.execute(request('Start the build'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(run.events);

    const background = backgroundTurn(session);
    peer.emit({ kind: 'edit', name: 'write_file', rawInput: {}, sessionUpdate: 'tool_call', status: 'pending', title: 'write_file', toolCallId: 'tool-1' }, 'session-new');
    void peer.requestPermission(permissionRequest('write_file'));
    const signal = await asked.promise;
    peer.child.kill();

    expect((await background.completed).at(-1)).toMatchObject({ reason: 'interrupted', type: 'background_turn_completed' });
    expect(signal.aborted).toBe(true);
    expect(session.blocksIdleRelease?.()).toBe(false);
  });

  it('does not hold idle release for a subagent agy\'s own reply launched and the transcript shows outstanding', async () => {
    const session = await createSession();
    const run = session.execute(request('Start the build'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(run.events);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const background = backgroundTurn(session);
    peer.emit(invokeSubagent('call-1'), 'session-new');
    await writeTranscript('session-new', [
      transcriptSteps.user(0, 'Start the build', testTime({ minutes: -2 })),
      transcriptSteps.reply(1, 'Started.', testTime({ minutes: -2 })),
      transcriptSteps.delegate(2, testTime({ minutes: -1 })),
      transcriptSteps.created(3, 'sub-1', testTime({ minutes: -1 })),
      transcriptSteps.reply(4, 'Delegated.', testTime({ minutes: -1 })),
    ]);
    peer.emit({ sessionUpdate: 'usage_update', size: 1_048_576, used: 9_000 }, 'session-new');
    await background.reached('usage_updated');
    await vi.advanceTimersByTimeAsync(1_000);
    await background.completed;
    // agy 1.5.15 keeps prompts open for subagents; one launched by agy's own reply between prompts is deliberately
    // not tracked, so nothing holds agy's process for it once that reply closes.
    expect(session.blocksIdleRelease?.()).toBe(false);
    vi.useRealTimers();
  });

  it('keeps one agy process across YOLO switches and decides relayed subagent approvals under the turn\'s mode', async () => {
    const port = createInteractionPort();
    port.requestApproval.mockImplementation(async (approval: ProviderApprovalInteractionRequest) => ({
      interactionId: approval.interactionId, value: 'reject',
    }));
    const session = await createSession({ interactionPort: port });
    // agy 1.5.16 relays a subagent's request on the parent session, its tool call id prefixed with the subagent's id.
    const subagentRequest = { ...permissionRequest('run_command'), toolCall: {
      kind: 'execute', name: 'run_command', title: 'date > probe.txt', toolCallId: 'sub-1:call-1',
    } as ACPRequestPermissionRequest['toolCall'] };
    const outcomes: unknown[] = [];
    for (const [index, permissionMode] of (['yolo', 'normal', 'yolo'] as const).entries()) {
      const run = session.execute(request(`turn ${index}`, { permissionMode }));
      const peer = await firstPeer();
      await peer.waitForPrompts(index + 1);
      // No launch flag ties YOLO to a process, so switching modes neither adds a process nor restarts agy.
      expect(vi.mocked(spawn).mock.calls.map(([, args]) => args)).toEqual([['acp']]);
      outcomes.push((await peer.requestPermission(subagentRequest)).outcome);
      peer.finishPrompt();
      await collect(run.events);
    }

    expect(outcomes).toEqual([
      { optionId: 'allow', outcome: 'selected' },
      { optionId: 'reject', outcome: 'selected' },
      { optionId: 'allow', outcome: 'selected' },
    ]);
    expect(port.requestApproval.mock.calls.map(([approval]) => approval.toolName)).toEqual(['Bash']);
  });

  it('denies auxiliary sessions\' requests even in YOLO', async () => {
    const session = await createSession();
    const run = session.execute({ ...titleRequest(), configuration: { ...titleRequest().configuration, permissionMode: 'yolo' } });
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    expect(vi.mocked(spawn).mock.calls.map(([, args]) => args)).toEqual([['acp', '--agent', 'claudian-title']]);
    await expect(peer.requestPermission(permissionRequest('run_command'))).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    peer.finishPrompt();
    await collect(run.events);
  });

  it('marks a completed /compact with a context boundary', async () => {
    const session = await createSession();
    const run = session.execute(request('/compact keep the plan'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    // agy's report for a compaction measures the summarizing call over the old context.
    peer.emit({ sessionUpdate: 'usage_update', size: 1_048_576, used: 14_506 }, 'session-new');
    peer.finishPrompt({ stopReason: 'end_turn', usage: { inputTokens: 2_780, outputTokens: 421, totalTokens: 14_506 } });
    const events = await collect(run.events);

    expect(peer.prompts[0].request.prompt).toEqual([{ text: '/compact keep the plan', type: 'text' }]);
    expect(events.map(event => event.type).filter(type => type === 'context_compacted' || type === 'turn_completed'))
      .toEqual(['context_compacted', 'turn_completed']);
    // The compacted context stays unmeasured until agy's next model call reports it.
    expect(events.filter(event => event.type === 'usage_updated').at(-1)).toEqual(expect.objectContaining({
      usage: expect.objectContaining({ contextTokens: 0, contextWindow: 1_048_576, percentage: 0 }),
    }));
  });

  it('does not mark a cancelled /compact as compacted', async () => {
    const session = await createSession();
    const run = session.execute(request('/compact'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt({ stopReason: 'cancelled' });
    const events = await collect(run.events);

    expect(events.some(event => event.type === 'context_compacted')).toBe(false);
  });

  it('confirms a steer once agy hands the running turn to it, before the steer\'s output', async () => {
    const session = await createSession();
    const run = session.execute(request('first'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);

    // agy echoes no steer; it answers the prompt the steer takes over.
    await expect(session.steer(request('also this'))).resolves.toBe(true);
    peer.emit({ content: { text: 'Done.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    peer.finishPrompt();
    const events = await collect(run.events);

    expect(peer.prompts.map(prompt => prompt.request.prompt)).toEqual([
      [{ text: 'first', type: 'text' }],
      [{ text: 'also this', type: 'text' }],
    ]);
    // The chat consumer treats the first boundary as the turn's own input, so the steer needs its own second one.
    expect(events.filter(event => event.type === 'user_message_started').map(event => event.content))
      .toEqual(['first', 'also this']);
    const types = events.map(event => event.type);
    expect(types.lastIndexOf('user_message_started')).toBeLessThan(types.indexOf('text_delta'));
    expect(events.filter(event => event.type === 'turn_completed')).toHaveLength(1);
  });

  it('handles two overlapping steers with one terminal', async () => {
    const session = await createSession();
    const run = session.execute(request('initial'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    const steers = Promise.all([session.steer(request('one')), session.steer(request('two'))]);
    await expect(steers).resolves.toEqual([true, true]);
    peer.finishPrompt();
    const events = await collect(run.events);
    expect(events.filter(event => event.type === 'user_message_started').map(event => event.content))
      .toEqual(['initial', 'one', 'two']);
    expect(events.filter(event => event.type === 'turn_completed')).toHaveLength(1);
  });

  it('keeps the original turn when agy rejects a steer before taking it over', async () => {
    const session = await createSession();
    const run = session.execute(request('first'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.failNextPrompt('Prompt rejected');
    await expect(session.steer(request('also this'))).resolves.toBe(false);
    peer.emit({ content: { text: 'Answer.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    peer.finishPrompt();
    const events = await collect(run.events);

    expect(events.filter(event => event.type === 'user_message_started').map(event => event.content)).toEqual(['first']);
    expect(events.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
  });

  it('completes the accepted steer when agy rejects steers before and after it', async () => {
    const session = await createSession();
    const run = session.execute(request('first'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.failNextPrompt('Prompt rejected');
    await expect(session.steer(request('one'))).resolves.toBe(false);
    await expect(session.steer(request('two'))).resolves.toBe(true);
    peer.failNextPrompt('Prompt rejected');
    await expect(session.steer(request('three'))).resolves.toBe(false);
    peer.finishPrompt();
    const events = await collect(run.events);

    expect(events.filter(event => event.type === 'user_message_started').map(event => event.content)).toEqual(['first', 'two']);
    expect(events.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
  });

  it('keeps a steer agy took over when the turn is cancelled afterwards', async () => {
    const session = await createSession();
    const run = session.execute(request('first'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    await expect(session.steer(request('also this'))).resolves.toBe(true);
    session.cancel();
    const events = await collect(run.events);
    expect(events.filter(event => event.type === 'user_message_started').map(event => event.content)).toEqual(['first', 'also this']);
    expect(events.at(-1)).toMatchObject({ type: 'cancelled' });
  });

  /** Starts a run, waits until Claudian shows agy's running `sleep 30` call, then stops the run. */
  async function stopRunningCall(session: Awaited<ReturnType<typeof createSession>>) {
    const run = session.execute(request('Run the slow command'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    const events = run.events[Symbol.asyncIterator]();
    peer.emit({ kind: 'execute', rawInput: { CommandLine: 'sleep 30' }, sessionUpdate: 'tool_call', status: 'in_progress', title: 'sleep 30', toolCallId: 'call-slow' }, 'session-new');
    for (let next = await events.next(); !next.done; next = await events.next()) {
      if (next.value.type === 'tool_started') break;
    }
    session.cancel();
    while (!(await events.next()).done) { /* drains the cancelled run */ }
    return peer;
  }

  /** What agy 1.5.15 sends for the call its cancel ended, after the cancelled prompt has settled. */
  const endedCallFailure = { content: [], rawOutput: { output: '' }, sessionUpdate: 'tool_call_update', status: 'failed', toolCallId: 'call-slow' };

  it('keeps agy\'s failure of a call the cancel ended in the cancelled turn instead of opening a background turn', async () => {
    const session = await createSession();
    const peer = await stopRunningCall(session);

    peer.emit(endedCallFailure, 'session-new');
    // Updates are handled in order, so this one marks that the failure has been handled.
    peer.emit({ availableCommands: [{ description: 'Barrier', name: 'barrier' }], sessionUpdate: 'available_commands_update' }, 'session-new');
    await vi.waitFor(() => expect(session.getCommandSnapshot?.()?.map(command => command.name)).toContain('barrier'));

    expect(session.blocksIdleRelease?.()).toBe(false);
    expect(session.getStatus()).not.toBe('executing');
  });

  it('keeps agy\'s failure of a call the cancel ended out of the run sent right after the stop', async () => {
    const session = await createSession();
    const peer = await stopRunningCall(session);
    const next = session.execute(request('Do something else'));
    await peer.waitForPrompts(2);

    peer.emit(endedCallFailure, 'session-new');
    peer.emit({ content: { text: 'Done.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    peer.emit({ kind: 'read', rawInput: { AbsolutePath: '/vault/a.md' }, sessionUpdate: 'tool_call', status: 'in_progress', title: 'a.md', toolCallId: 'call-new' }, 'session-new');
    peer.emit({ sessionUpdate: 'tool_call_update', status: 'completed', toolCallId: 'call-new' }, 'session-new');
    peer.emit({ kind: 'execute', rawInput: { CommandLine: 'python3 -m http.server' }, sessionUpdate: 'tool_call', status: 'in_progress', title: 'python3 -m http.server', toolCallId: 'call-daemon' }, 'session-new');
    const events = await (async () => {
      const collecting = collect(next.events);
      await vi.waitFor(() => expect(peer.prompts).toHaveLength(2));
      peer.finishPrompt();
      return collecting;
    })();

    expect(textOf(events)).toEqual(['Done.']);
    // The ended call stays out of this run; the run's own calls still show.
    expect([...new Set(events.flatMap(event => (event.type === 'tool_started' ? [event.toolCallId] : [])))]).toEqual(['call-new', 'call-daemon']);

    // A daemon this run launched outlives it; its exit is agy's own work again, not a report of the stopped call.
    const background = backgroundTurn(session);
    peer.emit({ content: [{ content: { text: 'Command exited with code 0.', type: 'text' }, type: 'content' }], rawOutput: { output: 'Command exited with code 0.' }, sessionUpdate: 'tool_call_update', status: 'completed', toolCallId: 'call-daemon' }, 'session-new');
    peer.emit({ availableCommands: [{ description: 'Barrier', name: 'barrier' }], sessionUpdate: 'available_commands_update' }, 'session-new');
    await vi.waitFor(() => expect(session.getCommandSnapshot?.()?.map(command => command.name)).toContain('barrier'));
    expect(background.events.filter(event => event.type === 'tool_completed')).toEqual([expect.objectContaining({ toolCallId: 'call-daemon' })]);
    await session.dispose();
  });

  it('keeps agy\'s failure of a call announced while the stop was under way in the stopped turn', async () => {
    const session = await createSession();
    const run = session.execute(request('Run the slow command'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.settlePromptsOnCancel = false;
    const barrier = async (name: string) => {
      peer.emit({ availableCommands: [{ description: 'Barrier', name }], sessionUpdate: 'available_commands_update' }, 'session-new');
      await vi.waitFor(() => expect(session.getCommandSnapshot?.()?.map(command => command.name)).toContain(name));
    };
    session.cancel();
    await vi.waitFor(() => expect(peer.cancelRequests).toEqual(['session-new']));
    // agy announced the call before it received the cancel.
    peer.emit({ kind: 'execute', rawInput: { CommandLine: 'sleep 30' }, sessionUpdate: 'tool_call', status: 'in_progress', title: 'sleep 30', toolCallId: 'call-slow' }, 'session-new');
    await barrier('announced');
    peer.finishPrompt({ stopReason: 'cancelled' });
    await collect(run.events);

    peer.emit(endedCallFailure, 'session-new');
    await barrier('reported');

    expect(session.blocksIdleRelease?.()).toBe(false);
    expect(session.getStatus()).not.toBe('executing');
  });

  it('cancels the native turn and keeps the process when agy settles it', async () => {
    const session = await createSession();
    const run = session.execute(request());
    const peer = await firstPeer();
    await peer.waitForPrompts(1);

    session.cancel();
    const events = await collect(run.events);

    expect(peer.cancelRequests).toEqual(['session-new']);
    // agy answered the cancelled prompt, so it has it even though it streamed nothing; no echo confirms it earlier.
    expect(events.filter(event => event.type === 'turn_started')).toEqual([expect.objectContaining({ accepted: true })]);
    expect(events.at(-1)).toMatchObject({ type: 'cancelled' });
    expect(peer.child.killed).toBe(false);
  });
});

// `\\wsl$` UNC paths exist only on Windows hosts, so the host filesystem is the external boundary.
describe.skipIf(path.sep === '\\')('Antigravity WSL installations', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let wsl: WSLProcessFixture;
  beforeEach(() => {
    wsl = new WSLProcessFixture();
    wsl.environment = { HOME: '/home/alice' };
    vi.stubEnv('SystemRoot', 'C:\\Windows');
  });
  afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); });

  /** wsl.exe runs agy as the shared native peer; Linux probes go to the WSL process fixture. */
  async function createWSLSession(overrides: Partial<ProviderSessionConfig> = {}) {
    const launches: string[][] = [];
    vi.mocked(spawn).mockImplementation((command, args = [], options = {}) => {
      if (readWSLExec({ args: [...args] }).args[3] !== 'agy') return wsl.spawn(command, args, options);
      launches.push([...args]);
      const peer = new AntigravityNativeProcess(undefined, agents);
      spawned.push(peer);
      spawnWaiters = spawnWaiters.filter(waiter => (spawned.length >= waiter.count ? (waiter.resolve(), false) : true));
      return peer.child;
    });
    const { host } = await createProviderHostFixture({ settings: { providerConfigs: { antigravity: { enabled: true } } } });
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    updateAntigravityProviderSettings(host.settings, { installationMethod: 'wsl', wslDistroOverride: 'Ubuntu' });
    const session = new AntigravityExecutionBackend(host.getRuntimeHost('antigravity')).createSession({
      interactionPort: createInteractionPort(),
      lifecycle: 'persistent',
      nativePersistence: 'enabled',
      workingDirectory: 'C:\\vault',
      ...overrides,
    }) as ProviderExecutionSession & SteerableExecutionSession;
    sessions.push(session);
    return { launches, session };
  }

  it('runs agy in the distro with the Linux vault, a stdio session-tool relay and host tool paths', async () => {
    const sessionTools = { list: vi.fn(async () => ({ sessions: [] })), read: vi.fn(), send: vi.fn() };
    const { launches, session } = await createWSLSession({ sessionTools });
    const run = session.execute(request('Edit notes'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.emit({
      kind: 'read', locations: [{ path: '/mnt/c/vault/notes.md' }], name: 'read_file', rawInput: { Path: '/mnt/c/vault/notes.md' },
      sessionUpdate: 'tool_call', status: 'in_progress', title: 'File notes.md', toolCallId: 'read',
    }, 'session-new');
    peer.emit({
      content: [{ newText: 'new', oldText: 'old', path: '/mnt/c/vault/note.md', type: 'diff' }],
      kind: 'edit', name: 'edit_file', rawInput: { Path: '/mnt/c/vault/note.md', Replacement: 'new', Target: 'old' },
      sessionUpdate: 'tool_call', status: 'completed', title: 'Edit note.md', toolCallId: 'edit',
    }, 'session-new');
    // A user MCP server's arguments are opaque: a `path` there is not a Linux file path.
    peer.emit({
      kind: 'other', name: 'call_mcp_tool', rawInput: { Arguments: { path: '/api/tickets' }, ServerName: 'tickets', ToolName: 'get' },
      sessionUpdate: 'tool_call', status: 'in_progress', title: 'Run call_mcp_tool', toolCallId: 'mcp',
    }, 'session-new');
    peer.finishPrompt();
    const events = await collect(run.events);

    expect(events).toContainEqual(expect.objectContaining({ input: expect.objectContaining({ file_path: 'C:\\vault\\notes.md' }), type: 'tool_started' }));
    expect(events).toContainEqual(expect.objectContaining({ input: { path: '/api/tickets' }, name: 'mcp__tickets__get', type: 'tool_started' }));
    expect(events).toContainEqual(expect.objectContaining({
      resultDetails: expect.objectContaining({ diff: expect.objectContaining({ filePath: 'C:\\vault\\note.md' }) }), type: 'tool_completed',
    }));
    expect([peer.newRequests[0].cwd, peer.resumeRequests[0].cwd]).toEqual(['/mnt/c/vault', '/mnt/c/vault']);
    const [server] = peer.resumeRequests[0].mcpServers;
    if (!('command' in server)) throw new Error('Expected a stdio relay server');
    expect(server).toMatchObject({ command: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', name: 'claudian_sessions' });
    expect(server).not.toHaveProperty('url');
    const routeId = server.env?.find(variable => variable.name === 'CLAUDIAN_SESSION_TOOL_ROUTE')?.value;
    expect(routeId).toBeTruthy();
    expect(JSON.stringify(server.args)).not.toContain(routeId);
    expect(JSON.stringify(wsl.requests.map(entry => [entry.args, entry.options.env]))).not.toContain(routeId);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', '/mnt/c/vault']));
    expect(readWSLExec({ args: launches[0] }).args.slice(3)).toEqual(['agy', 'acp']);
  });

  it('does not start agy when the distro reports no Linux home for its store', async () => {
    wsl.environment = {};
    const { launches, session } = await createWSLSession();

    const events = await collect(session.execute(request()).events);

    expect(events.at(-1)).toMatchObject({ message: expect.stringContaining('Antigravity WSL session store'), type: 'execution_error' });
    // The probe reached the distro; agy itself never launched.
    expect(wsl.requests.map(entry => entry.executable)).toEqual(['/usr/bin/awk']);
    expect(launches).toEqual([]);
  });
});
