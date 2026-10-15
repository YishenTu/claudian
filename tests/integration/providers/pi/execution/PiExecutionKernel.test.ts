import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import type { ProviderExecutionSession, ProviderSessionToolPort, ProviderToolPolicy } from '@/core/execution';
import { PiExecutionBackend } from '@/providers/pi/execution/PiExecutionBackend';
import { PiRPCSessionKernel } from '@/providers/pi/execution/PiExecutionKernel';
import type { PiRPCRecord } from '@/providers/pi/runtime/PiRPCTransport';

jest.setTimeout(10_000);

describe('Pi execution kernel with an external protocol process', () => {
  let root: string;
  let kernel: PiRPCSessionKernel;
  let events: PiRPCRecord[];
  let closed: Promise<Error | undefined>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'claudian-pi-kernel-'));
    await fs.writeFile(path.join(root, 'source.jsonl'), JSON.stringify({ type: 'session', version: 3, id: 'pi-source', cwd: root }) + '\n');
    events = [];
    let resolveClose!: (error?: Error) => void;
    closed = new Promise(resolve => { resolveClose = resolve; });
    kernel = new PiRPCSessionKernel({
      command: process.execPath,
      args: [path.resolve('tests/fixtures/providers/pi/PiSessionProcess.mjs')],
      cwd: root,
      env: { ...process.env, CLAUDIAN_TEST_PI_ROOT: root },
      processKey: 'fixture', sessionTarget: null,
    }, {
      onClose: error => resolveClose(error),
      onEvent: event => events.push(event),
      onExtensionChunk: () => undefined,
      onExtensionRequest: () => true,
    }, null);
    kernel.start();
  });

  afterEach(async () => {
    await kernel.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('routes response payloads and streamed events through the real transport', async () => {
    await expect(kernel.request('get_state', {}, 3_000)).resolves.toMatchObject({
      sessionId: 'pi-source', sessionFile: path.join(root, 'source.jsonl'),
    });
    await kernel.request('prompt', { message: 'Remember apples' }, 3_000);
    // An echo after the prompt is an ordered protocol barrier for its preceding events.
    await expect(kernel.request('fixture_echo', { value: 'complete' }, 3_000)).resolves.toEqual({ value: 'complete' });
    expect(events).toEqual([
      { type: 'agent_start' },
      { type: 'message_update', assistantMessageEvent: { text_delta: 'Reply 1' } },
      { type: 'agent_end' },
      { type: 'agent_settled' },
    ]);
  });

  it('routes an extension request back to the process as cancellation when no renderer is available', async () => {
    await expect(kernel.request('fixture_extension', {}, 3_000)).resolves.toMatchObject({
      type: 'extension_ui_response', id: 'dialog-1', cancelled: true,
    });
    expect(events).toEqual([]);
  });

  it('rejects pending work and releases the child process on shutdown', async () => {
    const { pid } = await kernel.request<{ pid: number }>('get_state', {}, 3_000);
    const pending = kernel.request('fixture_hang', {}, 3_000).catch((error: Error) => error);
    await kernel.request('fixture_echo', { value: 'waiting' }, 3_000);
    expect(events).toContainEqual({ type: 'fixture_waiting' });

    await kernel.shutdown();
    expect(await pending).toMatchObject({ message: expect.stringMatching(/disposed|closed/i) });
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    expect(() => kernel.request('get_state')).toThrow('Pi execution kernel is not started');
  });

  it('surfaces unexpected process exit to both pending work and the lifecycle observer', async () => {
    await expect(kernel.request('fixture_exit', {}, 3_000)).rejects.toThrow(/17|closed/i);
    await expect(closed).resolves.toEqual(expect.objectContaining({ message: expect.stringMatching(/17|closed/i) }));
    expect(kernel.getStderrSnapshot()).toContain('fixture requested exit');
  });
});

describe('Pi session tools through the generated extension', () => {
  let root: string;
  let sessionFile: string;
  let kernel: PiRPCSessionKernel;
  let session: ProviderExecutionSession;
  let port: ProviderSessionToolPort;
  const configuration = { model: 'pi:anthropic/claude-sonnet-4', reasoning: null, systemInstructions: { kind: 'provider-default' as const } };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'claudian-pi-session-tools-'));
    sessionFile = path.join(root, '.pi', 'agent', 'sessions', 'source.jsonl');
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'pi-source', cwd: root }) + '\n');
    port = { list: jest.fn().mockResolvedValue({ sessions: [] }), send: jest.fn().mockResolvedValue({ sessionId: 'recipient', title: 'Review', provider: 'codex', status: 'queued' }), read: jest.fn() };
  });

  afterEach(async () => {
    await session?.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function createSession(bound = true, mismatch = false, persistent = true, startupTool = false) {
    const host = {
      getResolvedProviderCliPath: async () => process.execPath,
      settings: { model: configuration.model, effortLevel: 'off', systemPrompt: '', userName: '',
        providerConfigs: { pi: { enabled: true, visibleModels: [configuration.model],
          discoveredModels: [{ encodedId: configuration.model, id: 'claude-sonnet-4', provider: 'anthropic', label: 'Sonnet', input: ['text'], reasoning: true, thinkingLevels: ['off'] }] } } },
    };
    const backend = new PiExecutionBackend(host as any, {
      createKernel: (spec, callbacks) => {
        kernel = new PiRPCSessionKernel({ ...spec, command: process.execPath,
          args: [path.resolve('tests/fixtures/providers/pi/PiSessionProcess.mjs'), ...spec.args],
          env: { ...spec.env, CLAUDIAN_TEST_PI_ROOT: root, ...(startupTool ? { CLAUDIAN_TEST_PI_STARTUP_TOOL: '1' } : {}), ...(mismatch ? { CLAUDIAN_TEST_PI_MISMATCH: '1' } : {}) },
        }, callbacks, null);
        return kernel;
      },
    });
    session = backend.createSession({ interactionPort: { askUserQuestion: jest.fn(), requestApproval: jest.fn(), dismissInteraction: jest.fn() }, lifecycle: persistent ? 'persistent' : 'ephemeral', nativePersistence: persistent ? 'enabled' : 'disabled-if-supported', vaultWorkingDirectory: root,
      ...(bound ? { sessionTools: port } : {}),
      resumeSeed: { providerSessionId: 'pi-source', providerState: { sessionId: 'pi-source', sessionFile } },
    });
    const events = [];
    for await (const event of session.execute({ configuration, toolPolicy: { kind: 'provider-default' },
      input: [{ type: 'text', text: 'Warmup' }], signal: new AbortController().signal }).events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: mismatch ? 'execution_error' : 'turn_completed' });
    return events;
  }

  async function openRun(toolPolicy: ProviderToolPolicy = { kind: 'provider-default' }) {
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const run = session.execute({ configuration, toolPolicy, input: [{ type: 'text', text: 'fixture:hold' }], signal: new AbortController().signal });
    const drained = (async () => {
      for await (const event of run.events) if (event.type === 'text_delta') ready();
    })();
    await started;
    return { run, drained };
  }

  it('registers only in bound execution sessions and round-trips both tools without dialogs', async () => {
    await createSession(false);
    expect(await kernel.request('fixture_tools')).toEqual({ tools: [] });
    const unbound = await openRun();
    await kernel.request('fixture_emit', { event: { type: 'tool_execution_start', toolCallId: 'unbound', toolName: 'claudian_send_message' } });
    const denied = await kernel.request<{ value: string }>('fixture_private_input', { dialogId: 'unbound-dialog', payload: { name: 'claudian_send_message', toolCallId: 'unbound', args: { text: 'No' } } });
    expect(JSON.parse(denied.value)).toMatchObject({ isError: true, text: expect.stringMatching(/main chat/) });
    expect(port.send).not.toHaveBeenCalled();
    unbound.run.cancel();
    await unbound.drained;
    await session.dispose();
    await createSession();
    expect(await kernel.request('fixture_tools')).toMatchObject({ tools: [
      { name: 'claudian_list_destinations', parameters: { type: 'object', properties: {} } },
      { name: 'claudian_send_message', parameters: { properties: expect.objectContaining({ text: expect.anything(), mode: expect.anything() }) } },
      { name: 'claudian_read_session', parameters: { required: ['sessionId'] } },
    ] });
    const { drained } = await openRun();
    expect(await kernel.request('fixture_tool', { name: 'claudian_list_destinations', toolCallId: 'list', args: {} }))
      .toMatchObject({ isError: false, content: [{ text: '{"sessions":[]}' }] });
    expect(await kernel.request('fixture_tool', { name: 'claudian_send_message', toolCallId: 'send', args: { text: 'Hello', sessionId: 'recipient' } }))
      .toMatchObject({ isError: false, content: [{ text: JSON.stringify({ sessionId: 'recipient', title: 'Review', provider: 'codex', status: 'queued' }) }] });
    expect(port.send).toHaveBeenCalledWith({ text: 'Hello', sessionId: 'recipient' }, expect.any(AbortSignal));
    await kernel.request('fixture_emit', { event: { type: 'agent_settled' } });
    await drained;
  });

  it('exposes session tools independently of the persistence-only tree bridge', async () => {
    await createSession(true, false, false);
    expect(kernel.launchSpec.enableTreeBridge).toBeUndefined();
    const { run, drained } = await openRun();
    expect(await kernel.request('fixture_tool', { name: 'claudian_list_destinations', toolCallId: 'ephemeral', args: {} }))
      .toMatchObject({ isError: false, content: [{ text: '{"sessions":[]}' }] });
    run.cancel();
    await drained;
  });

  it.each<ProviderToolPolicy>([{ kind: 'read-only' }, { kind: 'passive' }, { kind: 'allow-list', names: ['claudian_send_message'] }])('denies calls under $kind even when the tool is named', async toolPolicy => {
    await createSession();
    // The fixture can call registered tools despite native filtering, exercising the call-time guard.
    const { run, drained } = await openRun(toolPolicy);
    const result = await kernel.request('fixture_tool', { name: 'claudian_send_message', toolCallId: 'denied', args: { text: 'No' } });
    expect(result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/default tool policy/) }] });
    expect(port.send).not.toHaveBeenCalled();
    const index = kernel.launchSpec.args.indexOf('--tools');
    const namedTools = index < 0 ? [] : kernel.launchSpec.args[index + 1].split(',');
    expect(namedTools).toEqual(expect.arrayContaining(toolPolicy.kind === 'passive' ? [] : ['claudian_list_destinations', 'claudian_send_message']));
    run.cancel();
    await drained;
  });

  it.each(['tool end', 'cancel', 'settlement', 'close'] as const)('revokes a pending call on %s', async action => {
    let entered!: () => void;
    const called = new Promise<void>(resolve => { entered = resolve; });
    let callSignal!: AbortSignal;
    let finish!: () => void;
    port.send = jest.fn((_args, signal) => {
      callSignal = signal;
      entered();
      return new Promise(resolve => { finish = () => resolve({ sessionId: 'recipient', title: 'Review', provider: 'codex', status: 'queued' }); });
    });
    await createSession();
    const { run, drained } = await openRun();
    const result = kernel.request('fixture_tool', { name: 'claudian_send_message', toolCallId: 'pending', args: { text: 'Wait' } }).catch(() => undefined);
    await called;
    expect(callSignal.aborted).toBe(false);
    if (action === 'tool end') await kernel.request('fixture_tool_end', { toolCallId: 'pending' });
    else if (action === 'cancel') run.cancel();
    else if (action === 'settlement') await kernel.request('fixture_emit', { event: { type: 'agent_settled' } });
    else await kernel.request('fixture_exit').catch(() => undefined);
    if (action === 'tool end') await result;
    else await drained;
    expect(callSignal.aborted).toBe(true);
    finish();
    await result;
  });

  it('cannot attach a delayed callback from a settled run to the next run', async () => {
    await createSession();
    const first = await openRun();
    await kernel.request('fixture_emit', { event: { type: 'tool_execution_start', toolCallId: 'old', toolName: 'claudian_send_message' } });
    await kernel.request('fixture_emit', { event: { type: 'agent_settled' } });
    await first.drained;
    const next = await openRun();
    const late = await kernel.request('fixture_private_input', { dialogId: 'late', payload: { name: 'claudian_send_message', toolCallId: 'old', args: { text: 'Late' } } });
    expect(late).toMatchObject({ cancelled: true });
    expect(port.send).not.toHaveBeenCalled();
    next.run.cancel();
    await next.drained;
  });

  it('cancels startup extension input before resume identity is proved', async () => {
    await createSession(true, false, true, true);
    expect(JSON.parse(await fs.readFile(path.join(root, 'startup-tool.json'), 'utf8')))
      .toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/cancelled/) }] });
    expect(port.send).not.toHaveBeenCalled();
  });

  it('does not accept a mismatched resume identity', async () => {
    const events = await createSession(true, true);
    expect(events.at(-1)).toMatchObject({ type: 'execution_error' });
    expect(port.send).not.toHaveBeenCalled();
  });
});
