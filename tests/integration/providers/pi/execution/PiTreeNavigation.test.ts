import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { testTime } from '@test/helpers/testClock';

import { isBranchableExecutionSession, isSteerableExecutionSession, type ProviderExecutionRequest, type ProviderExecutionSession } from '@/core/execution';
import { PiExecutionBackend } from '@/providers/pi/execution/PiExecutionBackend';
import { PiRPCSessionKernel } from '@/providers/pi/execution/PiExecutionKernel';
import { PiConversationHistoryService } from '@/providers/pi/history/PiConversationHistoryService';

const configuration = { model: 'pi:anthropic/claude-sonnet-4', reasoning: null, systemInstructions: { kind: 'provider-default' as const } };

it.each([false, true])('edits, switches and resumes native branches without losing history (recreate during recovery: %s)', async recreateDuringRecovery => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-tree-integration-'));
  const sessionDir = path.join(root, '.pi', 'agent', 'sessions');
  await fs.mkdir(sessionDir, { recursive: true });
  const sessionFile = path.join(sessionDir, 'source.jsonl');
  await fs.writeFile(sessionFile, JSON.stringify({ type: 'session', version: 3, id: 'pi-source', cwd: root, timestamp: testTime() }) + '\n');
  const host = {
    getResolvedProviderCliPath: async () => process.execPath,
    settings: { model: configuration.model, effortLevel: 'off', systemPrompt: '', userName: '',
      providerConfigs: { pi: { enabled: true, toolMode: 'all', visibleModels: [configuration.model],
        discoveredModels: [{ encodedId: configuration.model, id: 'claude-sonnet-4', provider: 'anthropic', label: 'Sonnet', input: ['text', 'image'], reasoning: true, thinkingLevels: ['off', 'high'] }] } } },
  };
  let kernel!: PiRPCSessionKernel;
  const backend = new PiExecutionBackend(host as any, { commandCatalog: { setCommandSnapshot: jest.fn() } } as any, {
    createKernel: (spec, callbacks) => {
      kernel = new PiRPCSessionKernel({ ...spec, command: process.execPath,
        args: [path.resolve('tests/fixtures/providers/pi/PiSessionProcess.mjs'), ...spec.args],
        env: { ...spec.env, CLAUDIAN_TEST_PI_ROOT: root },
      }, callbacks, null);
      return kernel;
    },
  });
  const createSession = (providerState: Record<string, unknown>) => backend.createSession({
    lifecycle: 'persistent', nativePersistence: 'enabled', vaultWorkingDirectory: root,
    interactionPort: { askUserQuestion: jest.fn(), requestApproval: jest.fn(), dismissInteraction: jest.fn() },
    resumeSeed: { providerSessionId: 'pi-source', providerState },
  });
  let session: ProviderExecutionSession = createSession({ sessionFile, sessionId: 'pi-source' });
  const send = async (text: string) => {
    const request: ProviderExecutionRequest = { configuration, toolPolicy: { kind: 'provider-default' },
      input: [{ type: 'text', text }], signal: new AbortController().signal };
    const events = [];
    for await (const event of session.execute(request).events) events.push(event);
    const sent = (await fs.readFile(path.join(root, 'contexts.jsonl'), 'utf8')).trim().split('\n').length;
    expect(events.at(-1)).toMatchObject({ type: 'turn_completed', nativeUserMessageId: `pi-user-${sent}` });
  };
  try {
    await send('A');
    if (!isBranchableExecutionSession(session)) throw new Error('Missing tree capability');
    const original = await fs.readFile(sessionFile, 'utf8');
    const edit = await session.navigateConversationBranch({ userMessageId: 'pi-user-1', configuration });
    expect(edit).toEqual({ status: 'committed', messages: [], usage: null });
    expect(await fs.readFile(sessionFile, 'utf8')).toBe(original);
    const saved = session.getSnapshot().providerState!;
    await session.dispose();
    session = createSession({ ...saved });
    const history = await new PiConversationHistoryService().hydrateConversationHistory({
      sessionId: 'pi-source', providerState: { ...saved }, messages: [{ id: 'stale', role: 'user', content: 'stale', timestamp: Date.now() }],
    }, root);
    expect(history.messages).toEqual([]);
    await send('B');
    if (!isBranchableExecutionSession(session)) throw new Error('Missing tree capability');
    const branchState = await session.getConversationBranches();
    expect(branchState.branches).toEqual({ 'pi-user-1': ['pi-user-1', 'pi-user-2'], 'pi-user-2': ['pi-user-1', 'pi-user-2'] });
    const branchA = await session.navigateConversationBranch({ userMessageId: 'pi-user-2', branchMessageId: 'pi-user-1', configuration });
    expect((branchA.status === 'committed' ? branchA.messages : []).map(message => message.content)).toEqual(['A', 'Reply 1']);
    expect(branchA).toMatchObject({ usage: { contextTokens: 1010, contextWindow: 200000 } });
    await kernel.request('fixture_tree_cancel', { cancel: true });
    const beforeCancel = session.getSnapshot().providerState;
    expect(await session.navigateConversationBranch({ userMessageId: 'pi-user-1', branchMessageId: 'pi-user-2', configuration })).toMatchObject({ status: 'cancelled' });
    expect(session.getSnapshot().providerState).toEqual(beforeCancel);
    await kernel.request('fixture_tree_cancel', { cancel: false });
    const branchB = await session.navigateConversationBranch({ userMessageId: 'pi-user-1', branchMessageId: 'pi-user-2', configuration });
    expect((branchB.status === 'committed' ? branchB.messages : []).map(message => message.content)).toEqual(['B', 'Reply 2']);
    expect(branchB).toMatchObject({ usage: { contextTokens: 2010, contextWindow: 200000 } });
    const requestBeforeLoss = kernel.request.bind(kernel);
    const lostReply = jest.spyOn(kernel, 'request').mockImplementation((async (type, payload, timeout, signal) => {
      const reply = await requestBeforeLoss(type, payload, timeout, signal);
      if (type === 'claudian_tree' && payload?.operation === 'restore' && payload.leafId === 'pi-assistant-1') {
        throw new Error('Reply lost after native navigation');
      }
      return reply;
    }) as typeof kernel.request);
    expect(await session.navigateConversationBranch({ userMessageId: 'pi-user-2', branchMessageId: 'pi-user-1', configuration }))
      .toMatchObject({ status: 'recovery-required' });
    lostReply.mockRestore();
    if (recreateDuringRecovery) {
      const recoveryState = session.getSnapshot().providerState!;
      await session.dispose();
      session = createSession({ ...recoveryState });
      if (!isBranchableExecutionSession(session)) throw new Error('Missing tree capability');
    }
    const rolledBack = await session.reconcileConversationBranch({ configuration });
    expect(rolledBack).toMatchObject({ status: 'cancelled', usage: { contextTokens: 2010 } });
    expect(('messages' in rolledBack ? rolledBack.messages : [])?.map(message => message.content)).toEqual(['B', 'Reply 2']);
    const hydration = jest.spyOn(PiConversationHistoryService.prototype, 'hydrateConversationHistory').mockRejectedValueOnce(new Error('History read unavailable'));
    expect(await session.navigateConversationBranch({ userMessageId: 'pi-user-2', branchMessageId: 'pi-user-1', configuration }))
      .toMatchObject({ status: 'recovery-required' });
    const recovered = await session.reconcileConversationBranch({ configuration });
    expect(recovered).toMatchObject({ status: 'committed', usage: { contextTokens: 1010 } });
    expect((recovered.status === 'committed' ? recovered.messages : []).map(message => message.content)).toEqual(['A', 'Reply 1']);
    hydration.mockRestore();
    const switched = session.getSnapshot().providerState!;
    await session.dispose();
    session = createSession({ ...switched });
    await send('Continue A');
    const contexts = (await fs.readFile(path.join(root, 'contexts.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(contexts.map(item => item.ids)).toEqual([[], [], ['pi-user-1', 'pi-assistant-1']]);
    expect(await fs.readFile(sessionFile, 'utf8')).toContain('Reply 2');
    await kernel.request('fixture_hold_next', { userOnly: true });
    const interrupted = session.execute({ configuration, toolPolicy: { kind: 'provider-default' },
      input: [{ type: 'text', text: 'Interrupted continuation' }], signal: new AbortController().signal });
    for await (const event of interrupted.events) {
      if (event.type === 'text_delta') interrupted.cancel();
    }
    if (!isBranchableExecutionSession(session)) throw new Error('Missing tree capability');
    const interruptedBranches = await session.getConversationBranches([
      { id: 'root', role: 'user', content: 'A', timestamp: Date.now(), userMessageId: 'pi-user-1' },
      { id: 'continued', role: 'user', content: 'Continue A', timestamp: Date.now(), userMessageId: 'pi-user-3' },
      { id: 'stopped', role: 'user', content: 'Interrupted continuation', timestamp: Date.now() },
    ]);
    expect(interruptedBranches.userMessageIds).toMatchObject({ stopped: 'pi-user-4' });
    const interruptedState = { ...session.getSnapshot().providerState };
    await session.dispose();
    const interruptedHistory = await new PiConversationHistoryService().hydrateConversationHistory({
      sessionId: 'pi-source', providerState: interruptedState, messages: [],
    }, root);
    expect(interruptedHistory.messages?.map(message => message.content)).toContain('Interrupted continuation');
    session = createSession(interruptedState);
    if (!isBranchableExecutionSession(session)) throw new Error('Missing tree capability');
    await session.navigateConversationBranch({ userMessageId: 'pi-user-1', branchMessageId: 'pi-user-2', configuration });
    const incompleteA = await session.navigateConversationBranch({ userMessageId: 'pi-user-2', branchMessageId: 'pi-user-1', configuration });
    expect((incompleteA.status === 'committed' ? incompleteA.messages : []).map(message => message.content)).toEqual(['A', 'Reply 1', 'Continue A', 'Reply 3', 'Interrupted continuation']);
    await send('After interruption');
    const finalContext = JSON.parse((await fs.readFile(path.join(root, 'contexts.jsonl'), 'utf8')).trim().split('\n').at(-1)!);
    expect(finalContext.ids).toEqual(['pi-user-1', 'pi-assistant-1', 'pi-user-3', 'pi-assistant-3', 'pi-user-4']);
    // A legacy native branch may have no saved metadata cursor or assistant entry.
    await fs.appendFile(sessionFile, JSON.stringify({ type: 'message', id: 'legacy-user', parentId: null,
      message: { role: 'user', content: 'Legacy interrupted branch' } }) + '\n');
    await kernel.request('fixture_tree_cancel', { cancel: true });
    expect(await session.navigateConversationBranch({ userMessageId: 'pi-user-1', branchMessageId: 'legacy-user', configuration })).toMatchObject({ status: 'cancelled' });
    const legacy = await session.navigateConversationBranch({ userMessageId: 'pi-user-1', branchMessageId: 'legacy-user', configuration });
    expect((legacy.status === 'committed' ? legacy.messages : []).map(message => message.content)).toEqual(['Legacy interrupted branch']);
    await send('Continue legacy');
    const legacyContext = JSON.parse((await fs.readFile(path.join(root, 'contexts.jsonl'), 'utf8')).trim().split('\n').at(-1)!);
    expect(legacyContext.ids).toEqual(['legacy-user']);
    for (const outcome of ['error', 'steer', 'queued-steer'] as const) {
      await kernel.request('fixture_hold_next');
      const ordinal = (await fs.readFile(path.join(root, 'contexts.jsonl'), 'utf8')).trim().split('\n').length + 1;
      const pending = session.execute({ configuration, toolPolicy: { kind: 'provider-default' },
        input: [{ type: 'text', text: 'Original ' + outcome }], signal: new AbortController().signal });
      let triggered = false;
      for await (const event of pending.events) {
        if (event.type !== 'text_delta' || triggered) continue;
        triggered = true;
        if (outcome === 'error') await kernel.request('fixture_fail');
        else {
          if (!isSteerableExecutionSession(session)) throw new Error('Missing steer capability');
          if (outcome === 'queued-steer') await kernel.request('fixture_queue_steer');
          await session.steer({ configuration, toolPolicy: { kind: 'provider-default' },
            input: [{ type: 'text', text: outcome === 'queued-steer' ? 'Queued input' : 'Steered input' }], signal: new AbortController().signal });
          if (outcome === 'queued-steer') pending.cancel();
        }
      }
      const savedHistory = await new PiConversationHistoryService().hydrateConversationHistory({
        sessionId: 'pi-source', providerState: session.getSnapshot().providerState, messages: [],
      }, root);
      const liveUsers = savedHistory.messages!.filter(message => message.role === 'user');
      for (const message of liveUsers) {
        if (message.content === 'Original ' + outcome || (outcome === 'steer' && message.content === 'Steered input')) {
          message.id = 'local-' + message.content;
          delete message.userMessageId;
          message.executionInput = { schemaVersion: 1, canonicalText: message.content };
        }
      }
      if (outcome === 'queued-steer') liveUsers.push({ id: 'queued', role: 'user', content: 'Queued input', timestamp: Date.now() });
      const recovered = await session.getConversationBranches(liveUsers);
      expect(recovered.userMessageIds.queued).toBeUndefined();
      expect(recovered.userMessageIds['local-Original ' + outcome]).toBe(`pi-user-${ordinal}`);
      expect(recovered.userMessageIds['local-Steered input']).toBe(outcome === 'steer' ? `pi-user-${ordinal + 1}` : undefined);
    }
  } finally { await session.dispose(); await fs.rm(root, { recursive: true, force: true }); }
});
