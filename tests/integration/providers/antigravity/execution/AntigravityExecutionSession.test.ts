import { spawnSync } from 'node:child_process';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

import { deferred } from '@test/helpers/ChatInputHarness';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { AntigravityNativeProcess,type CapturedAntigravityAgent } from '@test/helpers/providers/antigravity/AntigravityNativeProcess';
import { testDate, testTime } from '@test/helpers/testClock';
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

/** agy's transcript steps for a delegation: the subagent's id is the sender of its later report. */
const transcriptSteps = {
  user: (index: number, text: string, at: string) => ({ content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>`, created_at: at, source: 'USER_EXPLICIT', status: 'DONE', step_index: index, type: 'USER_INPUT' }),
  delegate: (index: number, at: string) => ({ created_at: at, status: 'DONE', step_index: index, tool_calls: [{ args: { Prompt: 'What is 17 * 23?', TypeName: 'self' }, name: 'invoke_subagent' }], type: 'PLANNER_RESPONSE' }),
  created: (index: number, subagent: string, at: string) => ({ content: `Created At: ${at}\nCreated the following subagent:\n{\n  "conversationId":  "${subagent}"\n}`, created_at: at, status: 'DONE', step_index: index, type: 'GENERIC' }),
  reply: (index: number, text: string, at: string) => ({ content: text, created_at: at, input_tokens: 100, status: 'DONE', step_index: index, type: 'PLANNER_RESPONSE' }),
  report: (index: number, subagent: string, text: string, at: string) => ({
    content: `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=${at} sender=${subagent} priority=MESSAGE_PRIORITY_HIGH content=${text}\n</SYSTEM_MESSAGE>`,
    created_at: at, status: 'DONE', step_index: index, type: 'SYSTEM_MESSAGE',
  }),
};

/** The live update agy streams when the model delegates to a subagent. */
function invokeSubagent(toolCallId: string) {
  const rawInput = { Prompt: 'What is 17 * 23?', TypeName: 'self' };
  return { kind: 'other', name: 'invoke_subagent', rawInput, sessionUpdate: 'tool_call', status: 'in_progress', title: 'Run invoke_subagent', toolCallId };
}

/**
 * Holds the next read of a session's transcript after it has taken its snapshot, until released. `nextReadDone`
 * resolves once the read that starts after it is called has delivered the whole file.
 */
function holdTranscriptRead(sessionId: string) {
  const [transcriptPath] = resolveAntigravityTranscriptPaths(path.join(vault, '.gemini', 'antigravity-cli'), sessionId);
  const actual = fsSync.createReadStream;
  const reading = deferred<void>();
  const release = deferred<void>();
  let held = false;
  let readWaiters: Array<() => void> = [];
  vi.spyOn(fsSync, 'createReadStream').mockImplementation(((file: fsSync.PathLike, options?: Parameters<typeof actual>[1]) => {
    if (file !== transcriptPath) return actual(file, options);
    if (held) {
      const waiters = readWaiters;
      readWaiters = [];
      return actual(file, options).once('close', () => waiters.forEach(resolve => resolve()));
    }
    held = true;
    const stream = new Readable({ read() {} });
    stream.push(fsSync.readFileSync(transcriptPath));
    reading.resolve();
    void release.promise.then(() => stream.push(null));
    // The reader consumes only the Readable surface of a file stream.
    return stream as fsSync.ReadStream;
  }) as typeof fsSync.createReadStream);
  return {
    nextReadDone: () => new Promise<void>(resolve => { readWaiters.push(resolve); }),
    reading: reading.promise,
    release: () => release.resolve(),
  };
}

/** Resolves with the events of the next background turn the session publishes. */
function nextBackgroundTurn(session: ProviderExecutionSession): Promise<ProviderSessionEvent[]> {
  const events: ProviderSessionEvent[] = [];
  return new Promise(resolve => {
    const unsubscribe = session.onEvent(event => {
      if (event.scope.kind !== 'background') return;
      events.push(event);
      if (event.type !== 'background_turn_completed') return;
      unsubscribe();
      resolve(events);
    });
  });
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
    expect(peer.resumeRequests[0].mcpServers).toEqual([]);
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
    expect(peer.resumeRequests[0].mcpServers).toEqual([]);
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
    // agy flushes each model call to the transcript before settling the prompt.
    await writeTranscript('session-new', [
      { source: 'USER_EXPLICIT', step_index: 0, type: 'USER_INPUT' },
      { cache_read_tokens: 0, input_tokens: 6_977, output_tokens: 55, step_index: 1, type: 'PLANNER_RESPONSE' },
      { step_index: 2, type: 'VIEW_FILE' },
      { cache_read_tokens: 5_073, input_tokens: 2_178, output_tokens: 55, step_index: 3, type: 'PLANNER_RESPONSE' },
    ]);
    // The response sums every model call in the turn.
    peer.finishPrompt({
      stopReason: 'end_turn',
      usage: { cachedReadTokens: 5_073, inputTokens: 9_155, outputTokens: 110, totalTokens: 14_338 },
    });
    const events = await collect(run.events);

    expect(events.filter(event => event.type === 'text_delta')).toEqual([expect.objectContaining({ text: 'Hi.' })]);
    // The meter shows the last model call's context against agy's 256,000-token auto-compaction point.
    expect(events).toContainEqual(expect.objectContaining({
      type: 'usage_updated',
      usage: expect.objectContaining({
        contextTokens: 7_251, contextWindow: 256_000, inputTokens: 9_155, model: 'gemini-4-argon', percentage: 3,
      }),
    }));
    expect(events.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
    expect(session.getSnapshot().providerSessionId).toBe('session-new');
  });

  it('hides the context meter when the transcript has no model call to measure', async () => {
    const session = await createSession();
    const run = session.execute(request('hello'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    await writeTranscript('session-new', [{ source: 'USER_EXPLICIT', step_index: 0, type: 'USER_INPUT' }]);
    peer.finishPrompt({ stopReason: 'end_turn', usage: { inputTokens: 900_000, outputTokens: 2, totalTokens: 900_002 } });
    const events = await collect(run.events);

    // The summed usage is no measure of the context; reporting no context tokens hides the meter.
    expect(events).toContainEqual(expect.objectContaining({
      type: 'usage_updated',
      usage: expect.objectContaining({ contextTokens: 0, inputTokens: 900_000, percentage: 0 }),
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
      missingProviderSessionId: 'session-gone',
      type: 'execution_error',
    });
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
    ['normal', 'deny', { optionId: 'reject', outcome: 'selected' }],
    ['auto', 'allow', { optionId: 'allow', outcome: 'selected' }],
    ['auto', 'deny', { optionId: 'reject', outcome: 'selected' }],
  ] as const)('asks before a tool runs in %s mode and answers %s', async (permissionMode, decision, outcome) => {
    const port = createInteractionPort();
    port.requestApproval.mockImplementation(async (approval: ProviderApprovalInteractionRequest) => ({
      decision, interactionId: approval.interactionId,
    }));
    const session = await createSession({ interactionPort: port });
    const run = session.execute(request('edit', { permissionMode }));
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

  it('publishes agy\'s own reply to a subagent result that lands after the turn, but not a report answered mid-turn', async () => {
    const session = await createSession();
    const run = session.execute(request('Delegate both'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.emit(invokeSubagent('call-1'), 'session-new');
    peer.emit(invokeSubagent('call-2'), 'session-new');
    // A report that arrived while the turn ran was streamed with it, even though agy settled the prompt in the same
    // second (agy 1.5.7 settles up to ~15 s after its last step); sub-2 is still out when the turn ends.
    const turn = [
      transcriptSteps.user(0, 'Delegate both', testTime({ minutes: -2 })),
      transcriptSteps.delegate(1, testTime({ minutes: -2 })),
      transcriptSteps.created(2, 'sub-1', testTime({ minutes: -2 })),
      transcriptSteps.delegate(3, testTime({ minutes: -2 })),
      transcriptSteps.created(4, 'sub-2', testTime({ minutes: -2 })),
      transcriptSteps.reply(5, 'Waiting.', testTime({ minutes: -2 })),
      transcriptSteps.report(6, 'sub-1', '17', testTime({ minutes: 5 })),
      transcriptSteps.reply(7, 'First result: 17.', testTime({ minutes: 5 })),
    ];
    await writeTranscript('session-new', turn);
    peer.finishPrompt({ stopReason: 'end_turn' });
    await collect(run.events);

    const background = nextBackgroundTurn(session);
    await writeTranscript('session-new', [
      ...turn,
      transcriptSteps.report(8, 'sub-2', '391', testTime({ minutes: 5 })),
      transcriptSteps.reply(9, 'SUB-RESULT=391', testTime({ minutes: 5 })),
    ]);
    const events = await background;
    expect(events.map(event => event.type)).toEqual(['background_turn_started', 'task_notification', 'text_delta', 'background_turn_completed']);
    expect(events[1]).toMatchObject({ content: '391' });
    expect(events[2]).toMatchObject({ text: 'SUB-RESULT=391' });
    expect(events.at(-1)).toMatchObject({ providerSessionId: 'session-new', reason: 'completed' });
  });

  it('publishes a late reply whose transcript write lands after the next turn started', async () => {
    const session = await createSession();
    const first = session.execute(request('Delegate'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.emit(invokeSubagent('call-1'), 'session-new');
    const delegation = [
      transcriptSteps.user(0, 'Delegate', testTime({ minutes: -2 })),
      transcriptSteps.delegate(1, testTime({ minutes: -2 })),
      transcriptSteps.created(2, 'sub-1', testTime({ minutes: -2 })),
      transcriptSteps.reply(3, 'Waiting.', testTime({ minutes: -2 })),
    ];
    await writeTranscript('session-new', delegation);
    peer.finishPrompt();
    await collect(first.events);

    const background = nextBackgroundTurn(session);
    const second = session.execute(request('Meanwhile'));
    await peer.waitForPrompts(2);
    // agy answered the report between the turns, but flushed it only after the next turn began.
    await writeTranscript('session-new', [
      ...delegation,
      transcriptSteps.report(4, 'sub-1', '391', testTime({ minutes: 5 })),
      transcriptSteps.reply(5, 'SUB-RESULT=391', testTime({ minutes: 5 })),
      transcriptSteps.user(6, 'Meanwhile', testTime({ minutes: 6 })),
      transcriptSteps.reply(7, 'Sure.', testTime({ minutes: 6 })),
    ]);
    peer.finishPrompt();
    await collect(second.events);
    const events = await background;
    expect(events.filter(event => event.type === 'text_delta')).toEqual([expect.objectContaining({ text: 'SUB-RESULT=391' })]);
  });

  it('keeps a late reply when the next request fails before it sends a prompt', async () => {
    const session = await createSession();
    const first = session.execute(request('Delegate', { instructions: 'First.' }));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.emit(invokeSubagent('call-1'), 'session-new');
    const delegation = [
      transcriptSteps.user(0, 'Delegate', testTime({ minutes: -2 })),
      transcriptSteps.delegate(1, testTime({ minutes: -2 })),
      transcriptSteps.created(2, 'sub-1', testTime({ minutes: -2 })),
      transcriptSteps.reply(3, 'Waiting.', testTime({ minutes: -2 })),
    ];
    await writeTranscript('session-new', delegation);
    peer.finishPrompt();
    await collect(first.events);

    // The changed prompt re-resumes the session; agy finished its own reply before that resume failed.
    const background = nextBackgroundTurn(session);
    const resuming = deferred<void>();
    const release = deferred<void>();
    peer.resumeGate = async () => {
      resuming.resolve();
      await release.promise;
      throw new Error('Resume temporarily rejected');
    };
    const second = session.execute(request('Meanwhile', { instructions: 'Second.' }));
    await resuming.promise;
    await writeTranscript('session-new', [
      ...delegation,
      transcriptSteps.report(4, 'sub-1', '391', testTime({ minutes: 5 })),
      transcriptSteps.reply(5, 'SUB-RESULT=391', testTime({ minutes: 5 })),
    ]);
    release.resolve();
    expect((await collect(second.events)).at(-1)).toMatchObject({ type: 'execution_error' });
    expect(peer.prompts).toHaveLength(1);
    const events = await background;
    expect(events.filter(event => event.type === 'text_delta')).toEqual([expect.objectContaining({ text: 'SUB-RESULT=391' })]);
  });

  it('drops the between-turn output agy replays before the next prompt\'s echo', async () => {
    const session = await createSession();
    const first = session.execute(request('Delegate'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.finishPrompt();
    await collect(first.events);
    // agy finished a background command and replied on its own after the turn; both reached only the transcript.
    peer.betweenTurnOutput.push(
      { content: [{ content: { text: 'Command output:\nBG-DONE', type: 'text' }, type: 'content' }], kind: 'execute',
        sessionUpdate: 'tool_call_update', status: 'completed', title: 'sleep 25 && echo BG-DONE', toolCallId: 'call-earlier' },
      { content: { text: 'The background task finished.', type: 'text' }, sessionUpdate: 'agent_message_chunk' },
    );

    const second = session.execute(request('Meanwhile'));
    await peer.waitForPrompts(2);
    peer.emit({ content: { text: 'Sure.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    peer.finishPrompt();
    const events = await collect(second.events);
    expect(events.filter(event => event.type === 'text_delta')).toEqual([expect.objectContaining({ text: 'Sure.' })]);
    expect(events.filter(event => event.type === 'tool_started' || event.type === 'tool_completed')).toEqual([]);
  });

  it('holds idle release while a subagent is out and releases it once agy\'s reply is published', async () => {
    const session = await createSession();
    const run = session.execute(request('Delegate'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    expect(session.blocksIdleRelease?.()).toBe(false);
    peer.emit(invokeSubagent('call-1'), 'session-new');
    const delegation = [
      transcriptSteps.user(0, 'Delegate', testTime({ minutes: -2 })),
      transcriptSteps.delegate(1, testTime({ minutes: -2 })),
      transcriptSteps.created(2, 'sub-1', testTime({ minutes: -2 })),
      transcriptSteps.reply(3, 'Waiting.', testTime({ minutes: -2 })),
    ];
    await writeTranscript('session-new', delegation);
    peer.finishPrompt();
    await collect(run.events);
    // Releasing the idle session would end agy's process and the subagent with it.
    expect(session.blocksIdleRelease?.()).toBe(true);

    const background = nextBackgroundTurn(session);
    await writeTranscript('session-new', [
      ...delegation,
      transcriptSteps.report(4, 'sub-1', '391', testTime({ minutes: 5 })),
      transcriptSteps.reply(5, 'SUB-RESULT=391', testTime({ minutes: 5 })),
    ]);
    await background;
    expect(session.blocksIdleRelease?.()).toBe(false);
  });

  it('records the boundary of a turn that ends while an earlier transcript read is still running', async () => {
    const session = await createSession();
    const first = session.execute(request('Delegate'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.emit(invokeSubagent('call-1'), 'session-new');
    const delegation = [
      transcriptSteps.user(0, 'Delegate', testTime({ minutes: -2 })),
      transcriptSteps.delegate(1, testTime({ minutes: -2 })),
      transcriptSteps.created(2, 'sub-1', testTime({ minutes: -2 })),
      transcriptSteps.reply(3, 'Waiting.', testTime({ minutes: -2 })),
    ];
    await writeTranscript('session-new', delegation);
    peer.finishPrompt();
    await collect(first.events);
    // The read the first turn's end started has the first turn's transcript, and returns only after the next turn.
    const read = holdTranscriptRead('session-new');
    await read.reading;

    const second = session.execute(request('Meanwhile'));
    await peer.waitForPrompts(2);
    const meanwhile = [
      ...delegation,
      transcriptSteps.user(4, 'Meanwhile', testTime({ minutes: -1 })),
      transcriptSteps.reply(5, 'Sure.', testTime({ minutes: -1 })),
    ];
    await writeTranscript('session-new', meanwhile);
    peer.finishPrompt();
    await collect(second.events);
    const reread = read.nextReadDone();
    read.release();
    await reread;

    const background = nextBackgroundTurn(session);
    await writeTranscript('session-new', [
      ...meanwhile,
      transcriptSteps.report(6, 'sub-1', '391', testTime({ minutes: 5 })),
      transcriptSteps.reply(7, 'SUB-RESULT=391', testTime({ minutes: 5 })),
    ]);
    const events = await background;
    expect(events.filter(event => event.type === 'text_delta')).toEqual([expect.objectContaining({ text: 'SUB-RESULT=391' })]);
  });

  it('gives up on a quiet subagent after half an hour when only polling can see the transcript', async () => {
    const session = await createSession();
    const [transcriptPath] = resolveAntigravityTranscriptPaths(path.join(vault, '.gemini', 'antigravity-cli'), 'session-new');
    vi.spyOn(fsSync, 'watch').mockImplementation(() => { throw new Error('EMFILE: too many open files, watch'); });
    let lastPoll: Promise<unknown> = Promise.resolve();
    const stat = fs.stat;
    vi.spyOn(fs, 'stat').mockImplementation((file, options) => {
      const result = stat(file, options);
      if (file === transcriptPath) lastPoll = result.catch(() => undefined);
      return result;
    });
    const run = session.execute(request('Delegate'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.emit(invokeSubagent('call-1'), 'session-new');
    const delegation = [
      transcriptSteps.user(0, 'Delegate', testTime({ minutes: -2 })),
      transcriptSteps.delegate(1, testTime({ minutes: -2 })),
      transcriptSteps.created(2, 'sub-1', testTime({ minutes: -2 })),
      transcriptSteps.reply(3, 'Waiting.', testTime({ minutes: -2 })),
    ];
    await writeTranscript('session-new', delegation);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    peer.finishPrompt();
    await collect(run.events);
    const poll = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      await lastPoll;
    };
    await poll(5_000);
    expect(session.blocksIdleRelease?.()).toBe(true);

    // A transcript change seen by a poll restarts the quiet limit.
    await poll(20 * 60_000);
    await writeTranscript('session-new', delegation);
    // Polls compare size and mtime; a same-size rewrite can land within the filesystem clock's tick.
    const later = new Date((await stat(transcriptPath)).mtimeMs + 1_000);
    await fs.utimes(transcriptPath, later, later);
    await poll(5_000);
    await poll(11 * 60_000);
    expect(session.blocksIdleRelease?.()).toBe(true);
    // Polls that find the transcript unchanged do not.
    await poll(20 * 60_000);
    expect(session.blocksIdleRelease?.()).toBe(false);
  });

  it('stops waiting for a subagent that died with a replaced process once the later subagents report', async () => {
    const session = await createSession({}, peer => { peer.knownSessions.add('session-new'); });
    const first = session.execute(request('Delegate'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    peer.emit(invokeSubagent('call-1'), 'session-new');
    const delegation = [
      transcriptSteps.user(0, 'Delegate', testTime({ minutes: -3 })),
      transcriptSteps.delegate(1, testTime({ minutes: -3 })),
      transcriptSteps.created(2, 'sub-1', testTime({ minutes: -3 })),
      transcriptSteps.reply(3, 'Waiting.', testTime({ minutes: -3 })),
    ];
    await writeTranscript('session-new', delegation);
    peer.finishPrompt();
    await collect(first.events);
    expect(session.blocksIdleRelease?.()).toBe(true);
    // The read the first turn's end started returns only after the replacement process's turn has ended.
    const read = holdTranscriptRead('session-new');
    await read.reading;

    // Entering YOLO replaces agy's process, and sub-1 with it: it never reports.
    const second = session.execute(request('Delegate again', { permissionMode: 'yolo' }));
    const replacement = await spawnedProcess(2);
    await replacement.waitForPrompts(1);
    replacement.emit(invokeSubagent('call-2'), 'session-new');
    const again = [
      ...delegation,
      transcriptSteps.user(4, 'Delegate again', testTime({ minutes: -2 })),
      transcriptSteps.delegate(5, testTime({ minutes: -2 })),
      transcriptSteps.created(6, 'sub-2', testTime({ minutes: -2 })),
      transcriptSteps.reply(7, 'Waiting again.', testTime({ minutes: -2 })),
    ];
    await writeTranscript('session-new', again);
    replacement.finishPrompt();
    await collect(second.events);
    const reread = read.nextReadDone();
    read.release();
    await reread;

    const background = nextBackgroundTurn(session);
    await writeTranscript('session-new', [
      ...again,
      transcriptSteps.report(8, 'sub-2', '391', testTime({ minutes: 5 })),
      transcriptSteps.reply(9, 'SUB-RESULT=391', testTime({ minutes: 5 })),
    ]);
    expect((await background).filter(event => event.type === 'text_delta')).toEqual([expect.objectContaining({ text: 'SUB-RESULT=391' })]);
    expect(session.blocksIdleRelease?.()).toBe(false);
  });

  it('runs YOLO main chat with agy\'s skip-permissions flag and restarts the process when leaving or entering YOLO', async () => {
    const session = await createSession({}, peer => { peer.knownSessions.add('session-new'); });
    const launchArgs = () => vi.mocked(spawn).mock.calls.map(([, args]) => args);
    for (const [index, [permissionMode, processes]] of ([['yolo', 1], ['yolo', 1], ['normal', 2], ['yolo', 3]] as const).entries()) {
      const prompts = spawned.length === processes ? spawned[processes - 1].prompts.length : 0;
      const run = session.execute(request(`turn ${index}`, { permissionMode }));
      const peer = await spawnedProcess(processes);
      await peer.waitForPrompts(prompts + 1);
      peer.finishPrompt();
      await collect(run.events);
    }
    // agy applies the flag to its whole process (subagents included), so changing YOLO replaces the process.
    expect(launchArgs()).toEqual([
      ['acp', '--dangerously-skip-permissions'],
      ['acp'],
      ['acp', '--dangerously-skip-permissions'],
    ]);
    expect(spawned.flatMap(peer => peer.newRequests)).toHaveLength(1);
    expect(spawned.map(peer => peer.resumeRequests.map(entry => [entry.sessionId, entry._meta]))).toEqual([
      [['session-new', appendMeta('Be exact.')]],
      [['session-new', appendMeta('Be exact.')]],
      [['session-new', appendMeta('Be exact.')]],
    ]);
  });

  it('never gives auxiliary sessions the skip-permissions flag, even in YOLO', async () => {
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
    peer.finishPrompt();
    const events = await collect(run.events);

    expect(peer.prompts[0].request.prompt).toEqual([{ text: '/compact keep the plan', type: 'text' }]);
    expect(events.map(event => event.type).filter(type => type === 'context_compacted' || type === 'turn_completed'))
      .toEqual(['context_compacted', 'turn_completed']);
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
    // The chat consumer treats the first boundary as the turn's own input, so the steer needs its own second one.
    expect(events.filter(event => event.type === 'user_message_started').map(event => event.content))
      .toEqual(['first', 'also this']);
    expect(events.filter(event => event.type === 'turn_completed')).toHaveLength(1);
  });

  // A FIFO holds the transcript read open until the test writes it; Windows has no named pipes.
  it.skipIf(process.platform === 'win32')('refuses a steer once the turn\'s final response has arrived', async () => {
    const session = await createSession();
    const run = session.execute(request('first'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    const [transcriptPath] = resolveAntigravityTranscriptPaths(path.join(vault, '.gemini', 'antigravity-cli'), 'session-new');
    await mkdir(path.dirname(transcriptPath), { recursive: true });
    expect(spawnSync('mkfifo', [transcriptPath]).status).toBe(0);
    peer.finishPrompt({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
    // Opening a FIFO for writing completes only once the session has opened it to read the turn's usage.
    const writer = await fs.open(transcriptPath, 'w');

    const steer = session.steer(request('also this'));
    await writer.writeFile(`${JSON.stringify({ input_tokens: 10, step_index: 1, type: 'PLANNER_RESPONSE' })}\n`);
    await writer.close();
    const events = await collect(run.events);

    await expect(steer).resolves.toBe(false);
    expect(peer.prompts).toHaveLength(1);
    expect(events.filter(event => event.type === 'user_message_started').map(event => event.content)).toEqual(['first']);
    expect(events.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
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
    expect(events.filter(event => event.type === 'user_message_started').map(event => event.content))
      .toEqual(['first', '/goal Reply with DONE']);
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
    const accepted = session.steer(request('two'));
    await peer.waitForPrompts(2);
    peer.emit({ content: { text: 'two', type: 'text' }, sessionUpdate: 'user_message_chunk' }, 'session-new');
    await expect(accepted).resolves.toBe(true);
    peer.failNextPrompt('Prompt rejected');
    await expect(session.steer(request('three'))).resolves.toBe(false);
    peer.finishPrompt();
    const events = await collect(run.events);

    expect(events.filter(event => event.type === 'user_message_started').map(event => event.content)).toEqual(['first', 'two']);
    expect(events.at(-1)).toMatchObject({ reason: 'completed', type: 'turn_completed' });
  });

  it('publishes a steer agy does not echo once the turn it joined completes', async () => {
    const session = await createSession();
    const run = session.execute(request('first'));
    const peer = await firstPeer();
    await peer.waitForPrompts(1);
    const image: ProviderExecutionRequest = { ...request(''), input: [{ image: {
      data: 'iVBORw0KGgo=', id: 'image-1', mediaType: 'image/png', name: 'square.png', size: 8, source: 'paste',
    }, type: 'image' }] };
    const steer = session.steer(image);
    await peer.waitForPrompts(2);
    // agy does not echo image-only input.
    peer.emit({ content: { text: 'A blue square.', type: 'text' }, sessionUpdate: 'agent_message_chunk' }, 'session-new');
    peer.finishPrompt();
    const events = await collect(run.events);

    await expect(steer).resolves.toBe(true);
    const types = events.map(event => event.type);
    expect(events.filter(event => event.type === 'user_message_started')).toHaveLength(2);
    expect(types.lastIndexOf('user_message_started')).toBeLessThan(types.indexOf('turn_completed'));
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
