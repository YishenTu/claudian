// @test-ci {"native":true,"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { createForkTestEnvironment, type ForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';
import { writeOpencodeNativePeer } from '@test/helpers/providers/opencode/OpencodeNativePeer';
import { testDate } from '@test/helpers/testClock';

import { createProviderHistoryPathContext } from '@/core/providers/historyPathContext';
import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';

describe('OpenCode v2 checkpoint forks', () => {
  let env: ForkTestEnvironment;
  let server: OpencodeServerService;
  let history: OpencodeConversationHistoryService;
  let backend: OpencodeExecutionBackend;
  let databasePath: string;
  const nativeMessages = [
    { id: 'z-user', type: 'user', text: 'Remember apples' },
    { id: 'y-assistant', type: 'assistant', content: [{ type: 'text', text: 'Apples remembered' }] },
    { id: 'x-idle', type: 'idle' },
    { id: 'b-user', type: 'user', text: 'Remember pears' },
    { id: 'a-assistant', type: 'assistant', content: [{ type: 'text', text: 'Pears remembered' }] },
  ].map((message, index) => ({ ...message, time: { created: testDate({ seconds: index }).getTime() } }));
  const state = () => JSON.parse(readFileSync(databasePath, 'utf8'));
  const context = () => ({
    ...createProviderHistoryPathContext(env.host.settings, 'opencode', env.root),
    environment: { ...process.env, OPENCODE_DB: databasePath },
  });

  beforeEach(async () => {
    env = await createForkTestEnvironment();
    server = new OpencodeServerService();
    const services = { serverService: server, dispose: () => server.dispose() };
    ProviderWorkspaceRegistry.setServices('opencode', services);
    history = new OpencodeConversationHistoryService({ getServerService: async () => server });
    backend = new OpencodeExecutionBackend(env.host.getRuntimeHost('opencode'), { serverService: server });
    databasePath = path.join(env.root, 'native.db');
    const cliPath = path.join(env.root, 'opencode.cjs');
    writeOpencodeNativePeer(cliPath, { scenario: 'history', version: '2.0.18', historyFormat: 'checkpoint', pageSize: 2 });
    writeFileSync(databasePath, JSON.stringify({ sessions: { source: nativeMessages }, requests: [] }));
    env.host.settings.providerConfigs.opencode = { enabled: true, cliPath, environmentVariables: `OPENCODE_DB=${databasePath}` };
  });
  afterEach(async () => { ProviderWorkspaceRegistry.setServices('opencode', undefined); await server.dispose(); await env.dispose(); });

  async function openSource() {
    const conversation = await env.repository.create({ providerId: 'opencode' });
    await env.repository.update(conversation.id, { sessionId: 'source', providerState: { sessionId: 'source', databasePath } });
    const source = env.repository.getSync(conversation.id)!;
    const hydrated = await history.hydrateConversationHistory(source, env.root, context());
    await env.repository.update(source.id, hydrated);
    return env.open(backend, env.repository.getSync(source.id)!);
  }

  it.each([0, 1])('retains reply %i and excludes subsequent history, including after hydration and another fork', async turn => {
    const source = await openSource();
    const selected = source.conversation.messages[turn * 2 + 1];
    const child = await env.fork(source, selected, context());
    expect(child).toBeDefined();
    const restored = { ...child!, ...await history.hydrateConversationHistory(child!, env.root, context()) };
    const expected = turn === 0 ? ['Remember apples', 'Apples remembered'] : ['Remember apples', 'Apples remembered', 'Remember pears', 'Pears remembered'];
    expect(restored.messages.map(message => message.content)).toEqual(expected);
    expect(state().requests).toEqual([turn === 0 ? { before: 'x-idle' } : {}]);
    expect(state().sessions.source).toEqual(nativeMessages);
    await env.repository.update(restored.id, { messages: restored.messages });
    const nested = await env.fork(await env.open(backend, restored), restored.messages[1], context());
    expect(nested).toBeDefined();
    const nestedHistory = await history.hydrateConversationHistory(nested!, env.root, context());
    expect(nestedHistory.messages?.map(message => message.content)).toEqual(['Remember apples', 'Apples remembered']);
  }, 15000);

  it('rejects a missing checkpoint without creating a native child', async () => {
    await expect(history.buildForkProviderState('source', 'missing', { databasePath }, env.root, context()))
      .rejects.toThrow(/checkpoint/i);
    expect(state().requests).toEqual([]);
  });
});
