import * as fs from 'node:fs/promises';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { deferred } from '@test/helpers/ChatInputHarness';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { AntigravityNativeProcess,type CapturedAntigravityAgent } from '@test/helpers/providers/antigravity/AntigravityNativeProcess';
import { testDate } from '@test/helpers/testClock';
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
  SteerableExecutionSession,
} from '@/core/execution';
import { ProviderExecutionLifecycleRegistry } from '@/core/execution';
import type { ProviderHost } from '@/core/providers/ProviderHost';
import type { ACPRequestPermissionRequest } from '@/providers/acp';
import { AntigravityExecutionBackend } from '@/providers/antigravity/execution/AntigravityExecutionBackend';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));
// Forward the real filesystem, permitting faults only at its external I/O boundary.
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));

const sessions: ProviderExecutionSession[] = [];
let spawned: AntigravityNativeProcess[] = [];
let vault: string;
const agents = new Map<string, CapturedAntigravityAgent>();
let spawnWaiters: Array<{ count: number; resolve: () => void }> = [];

afterEach(async () => {
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
  return host;
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
  it('holds the first prompt until resume makes the MCP route usable', async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const list = vi.fn(async () => ({ sessions: [] }));
    const session = await createSession({ sessionTools: { list, read: vi.fn(), send: vi.fn() } }, peer => {
      peer.resumeGate = async request => {
        entered.resolve();
        await release.promise;
        // Real endpoint discovery keeps readiness pending until the peer finishes connecting.
        await peer.discoverMCPTools(request.mcpServers);
      };
    });
    const run = session.execute(request());
    const peer = await firstPeer();
    await entered.promise;
    expect(session.getSnapshot()).toMatchObject({ providerSessionId: 'session-new', providerState: { nativeConversationContextEstablished: false } });
    await expect(peer.callMCP('session-new', 'claudian_list_destinations', {})).rejects.toThrow('MCP unavailable');
    expect(peer.prompts).toHaveLength(0);
    release.resolve();
    await peer.waitForPrompts(1);
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
    expect(failed.at(-1)).not.toHaveProperty('missingProviderSessionId');
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
    '---', 'name: claudian-main', `description: ${description}`, 'mainAgent: true',
    'subagent: false', 'excludeDefaultComponents: true', 'tools: [read_file]', '---', body,
  ].join('\n')]).concat([
    ['malformed', '---\ndescription: [broken\n---\nbody'],
  ]))('refuses a %s file without changing it or creating a native session', async (_label, contents) => {
    const session = await createSession({}, peer => {
      void peer.waitForPrompts(1).then(() => peer.finishPrompt());
    });
    const file = path.join(vault, '.agents/agents/claudian-main/agent.md');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
    const events = await collect(session.execute(request()).events);
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
        await fs.unlink(path.join(vault, '.agents/agents/claudian-main/agent.md'));
        return 'agy';
      },
    });
    const events = await collect(session.execute(request()).events);
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed' });
    expect(spawned[0].agentName).toBe('claudian-main');
    expect(agents.get('session-new')).toEqual({ kind: 'default' });
    expect(spawned[0].newRequests).toHaveLength(1);
    expect(spawned[0].prompts).toHaveLength(1);
  });

  it.each(['readFile', 'mkdir', 'writeFile', 'rename'] as const)('preserves owned content and removes its temporary file on %s failure', async operation => {
    const first = await createSession();
    const cwd = vault;
    const run = first.execute(request());
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(run.events);
    const file = path.join(cwd, '.agents/agents/claudian-main/agent.md');
    const original = await readFile(file, 'utf8');
    await writeFile(path.join(path.dirname(file), 'user-note.md'), 'Keep this too.');
    const next = await createSession({ workingDirectory: cwd });
    const error = Object.assign(new Error(`Injected ${operation} failure`), { code: 'EACCES' });
    const fault = vi.spyOn(fs, operation).mockRejectedValueOnce(error);
    const events = await collect(next.execute(request('hello', { instructions: 'Changed prompt.' })).events);
    expect(events.at(-1)).toMatchObject({ type: 'execution_error', message: expect.stringContaining(file) });
    expect(fault).toHaveBeenCalled();
    fault.mockRestore();
    expect(await readFile(file, 'utf8')).toBe(original);
    expect(await readdir(path.dirname(file))).toEqual(['agent.md', 'user-note.md']);
    expect(spawned.flatMap(peer => peer.newRequests)).toHaveLength(1);
  });

  it.each([
    ['project-a', 'project-b'], ['project-a', undefined], [undefined, 'project-a'],
  ])('keeps the creation agent across project move %s → %s and a fresh process', async (from, to) => {
    const session = await createSession();
    const cwd = vault;
    const turn = (projectId: string | undefined, instructions: string): ProviderExecutionRequest => ({
      ...request(), configuration: { ...request().configuration, systemInstructions: { kind: 'main-agent', projectId, instructions } },
    });
    const first = session.execute(turn(from, 'Original project text.'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(first.events);
    const originalFile = path.join(vault, '.agents/agents', from ? `claudian-project-${from}` : 'claudian-main', 'agent.md');
    const before = await stat(originalFile);
    const second = session.execute(turn(to, 'Destination project text.'));
    await peer.waitForPrompts(2);
    expect(spawned).toHaveLength(1);
    expect(peer.resumeRequests).toHaveLength(1);
    expect(await stat(originalFile)).toMatchObject({ mtimeMs: before.mtimeMs, ino: before.ino });
    expect(await readdir(path.join(vault, '.agents/agents'))).toEqual([peer.agentName]);
    peer.finishPrompt();
    await collect(second.events);
    await session.dispose();
    // An invalid creation file cannot prevent restoration; native state owns the frozen persona/tools.
    await writeFile(originalFile, 'foreign replacement');
    const reopened = await createSession({ workingDirectory: cwd, resumeSeed: { providerSessionId: 'session-new', providerState: {} } });
    const third = reopened.execute(turn(to, 'Edited again.'));
    const next = await spawnedProcess(2);
    await next.waitForPrompts(1);
    expect(next.agentName).toBeUndefined();
    expect(next.agents.get('session-new')).toMatchObject({ kind: 'custom', body: 'Original project text.' });
    expect(next.newRequests).toHaveLength(0);
    expect(next.resumeRequests[0]._meta).toBeUndefined();
    next.finishPrompt();
    await collect(third.events);
    const fresh = await createSession({ workingDirectory: cwd }, peer => { peer.newSessionId = 'fresh-destination'; });
    const fourth = fresh.execute(turn(to, 'Latest destination instructions.'));
    const freshPeer = await spawnedProcess(3);
    await freshPeer.waitForPrompts(1);
    expect(freshPeer.agents.get('fresh-destination')).toMatchObject({
      body: 'Latest destination instructions.',
      frontmatter: { name: to ? `claudian-project-${to}` : 'claudian-main' },
    });
    expect(await readFile(originalFile, 'utf8')).toBe('foreign replacement');
    freshPeer.finishPrompt();
    await collect(fourth.events);
  });

  it('rewrites an owned file only for a changed new conversation', async () => {
    const first = await createSession();
    const cwd = vault;
    const run = first.execute(request());
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(run.events);
    const file = path.join(cwd, '.agents/agents/claudian-main/agent.md');
    const initial = await stat(file);
    const stats = [];
    for (const [index, instructions] of ['Be exact.', 'New instructions.'].entries()) {
      const session = await createSession({ workingDirectory: cwd }, peer => { peer.newSessionId = `session-${index}`; });
      const nextRun = session.execute(request('hello', { instructions }));
      const next = await spawnedProcess(index + 2);
      await next.waitForPrompts(1);
      expect(next.agents.get(`session-${index}`)).toMatchObject({ kind: 'custom', body: instructions });
      stats.push(await stat(file));
      expect(await readdir(path.dirname(file))).toEqual(['agent.md']);
      next.finishPrompt();
      await collect(nextRun.events);
    }
    expect(stats[0]).toMatchObject({ mtimeMs: initial.mtimeMs, ino: initial.ino });
    expect(agents.get('session-new')).toMatchObject({ kind: 'custom', body: 'Be exact.' });
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
    expect(peer.resumeRequests[0].mcpServers).toEqual([]);
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
    expect(peer.resumeRequests[0].mcpServers).toEqual([]);
    const replacement = await peer.readContextFile('session-new', context);
    await expect(peer.requestPermission(permissionRequest('run_command'))).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    for (const name of ['write_file', 'edit_file']) {
      await expect(peer.requestPermission(permissionRequest(name))).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    }
    peer.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `<replacement>${replacement}</replacement>` } }, 'session-new');
    peer.finishPrompt();
    await expect(result).resolves.toEqual({ success: true, editedText: 'Replacement from the referenced file.' });
  });


  it('creates an owned main agent, immediately resumes and applies only changed settings', async () => {
    const session = await createSession();
    const run = session.execute(request('hello', { instructions: 'Be exact.', reasoning: 'high' }));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);

    expect(peer.newRequests[0]._meta).toBeUndefined();
    expect(peer.resumeRequests).toEqual([{ cwd: vault, mcpServers: [], sessionId: 'session-new' }]);
    expect(agents.get('session-new')).toEqual({ kind: 'custom', body: 'Be exact.', frontmatter: {
      name: 'claudian-main', description: 'Managed by Claudian. Do not edit.',
      mainAgent: true, subagent: false, excludeDefaultComponents: true,
      tools: ['run_command', 'manage_task', 'read_file', 'write_file', 'edit_file', 'search_web',
        'ask_question', 'generate_image'],
    } });
    // The model and mode already match the session; only the thinking level differs.
    expect(peer.configRequests).toEqual([{ configId: 'thought_level', sessionId: 'session-new', value: 'high' }]);
    expect(peer.prompts[0].request).toEqual({ prompt: [{ text: 'hello', type: 'text' }], sessionId: 'session-new' });

    peer.emit({ content: { text: 'Hi.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    peer.finishPrompt({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
    const events = await collect(run.events);

    expect(events.filter(event => event.type === 'text_delta')).toEqual([expect.objectContaining({ text: 'Hi.' })]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'usage_updated', usage: expect.objectContaining({ inputTokens: 10 }),
    }));
    expect(events.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
    expect(session.getSnapshot().providerSessionId).toBe('session-new');
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
    ];
    for (const update of outputlessTools) {
      peer.emit(update, 'session-new');
      peer.emit({ ...update, sessionUpdate: 'tool_call_update', status: 'completed' }, 'session-new');
    }
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
      expect.objectContaining({ input: { Action: 'list' }, name: 'manage_task', toolCallId: 'task-4' }),
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
    ]);
  });

  it.each<[string, string]>([
    ['acceptEdits', 'accept-edits'],
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
    peer.finishPrompt();
    expect((await collect(run.events)).at(-1)?.type).toBe('turn_completed');
  });

  it('reports a session agy cannot read as missing instead of opening an empty one', async () => {
    const session = await createSession({ resumeSeed: { providerSessionId: 'session-gone', providerState: {} } });
    const events = await collect(session.execute(request()).events);

    expect(events.at(-1)).toMatchObject({
      category: 'provider-session-missing',
      missingProviderSessionId: 'session-gone',
      type: 'execution_error',
    });
    expect(spawned[0].loadRequests).toEqual([]);
    expect(spawned[0].prompts).toHaveLength(0);
  });

  it('keeps the loaded session when the requested system prompt changes', async () => {
    const session = await createSession({ resumeSeed: { providerSessionId: 'session-existing', providerState: {} } });
    const first = session.execute(request('one', { instructions: 'First.' }));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(first.events);

    const second = session.execute(request('two', { instructions: 'Second.' }));
    await peer.waitForPrompts(2);
    expect(spawned).toHaveLength(1);
    expect(peer.resumeRequests).toHaveLength(1);
    expect(peer.resumeRequests[0]._meta).toBeUndefined();
    expect(peer.agentName).toBeUndefined();
    peer.finishPrompt();
    await collect(second.events);

    const third = session.execute(request('three', { instructions: 'Second.' }));
    await peer.waitForPrompts(3);
    expect(peer.resumeRequests).toHaveLength(1);
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
      peer.availableCommands = ['goal', 'plan', 'teamwork', 'compact'].map(name => ({ description: name, name }));
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
    ['allow', { optionId: 'allow', outcome: 'selected' }],
    ['deny', { optionId: 'reject', outcome: 'selected' }],
  ] as const)('asks before a tool runs in Ask mode and answers %s', async (decision, outcome) => {
    const port = createInteractionPort();
    port.requestApproval.mockImplementation(async (approval: ProviderApprovalInteractionRequest) => ({
      decision, interactionId: approval.interactionId,
    }));
    const session = await createSession({ interactionPort: port });
    const run = session.execute(request('edit'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);

    await expect(peer.requestPermission(permissionRequest('write_file'))).resolves.toEqual({ outcome });
    expect(port.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'approval', toolName: 'Write' }),
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
    peer.finishPrompt();
    await collect(run.events);
  });

  it('confirms a steer only when agy injects it into the running turn', async () => {
    const session = await createSession();
    const run = session.execute(request('first'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);

    let confirmed = false;
    const steer = session.steer(request('also this')).then(result => { confirmed = true; return result; });
    await peer.waitForPrompts(2);
    // agy has handed the turn to the steer prompt but has not injected it yet.
    await new Promise<void>(resolve => { setImmediate(resolve); });
    expect(confirmed).toBe(false);
    peer.emit({ content: { text: 'also this', type: 'text' }, sessionUpdate: 'user_message_chunk' }, 'session-new');
    await expect(steer).resolves.toBe(true);
    peer.emit({ content: { text: 'Done.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    peer.finishPrompt();
    const events = await collect(run.events);

    expect(peer.prompts.map(prompt => prompt.request.prompt)).toEqual([
      [{ text: 'first', type: 'text' }],
      [{ text: 'also this', type: 'text' }],
    ]);
    expect(events.filter(event => event.type === 'user_message_started'))
      .toEqual([expect.objectContaining({ content: 'also this', type: 'user_message_started' })]);
    expect(events.filter(event => event.type === 'turn_completed')).toHaveLength(1);
  });

  it('recognizes a slash-command steer whose echo omits the command name', async () => {
    const session = await createSession();
    const run = session.execute(request('first'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    const steer = session.steer(request('/goal Reply with DONE'));
    await peer.waitForPrompts(2);
    peer.emit({ content: { text: ' Reply with DONE', type: 'text' }, sessionUpdate: 'user_message_chunk' }, 'session-new');
    await expect(steer).resolves.toBe(true);
    peer.finishPrompt();
    const events = await collect(run.events);
    expect(events.filter(event => event.type === 'user_message_started'))
      .toEqual([expect.objectContaining({ content: '/goal Reply with DONE' })]);
  });

  it('handles two overlapping steers with one terminal', async () => {
    const session = await createSession();
    const run = session.execute(request('initial'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    const steers = Promise.all([session.steer(request('one')), session.steer(request('two'))]);
    await peer.waitForPrompts(3);
    peer.emit({ content: { text: 'one', type: 'text' }, sessionUpdate: 'user_message_chunk' }, 'session-new');
    peer.emit({ content: { text: 'two', type: 'text' }, sessionUpdate: 'user_message_chunk' }, 'session-new');
    await expect(steers).resolves.toEqual([true, true]);
    peer.finishPrompt();
    const events = await collect(run.events);
    expect(events.filter(event => event.type === 'user_message_started').map(event => event.content)).toEqual(['one', 'two']);
    expect(events.filter(event => event.type === 'turn_completed')).toHaveLength(1);
  });

  it('rejects a steer whose disposition is unknown when the turn is cancelled after handoff', async () => {
    const session = await createSession();
    const run = session.execute(request('first'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    const steer = session.steer(request('also this'));
    await peer.waitForPrompts(2);
    session.cancel();
    await expect(steer).rejects.toThrow();
    expect((await collect(run.events)).at(-1)).toMatchObject({ type: 'cancelled' });
  });

  it('cancels the native turn and keeps the process when agy settles it', async () => {
    const session = await createSession();
    const run = session.execute(request());
    const peer = await firstPeer();
    await peer.waitForPrompts(1);

    session.cancel();
    const events = await collect(run.events);

    expect(peer.cancelRequests).toEqual(['session-new']);
    expect(events.at(-1)).toMatchObject({ type: 'cancelled' });
    expect(peer.child.killed).toBe(false);
  });
});
