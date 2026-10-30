import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { seedFakeOpencodeSession } from '@test/helpers/providers/opencode/FakeOpencodeHistoryServer';
import { writeOpencodeNativePeer } from '@test/helpers/providers/opencode/OpencodeNativePeer';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import type { Conversation } from '@/core/types';
import { OpencodeConversationHistoryService } from '@/providers/opencode/history/OpencodeConversationHistoryService';
import { opencodeProviderRegistration } from '@/providers/opencode/registration';

it.each(['standalone', 'registered before workspace initialization'])('loads V2 history, recovers its model, and forks using %s history', async kind => {
  expect(ProviderWorkspaceRegistry.getServices('opencode')).toBeNull();
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'claudian-http-history-')));
  const cliPath = path.join(root, 'opencode.cjs');
  const databasePath = path.join(root, 'data', 'opencode', 'native.db');
  // A recorded database is opened only while it exists in a trusted data root.
  mkdirSync(path.dirname(databasePath), { recursive: true });
  writeFileSync(databasePath, '');
  writeOpencodeNativePeer(cliPath, { scenario: 'history', version: '2.0.12', expectedDatabase: databasePath, pageSize: 1, forkId: 'ses_child' });
  writeFileSync(databasePath, '{}');
  seedFakeOpencodeSession(databasePath, 'ses_worker', { messages: [
     { id: 'msg_worker_user', type: 'user', time: { created: 3 }, text: 'Inspect notes' },
     { id: 'msg_worker', type: 'assistant', time: { created: 4 }, content: [
       { type: 'tool', id: 'call_read', name: 'read', state: { status: 'completed', input: { filePath: '/vault/notes.md' }, content: [{ type: 'text', text: 'Notes body' }] } },
       { type: 'text', text: 'Worker summary' },
     ] },
     { id: 'msg_worker_user_again', type: 'user', time: { created: 6 }, text: 'Inspect more' },
     { id: 'msg_worker_again', type: 'assistant', time: { created: 7 }, content: [
       { type: 'tool', id: 'call_read_more', name: 'read', state: { status: 'completed', input: { filePath: '/vault/more.md' }, content: [{ type: 'text', text: 'More body' }] } },
       { type: 'text', text: 'Follow-up summary' },
     ] },
   ] });
  seedFakeOpencodeSession(databasePath, 'ses_background', { messages: [
     { id: 'msg_background_user', type: 'user', time: { created: 4 }, text: 'Survey vault' },
     { id: 'msg_background', type: 'assistant', time: { created: 5 }, content: [{ type: 'text', text: 'Background answer' }] },
     { id: 'msg_background_user_again', type: 'user', time: { created: 8 }, text: 'Survey again' },
     { id: 'msg_background_again', type: 'assistant', time: { created: 9 }, content: [
       { type: 'tool', id: 'call_read_b', name: 'read', state: { status: 'completed', input: { filePath: '/vault/b.md' }, content: [{ type: 'text', text: 'B body' }] } },
       { type: 'text', text: 'Second background answer' },
     ] },
   ] });
  seedFakeOpencodeSession(databasePath, 'ses_parent', { model: { providerID: 'deepseek', id: 'chat' }, messages: [...[{ id: 'msg_user', type: 'user', time: { created: 1 }, text: 'Native question' }], ...[{ id: 'msg_answer', type: 'assistant', time: { created: 2 }, content: [
       { type: 'tool', id: 'call_worker', name: 'subagent', state: { status: 'completed', input: { description: 'Inspect notes', prompt: 'Inspect notes', agent: 'worker' },
         metadata: { sessionID: 'ses_worker' }, content: [{ type: 'text', text: '<subagent sessionID="ses_worker" state="completed">Worker summary</subagent>' }] } },
       { type: 'tool', id: 'call_background', name: 'subagent', state: { status: 'completed', input: { description: 'Survey vault', prompt: 'Survey vault', background: true },
         content: [{ type: 'text', text: 'The subagent is working in the background (sessionID: ses_background)' }] } },
       // Follow-ups reuse each child session for a new, separate task.
       { type: 'tool', id: 'call_worker_again', name: 'subagent', state: { status: 'completed', input: { description: 'Inspect more', prompt: 'Inspect more', agent: 'worker' },
         metadata: { sessionID: 'ses_worker' }, content: [{ type: 'text', text: '<subagent sessionID="ses_worker" state="completed">Follow-up summary</subagent>' }] } },
       { type: 'tool', id: 'call_background_again', name: 'subagent', state: { status: 'completed', input: { description: 'Survey again', prompt: 'Survey again', background: true },
         content: [{ type: 'text', text: 'The subagent is working in the background (sessionID: ses_background)' }] } },
       { type: 'text', text: 'Native answer' },
     ] }]] });
  const history = kind === 'standalone' ? new OpencodeConversationHistoryService() : opencodeProviderRegistration.historyService!;
  const conversation = { id: 'local', sessionId: 'ses_parent', messages: [], providerState: { databasePath } } as unknown as Conversation;
  const settings = { providerConfigs: { opencode: { cliPath } } };
  const context = { config: settings.providerConfigs.opencode, environmentText: '', vaultPath: root, environment: { ...process.env, XDG_DATA_HOME: path.join(root, 'data'), OPENCODE_DB: path.join(root, 'untrusted.db') } };
  const { host } = await createProviderHostFixture({ settings, overrides: {
    getResolvedProviderCliPath: async () => cliPath,
  } });
  ProviderWorkspaceRegistry.register('opencode', opencodeProviderRegistration.workspace!);
  const historyContext = { ...context, ensureWorkspace: () => ProviderWorkspaceRegistry.ensureInitialized(host, 'opencode', 'history') };
  try {
    await expect(history.recoverConversationModelSelection!(conversation, root, historyContext)).resolves.toBe('opencode:deepseek/chat');
    Object.assign(conversation, await history.hydrateConversationHistory(conversation, root, historyContext));
    expect(conversation.messages.map(message => message.content)).toEqual(['Native question', 'Native answer']);
    // The child session's own tools are restored into the parent's subagent card.
    expect(conversation.messages[1].toolCalls?.[0].subagent).toMatchObject({
      id: 'call_worker', agentId: 'ses_worker', description: 'Inspect notes', mode: 'sync', status: 'completed', result: 'Worker summary',
      toolCalls: [{ id: 'call_read', name: 'Read', status: 'completed', result: 'Notes body' }],
    });
    // A background launch only acknowledges the child, so its answer comes from the child session.
    expect(conversation.messages[1].toolCalls?.[1].subagent).toMatchObject({
      id: 'call_background', agentId: 'ses_background', mode: 'async', asyncStatus: 'completed', result: 'Background answer', toolCalls: [],
    });
    // A reused child session holds one turn per task; each card keeps only its own turn.
    expect(conversation.messages[1].toolCalls?.[2].subagent).toMatchObject({
      id: 'call_worker_again', agentId: 'ses_worker', result: 'Follow-up summary',
      toolCalls: [{ id: 'call_read_more', result: 'More body' }],
    });
    expect(conversation.messages[1].toolCalls?.[3].subagent).toMatchObject({
      id: 'call_background_again', agentId: 'ses_background', mode: 'async', result: 'Second background answer',
      toolCalls: [{ id: 'call_read_b', result: 'B body' }],
    });
    await expect(history.buildForkProviderState('ses_parent', '', conversation.providerState, root, historyContext))
      .resolves.toMatchObject({ sessionId: 'ses_child', databasePath });
  } finally { await ProviderWorkspaceRegistry.disposeInitialized(); ProviderWorkspaceRegistry.clear(); rmSync(root, { recursive: true, force: true }); }
}, 15000);
