import '@/providers';

import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DesktopVault } from '@test/helpers/core/DesktopVault';
import { DEFAULT_CLAUDIAN_SETTINGS } from '@test/helpers/defaultSettings';
import { createObsidianPlugin } from '@test/helpers/ObsidianSettingsHost';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { testDate, testTime } from '@test/helpers/testClock';
import type { App} from 'obsidian';
import { Notice } from 'obsidian';

import { ConversationRepository } from '@/app/conversations/ConversationRepository';
import { SessionMetadataLoader } from '@/app/conversations/SessionMetadataLoader';
import { ConversationPersistenceStore } from '@/app/storage/ConversationPersistenceStore';
import { migrateSessionSidecars } from '@/app/storage/migrateSessionSidecars';
import { SharedStorageService } from '@/app/storage/SharedStorageService';
import { CLAUDIAN_SETTINGS_PATH, getDeviceSessionsPath, SESSIONS_PATH } from '@/core/bootstrap/storagePaths';
import { ProviderRegistry } from '@/core/providers/ProviderRegistry';
import { ProviderSettingsCoordinator } from '@/core/providers/ProviderSettingsCoordinator';
import type { VaultFileAdapter } from '@/core/storage/VaultFileAdapter';
import type { Conversation, SessionMetadata, SubagentInfo } from '@/core/types';
import { organizeSessionList } from '@/features/chat/session-manager/SessionListOrganizer';
import { ClaudeExecutionBackend } from '@/providers/claude/execution/ClaudeExecutionBackend';
import { encodeVaultPathForSDK } from '@/providers/claude/history/ClaudeHistoryPathResolver';

const DEVICE_KEY = `device-${'a'.repeat(64)}`;
const DEVICE_PATH = getDeviceSessionsPath(DEVICE_KEY);
const metadata: SessionMetadata = {
  id: 'conversation-1', providerId: 'claude', title: 'Example', createdAt: 1, lastActivityAt: 2,
};

let root: string;
let app: App;
let adapter: VaultFileAdapter;
let store: ConversationPersistenceStore;

let vault: DesktopVault;
beforeEach(async () => {
  vault = await DesktopVault.create();
  root = vault.root;
  app = vault.app;
  adapter = vault.files;
  store = new ConversationPersistenceStore(adapter, DEVICE_KEY);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await vault.dispose();
});

test('does not create storage directories during read-only initialization', async () => {
  const mkdir = vi.spyOn(app.vault.adapter, 'mkdir');
  const write = vi.spyOn(app.vault.adapter, 'write');
  await new SharedStorageService(createObsidianPlugin(app), DEFAULT_CLAUDIAN_SETTINGS).initialize();
  expect(mkdir).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(await vault.snapshot()).toEqual(new Map());
});

test('writes compact metadata without changing its contents', async () => {
  const data = { ...metadata, providerState: { futureField: { values: ['one', 'two'], multiline: 'line one\nline two' } } };
  await store.saveMetadata(data);
  const content = await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`);
  expect(content).toBe(JSON.stringify(data));
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(data);
});

test('isolates device metadata and preserves unscoped authority across read-only scans', async () => {
  const betaKey = `device-${'b'.repeat(64)}`;
  const beta = new ConversationPersistenceStore(adapter, betaKey);
  const current = { ...metadata, id: 'duplicate', linkedContentPath: 'Notes/current.md' };
  const legacy = { ...current, title: 'Unscoped duplicate' };
  const shared = { ...metadata, id: 'shared' };
  const betaOnly = { ...metadata, id: 'beta-only' };
  await store.saveMetadata(current);
  await store.saveMetadata(legacy, 'unscoped');
  await store.saveMetadata(shared, 'unscoped');
  await beta.saveMetadata(betaOnly);

  const files = [
    [`${DEVICE_PATH}/duplicate.meta.json`, current],
    [`${SESSIONS_PATH}/duplicate.meta.json`, legacy],
    [`${SESSIONS_PATH}/shared.meta.json`, shared],
    [`${getDeviceSessionsPath(betaKey)}/beta-only.meta.json`, betaOnly],
  ] as const;
  for (const [file, expected] of files) expect(await adapter.read(file)).toBe(JSON.stringify(expected));
  const writes = vi.spyOn(adapter, 'write');
  const deletes = vi.spyOn(adapter, 'delete');
  const renames = vi.spyOn(adapter, 'rename');

  expect(await store.metadataReader.load('duplicate')).toEqual({ metadata: current, source: 'device', needsMigration: false });
  expect(await store.metadataReader.load('shared')).toEqual({ metadata: shared, source: 'unscoped', needsMigration: false });
  expect(await store.metadataReader.loadMetadata('shared')).toEqual(shared);
  const scanned = await store.metadataReader.scan();
  expect(scanned.complete).toBe(true);
  expect(scanned.records).toEqual([
    { metadata: current, source: 'device', needsMigration: false },
    { metadata: shared, source: 'unscoped', needsMigration: false },
  ]);
  expect(await store.metadataReader.listMetadata()).toEqual([current, shared]);
  expect(await beta.metadataReader.listMetadata()).toEqual([betaOnly, legacy, shared]);
  expect(writes).not.toHaveBeenCalled();
  expect(deletes).not.toHaveBeenCalled();
  expect(renames).not.toHaveBeenCalled();
});

test.each([
  { name: 'legacy currentNote', stored: { currentNote: 'Notes\\Legacy.md' }, linkedContentPath: 'Notes/Legacy.md' },
  { name: 'canonical precedence', stored: { linkedContentPath: './Projects//Current', currentNote: 'Notes/Legacy.md' }, linkedContentPath: 'Projects/Current' },
  { name: 'invalid canonical path', stored: { linkedContentPath: '../escape', currentNote: 'Notes/Legacy.md' }, linkedContentPath: undefined },
])('decodes $name without rewriting the stored metadata', async ({ stored, linkedContentPath }) => {
  const file = `${DEVICE_PATH}/${metadata.id}.meta.json`;
  const original = JSON.stringify({ ...metadata, ...stored });
  await adapter.write(file, original);
  const writes = vi.spyOn(adapter, 'write');

  expect(await store.metadataReader.load(metadata.id)).toEqual({
    metadata: { ...metadata, ...(linkedContentPath ? { linkedContentPath } : {}) },
    needsMigration: true,
    source: 'device',
  });
  expect(writes).not.toHaveBeenCalled();
  expect(await adapter.read(file)).toBe(original);
});

test('refuses assignment over existing device metadata and retains both authorities', async () => {
  const device = { ...metadata, title: 'Device winner' };
  await store.saveMetadata(metadata, 'unscoped');
  await store.saveMetadata(device);
  const rename = vi.spyOn(adapter, 'rename');

  await expect(store.assignMetadataToDevice(metadata.id)).rejects.toThrow('device metadata already exists');

  expect(rename).not.toHaveBeenCalled();
  expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(device);
  expect(JSON.parse(await adapter.read(`${SESSIONS_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
});

test('execution snapshots avoid history payload serialization while persistence retains subagent history', async () => {
  const subagent = {
    id: 'task-1', description: 'Research', isExpanded: false, status: 'completed' as const,
    result: 'Complete result', toolCalls: [{ id: 'read-1', name: 'Read', input: { file_path: 'note.md' },
      status: 'completed' as const, isExpanded: false, result: 'Full tool output' }],
  };
  const subagentData = { [subagent.id]: subagent };
  const serializeHistory = vi.fn(() => ({ [subagent.id]: subagent }));
  Object.defineProperty(subagentData, 'toJSON', { value: serializeHistory });
  const providerState = { providerSessionId: 'native-1', subagentData, futureField: { cursor: 'keep' } };
  const conversation: Conversation = {
    ...metadata, providerId: 'claude', sessionId: 'native-1', providerState,
    messages: [{ id: 'message-1', role: 'assistant', content: '', timestamp: testDate().getTime(),
      toolCalls: [{ id: subagent.id, name: 'Agent', input: {}, status: 'completed', isExpanded: false, subagent }] }],
  };
  const { host } = await createProviderHostFixture({ app });
  const session = new ClaudeExecutionBackend(host.getRuntimeHost('claude')).createSession({
    lifecycle: 'persistent', nativePersistence: 'enabled', workingDirectory: root,
    resumeSeed: { providerSessionId: 'native-1', providerState },
    interactionPort: { dismissInteraction() {}, requestApproval: async ({ interactionId }) => ({ interactionId, decision: 'deny' }),
      askUserQuestion: async ({ interactionId }) => ({ interactionId, answers: null }) },
  });
  const repository = createRepository();
  repository.replaceAll([conversation]);
  repository.registerExecutionBinding(conversation.id, 'binding', 0);
  try {
    for (let index = 0; index < 20; index++) session.getSnapshot();
    expect(serializeHistory).not.toHaveBeenCalled();
    const snapshot = session.getSnapshot();
    expect(snapshot.providerState).toEqual({ providerSessionId: 'native-1', futureField: { cursor: 'keep' } });
    expect(snapshot.providerStateDeletes ?? []).not.toContain('subagentData');
    await repository.persistExecutionSnapshot(conversation.id, 'binding', 0, snapshot);
    expect((await store.metadataReader.loadMetadata(conversation.id))?.providerState).toEqual(providerState);
    expect(conversation.messages[0].toolCalls?.[0].subagent).toBe(subagent);
  } finally {
    await session.dispose();
  }
});

test.each([
  { kind: 'unloaded', format: 'anthropic' },
  { kind: 'model-recovery', format: 'anthropic' },
  { kind: 'unloaded', format: 'mcp' },
  { kind: 'model-recovery', format: 'mcp' },
])('strips $format image payloads when saving $kind metadata without loading native history', async ({ kind, format }) => {
  const now = testDate().getTime();
  const data = 'a'.repeat(512 * 1024);
  const image = (data: string) => format === 'mcp'
    ? { type: 'image', mimeType: 'image/png', data }
    : { type: 'image', source: { type: 'base64', media_type: 'image/png', data } };
  const result = JSON.stringify([
    { type: 'text', text: 'Archive scan' },
    image(data),
  ]);
  const subagent: SubagentInfo = {
    id: 'task-images', description: 'Read scans', isExpanded: true, mode: 'async',
    status: 'completed', result: 'Transcription complete', agentId: 'agent-images',
    toolCalls: [{ id: 'read-image', name: 'Read', input: { file_path: '/scan.png' }, status: 'completed', result }],
  };
  const state = {
    providerSessionId: 'native-images', previousProviderSessionIds: ['previous-native'],
    subagentData: { [subagent.id]: subagent }, futureField: { cursor: 'keep' },
  };
  const conversation: Conversation = {
    ...metadata, providerId: 'claude', createdAt: now, lastActivityAt: now, messages: [],
    sessionId: kind === 'unloaded' ? 'native-images' : null,
    ...(kind === 'unloaded'
      ? { providerState: state }
      : { modelRecoverySource: { sessionId: 'native-images', providerState: state, resumeAtMessageId: 'checkpoint' } }),
  };
  const nativePath = 'provider/session.jsonl';
  await adapter.write(nativePath, result);
  const repository = createRepository();
  repository.mergeMetadataConversations([conversation], 'unscoped');
  const before = repository.getSync(conversation.id);
  const history = ProviderRegistry.getConversationHistoryService('claude');
  const hydrate = vi.spyOn(history, 'hydrateConversationHistory');

  // Assignment persists an unloaded shell with its existing state intact.
  await repository.assignToCurrentDevice(conversation.id);

  const serialized = await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`);
  const saved = JSON.parse(serialized) as SessionMetadata;
  const savedState = kind === 'unloaded' ? saved.providerState : saved.modelRecoverySource?.providerState;
  expect(serialized.includes(data)).toBe(false);
  expect(savedState).toEqual({
    ...state,
    subagentData: { [subagent.id]: { ...subagent, toolCalls: [{
      ...subagent.toolCalls[0],
      result: JSON.stringify([
        { type: 'text', text: 'Archive scan' },
        image(''),
      ]),
    }] } },
  });
  expect(saved.sessionId).toBe(conversation.sessionId);
  expect(saved.providerState).toEqual(kind === 'unloaded' ? savedState : undefined);
  expect(saved.modelRecoverySource?.sessionId).toBe(kind === 'model-recovery' ? 'native-images' : undefined);
  expect(saved.modelRecoverySource?.resumeAtMessageId).toBe(kind === 'model-recovery' ? 'checkpoint' : undefined);
  expect(repository.getSync(conversation.id)).toEqual(before);
  expect(hydrate).not.toHaveBeenCalled();
  expect(await adapter.read(nativePath)).toBe(result);
});

test('persists only subagent state that native history cannot rebuild and restores the rest on reopen', async () => {
  const now = testDate().getTime();
  const claudeHome = path.join(root, 'claude-home');
  const projectPath = path.join(claudeHome, 'projects', encodeVaultPathForSDK(root));
  const sidecarDirectory = path.join(projectPath, 'native-1', 'subagents');
  await fs.mkdir(sidecarDirectory, { recursive: true });
  const jsonl = (rows: object[]) => rows.map(row => JSON.stringify(row)).join('\n');
  const writeSidecar = (agentId: string, rows: object[]) => fs.writeFile(
    path.join(sidecarDirectory, `agent-${agentId}.jsonl`),
    jsonl(rows.map(row => ({ isSidechain: true, timestamp: testTime({ seconds: 2 }), ...row }))),
  );
  const toolUse = (id: string, name: string, input: object) => ({
    type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
  const toolResult = (id: string, content: string, toolUseResult?: object) => ({
    type: 'user', ...(toolUseResult ? { toolUseResult } : {}),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
  const editInput = { file_path: '/notes/a.md', old_string: 'old', new_string: 'new' };
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }];
  const grepInput = { pattern: 'todo' };
  const readInput = { file_path: '/notes/b.md' };
  await writeSidecar('agent-sync', [
    toolUse('edit-1', 'Edit', editInput),
    toolResult('edit-1', 'Edited', { filePath: '/notes/a.md', oldString: 'old', newString: 'new', structuredPatch: patch }),
    // A later SendMessage continuation appends another run to the same sidecar.
    { type: 'user', timestamp: testTime({ seconds: 10 }), message: { role: 'user', content: 'Follow up' } },
    { ...toolUse('later-1', 'Bash', { command: 'ls' }), timestamp: testTime({ seconds: 11 }) },
    { ...toolResult('later-1', 'a.md'), timestamp: testTime({ seconds: 12 }) },
  ]);
  await writeSidecar('agent-legacy', [toolUse('grep-1', 'Grep', grepInput), toolResult('grep-1', 'a.md')]);
  await writeSidecar('agent-old', [toolUse('glob-1', 'Glob', { pattern: '*.md' }), toolResult('glob-1', 'a.md')]);
  await writeSidecar('agent-fail', [toolUse('read-fail', 'Read', readInput)]);
  await writeSidecar('agent-running', [toolUse('read-running', 'Read', readInput)]);
  await writeSidecar('agent-summary', [
    toolUse('read-summary', 'Read', readInput), toolResult('read-summary', 'b text'),
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Full report' }] } },
  ]);
  await writeSidecar('agent-bg', [
    toolUse('read-bg', 'Read', readInput), toolResult('read-bg', 'b text'),
    { type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Background report' }] } },
  ]);
  const task = (id: string, input: object = {}) => ({
    type: 'tool_use', id, name: 'Agent', input: { description: `${id} description`, prompt: `${id} prompt`, ...input },
  });
  const taskResult = (id: string, content: string, toolUseResult: object) => ({
    type: 'user', uuid: `${id}-result`, timestamp: testTime({ seconds: 4 }), toolUseResult,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });
  const completed = (id: string, agentId: string) => taskResult(id, `${id} done`, {
    status: 'completed', agentId, content: [{ type: 'text', text: `${id} done` }],
  });
  const rows = [
    { type: 'user', uuid: 'prompt', timestamp: testTime({ seconds: 0 }), message: { role: 'user', content: 'Delegate' } },
    { type: 'assistant', uuid: 'launch', timestamp: testTime({ seconds: 1 }), message: { role: 'assistant', stop_reason: 'tool_use',
      content: [task('task-sync'), task('task-local'), task('task-legacy'), task('task-bg', { run_in_background: true }),
        task('task-old'), task('task-fail', { run_in_background: true }), task('task-running'),
        task('task-summary', { run_in_background: true })] } },
    completed('task-sync', 'agent-sync'),
    completed('task-local', 'agent-local'),
    completed('task-legacy', 'agent-legacy'),
    // The completion notice never reached the transcript; Claudian observed it live.
    taskResult('task-bg', 'Async agent launched', { status: 'async_launched', isAsync: true, agentId: 'agent-bg' }),
    // Older results identify the agent only in the hand-back text.
    taskResult('task-old', '[Subagent hand-back] The text below is the final report of a subagent. The report follows:\n'
      + '  task-old done\nagentId: agent-old (use SendMessage to continue)\n<usage>total_tokens: 1</usage>', {}),
    taskResult('task-fail', 'Async agent launched', { status: 'async_launched', isAsync: true, agentId: 'agent-fail' }),
    taskResult('task-summary', 'Async agent launched', { status: 'async_launched', isAsync: true, agentId: 'agent-summary' }),
    // The completion notice carries only a summary; the report lives in the sidecar.
    { type: 'queue-operation', operation: 'enqueue', timestamp: testTime({ seconds: 5 }), content:
      '<task-notification><task-id>agent-summary</task-id><status>completed</status><summary>Agent finished</summary></task-notification>' },
  ];
  await fs.writeFile(path.join(projectPath, 'native-1.jsonl'), jsonl(rows.map((row, index) => ({
    ...row, sessionId: 'native-1', parentUuid: rows[index - 1]?.uuid ?? null,
  }))));
  const previousHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;

  const liveSubagent = (
    id: string, agentId: string | undefined, toolCall: SubagentInfo['toolCalls'][number], fields: Partial<SubagentInfo> = {},
  ): SubagentInfo => ({
    id, description: `${id} description`, prompt: `${id} prompt`, mode: 'sync', status: 'completed', result: `${id} done`,
    ...(agentId ? { agentId } : {}), isExpanded: false, toolCalls: [toolCall], ...fields,
  });
  const synced = liveSubagent('task-sync', 'agent-sync', {
    id: 'edit-1', name: 'Edit', input: editInput, status: 'completed', result: 'Edited',
    diffData: { filePath: '/notes/a.md', diffLines: [], stats: { added: 1, removed: 1 } },
  });
  // No native sidecar holds this subagent's calls, so metadata remains their only copy.
  const unsynced = liveSubagent('task-local', 'agent-local', {
    id: 'read-1', name: 'Read', input: { file_path: '/notes/a.md' }, status: 'completed', result: 'note text',
  });
  // Saved before sync subagents recorded their native identity; the transcript still has it.
  const legacy = liveSubagent('task-legacy', undefined, {
    id: 'grep-1', name: 'Grep', input: grepInput, status: 'completed', result: 'a.md',
  });
  const background = liveSubagent('task-bg', 'agent-bg', {
    id: 'read-bg', name: 'Read', input: readInput, status: 'completed', result: 'b text',
  }, { mode: 'async', asyncStatus: 'completed', result: 'Background report', startedAt: now, completedAt: now });
  const old = liveSubagent('task-old', 'agent-old', {
    id: 'glob-1', name: 'Glob', input: { pattern: '*.md' }, status: 'completed', result: 'a.md',
  });
  // The failure explanation came from a notification the transcript lacks; the sidecar has no final text.
  const failed = liveSubagent('task-fail', 'agent-fail', {
    id: 'read-fail', name: 'Read', input: readInput, status: 'running',
  }, { mode: 'async', status: 'error', asyncStatus: 'error', result: 'Agent failed: quota exceeded' });
  // The transcript has no result for a run still in flight, so nothing native can rebuild it yet.
  const running = liveSubagent('task-running', 'agent-running', {
    id: 'read-running', name: 'Read', input: readInput, status: 'running',
  }, { status: 'running', result: undefined });
  const summarized = liveSubagent('task-summary', 'agent-summary', {
    id: 'read-summary', name: 'Read', input: readInput, status: 'completed', result: 'b text',
  }, { mode: 'async', asyncStatus: 'completed', result: 'Full report' });
  const failedOverlay = {
    id: 'task-fail', mode: 'async', agentId: 'agent-fail', status: 'error', asyncStatus: 'error',
    result: 'Agent failed: quota exceeded',
  };
  const conversation: Conversation = {
    ...metadata, providerId: 'claude', createdAt: now, lastActivityAt: now, sessionId: 'native-1',
    providerState: { providerSessionId: 'native-1' }, messages: [],
  };
  const savedSubagents = async () => (await store.metadataReader.loadMetadata(conversation.id))
    ?.providerState?.subagentData as Record<string, unknown> | undefined;
  try {
    const repository = createRepository();
    repository.replaceAll([conversation]);
    await repository.update(conversation.id, { messages: [{
      id: 'launch', role: 'assistant', content: '', timestamp: now,
      toolCalls: [synced, unsynced, legacy, background, old, failed, running, summarized].map(subagent => ({
        id: subagent.id, name: 'Agent', input: { description: subagent.description, prompt: subagent.prompt },
        status: 'completed' as const, result: subagent.result, subagent,
      })),
    }] });

    expect(await savedSubagents()).toEqual({
      'task-local': unsynced,
      'task-legacy': legacy,
      'task-bg': { id: 'task-bg', mode: 'async', agentId: 'agent-bg', status: 'completed', asyncStatus: 'completed' },
      'task-fail': failedOverlay,
      'task-running': running,
      'task-summary': { id: 'task-summary', mode: 'async', agentId: 'agent-summary', status: 'completed', asyncStatus: 'completed' },
    });

    const reopened = createRepository();
    reopened.mergeMetadataConversations([{
      ...conversation, providerState: (await store.metadataReader.loadMetadata(conversation.id))?.providerState,
    }], 'device');
    const hydrated = await reopened.ensureHydrated(conversation.id);
    const restored = (id: string) => hydrated?.messages.flatMap(message => message.toolCalls ?? [])
      .find(toolCall => toolCall.id === id)?.subagent;
    expect(restored('task-sync')).toMatchObject({
      description: 'task-sync description', prompt: 'task-sync prompt', mode: 'sync', status: 'completed',
      result: 'task-sync done', agentId: 'agent-sync',
      toolCalls: [expect.objectContaining({
        id: 'edit-1', name: 'Edit', input: editInput, status: 'completed', result: 'Edited',
        diffData: expect.objectContaining({ stats: { added: 1, removed: 1 } }),
      })],
    });
    expect(restored('task-local')?.toolCalls).toEqual(unsynced.toolCalls);
    expect(restored('task-legacy')?.toolCalls).toEqual([expect.objectContaining({ id: 'grep-1', input: grepInput, result: 'a.md' })]);
    expect(restored('task-bg')).toMatchObject({
      description: 'task-bg description', prompt: 'task-bg prompt', mode: 'async', status: 'completed',
      asyncStatus: 'completed', result: 'Background report',
      toolCalls: [expect.objectContaining({ id: 'read-bg', input: readInput, result: 'b text' })],
    });

    expect(restored('task-old')).toMatchObject({ agentId: 'agent-old', result: 'task-old done',
      toolCalls: [expect.objectContaining({ id: 'glob-1', result: 'a.md' })] });
    expect(restored('task-fail')).toMatchObject({ status: 'error', result: 'Agent failed: quota exceeded' });
    expect(restored('task-summary')).toMatchObject({ status: 'completed', result: 'Full report' });

    // Reopening adopted the legacy record's native identity, so the next save drops it too.
    await reopened.rename(conversation.id, 'Renamed');
    expect(await savedSubagents()).toEqual({
      'task-local': unsynced,
      'task-bg': { id: 'task-bg', mode: 'async', agentId: 'agent-bg', status: 'completed', asyncStatus: 'completed' },
      'task-fail': failedOverlay,
      'task-running': running,
      'task-summary': { id: 'task-summary', mode: 'async', agentId: 'agent-summary', status: 'completed', asyncStatus: 'completed' },
    });

    // History rewound before every subagent leaves no stored copies to reattach.
    await reopened.update(conversation.id, { messages: [] });
    expect(await savedSubagents()).toBeUndefined();
  } finally {
    if (previousHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousHome;
  }
});

test('compacts stored subagent copies in the background after all metadata loads', async () => {
  const claudeHome = path.join(root, 'claude-home');
  const sessionDirectory = path.join(claudeHome, 'projects', encodeVaultPathForSDK(root), 'native-1');
  await fs.mkdir(path.join(sessionDirectory, 'subagents'), { recursive: true });
  await fs.writeFile(path.join(sessionDirectory, 'subagents', 'agent-agent-sync.jsonl'), '');
  // Claude Code indexes each sidecar by its spawning tool call beside the transcript.
  await fs.writeFile(path.join(sessionDirectory, 'subagents', 'agent-agent-legacy.jsonl'), '');
  await fs.writeFile(path.join(sessionDirectory, 'subagents', 'agent-agent-legacy.meta.json'),
    JSON.stringify({ toolUseId: 'task-agent-legacy' }));
  const subagent = (agentId: string, storesAgentId = true): SubagentInfo => ({
    id: `task-${agentId}`, description: 'Research', prompt: 'Look', mode: 'sync', status: 'completed',
    result: 'Done', ...(storesAgentId ? { agentId } : {}), isExpanded: false,
    toolCalls: [{ id: `read-${agentId}`, name: 'Read', input: { file_path: 'note.md' }, status: 'completed', result: 'text' }],
  });
  const stored = (id: string, subagents: SubagentInfo[]): SessionMetadata => ({
    ...metadata, id, sessionId: 'native-1',
    providerState: {
      providerSessionId: 'native-1',
      subagentData: Object.fromEntries(subagents.map(entry => [entry.id, entry])),
    },
  });
  // The first record's subagents have native sidecars; the legacy one predates stored agent ids.
  await store.saveMetadata(stored('redundant', [subagent('agent-sync'), subagent('agent-legacy', false)]));
  // A sync run without a result stays a sole copy even though its sidecar exists.
  await store.saveMetadata(stored('sole-copy', [
    subagent('agent-local'), subagent('agent-unindexed', false), { ...subagent('agent-sync'), status: 'running' },
  ]));
  const read = (id: string) => fs.readFile(path.join(root, DEVICE_PATH, `${id}.meta.json`), 'utf8');
  const soleCopy = await read('sole-copy');
  const previousHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  let atListPublication: string | undefined;
  const repository = createRepository();
  // Observe when the real background pass settles instead of polling files mid-write.
  const compact = repository.compactPersistedProviderState.bind(repository);
  const passSettled = new Promise<number>(resolve => {
    vi.spyOn(repository, 'compactPersistedProviderState').mockImplementation(async isStopped => {
      const count = await compact(isStopped);
      resolve(count);
      return count;
    });
  });
  const loader = new SessionMetadataLoader({
    sessions: store.metadataReader, conversations: repository,
    providerSettings: ProviderSettingsCoordinator,
    runtimeSettings: {
      getPendingProviderIds: () => [],
      getPendingGenerations: () => new Map(),
      completePendingSessionInvalidations: async () => undefined,
    } as never,
    isUnloading: () => false, whenLayoutReady: callback => callback(), onConversationListChanged: () => undefined,
    // Read synchronously: the background pass starts after this callback returns.
    onAllMetadataLoaded: () => { atListPublication = readFileSync(path.join(root, DEVICE_PATH, 'redundant.meta.json'), 'utf8'); },
  });
  try {
    loader.scheduleRemainingLoad();
    expect(await passSettled).toBe(1);
    const compacted = JSON.parse(await read('redundant')) as SessionMetadata;

    expect(atListPublication).toContain('read-agent-sync');
    expect(compacted).toMatchObject({ id: 'redundant', title: metadata.title, sessionId: 'native-1' });
    expect(compacted?.providerState).toEqual({ providerSessionId: 'native-1' });
    expect(await read('sole-copy')).toBe(soleCopy);
  } finally {
    await loader.dispose();
    if (previousHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousHome;
  }
});

test.each([
  { providerId: 'codex' as const, locator: { threadId: 'native', sessionFilePath: '/history/codex.jsonl' } },
  { providerId: 'grok' as const, locator: { sessionDirectory: '/history/grok', nativeConversationContextEstablished: true } },
  { providerId: 'pi' as const, locator: { sessionId: 'native', sessionFile: '/history/pi.jsonl', leafEntryId: 'leaf' } },
  { providerId: 'opencode' as const, locator: { sessionId: 'native', databasePath: '/history/opencode.db' } },
])('preserves $providerId native locators and opaque state in unloaded and recovery records', async ({ providerId, locator }) => {
  const state = { ...locator, futureField: { cursor: 'keep' } };
  const recoverySource = { sessionId: 'recovery-session', providerState: state, resumeAtMessageId: 'checkpoint' };
  const conversation: Conversation = {
    ...metadata, providerId, sessionId: null, messages: [], providerState: state,
    modelRecoverySource: recoverySource,
  };
  const repository = createRepository();
  repository.mergeMetadataConversations([conversation], 'unscoped');

  await repository.assignToCurrentDevice(conversation.id);

  const saved = await store.metadataReader.loadMetadata(conversation.id);
  expect(saved).toMatchObject({ sessionId: null, providerState: state, modelRecoverySource: recoverySource });
});

test('metadata scan and revalidation read unchanged payloads once through the storage adapter', async () => {
  for (let index = 0; index < 25; index++) {
    await store.saveMetadata({ ...metadata, id: `saved-${index}` });
  }
  const read = vi.spyOn(adapter, 'read');
  const scan = await store.metadataReader.scan();
  const records = await store.metadataReader.revalidate(scan.records);
  expect(records).toHaveLength(25);
  expect(scan.complete).toBe(true);
  expect(records.every(record => record.source === 'device')).toBe(true);
  expect(read).toHaveBeenCalledTimes(25);
});

test('preserves higher-priority metadata authority when its stat is unavailable', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  const scanned = await store.metadataReader.scan();
  await store.saveMetadata({ ...metadata, title: 'Device owner' });
  const stat = app.vault.adapter.stat.bind(app.vault.adapter);
  vi.spyOn(app.vault.adapter, 'stat').mockImplementation(async file => {
    if (file === `${DEVICE_PATH}/${metadata.id}.meta.json`) throw new Error('Stat temporarily unavailable');
    return stat(file);
  });
  const resolved = await store.metadataReader.revalidate(scanned.records);
  expect(resolved).toEqual([expect.objectContaining({ source: 'device', metadata: expect.objectContaining({ title: 'Device owner' }) })]);
});

test('assignment moves the metadata to its device and the shared folder contains only the device directory', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  await store.assignMetadataToDevice(metadata.id);

  expect(await fs.readdir(path.join(root, SESSIONS_PATH))).toEqual(['devices']);
  expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
});

function createRepository() {
  return new ConversationRepository({
    providers: ProviderRegistry,
    providerSettings: ProviderSettingsCoordinator,
    persistence: store, getSettings: () => ({}), getVaultPath: () => root,
    onConversationDeleted: async () => undefined,
  });
}

test('deleting a conversation removes its metadata while leaving provider history intact', async () => {
  const repository = createRepository();
  const conversation = await repository.create();
  const nativePath = 'provider/session.jsonl';
  await adapter.write(nativePath, 'native history');

  await repository.delete(conversation.id);

  expect(await adapter.listFiles(DEVICE_PATH)).toEqual([]);
  expect(await store.metadataReader.loadMetadata(conversation.id)).toBeNull();
  expect(await adapter.read(nativePath)).toBe('native history');
});

test('reopening uses provider messages as the authoritative history', async () => {
  const repository = createRepository();
  const conversation = { ...metadata, providerId: 'claude', sessionId: 'native-session', messages: [] };
  repository.replaceAll([conversation]);
  const nativeMessage = {
    id: 'native-message', userMessageId: 'native-user', role: 'user' as const,
    content: 'Provider text', displayContent: 'Provider text', timestamp: 2,
  };
  vi.spyOn(ProviderRegistry, 'getConversationHistoryService').mockReturnValue({
    hydrateConversationHistory: async () => ({ messages: [nativeMessage] }),
  } as unknown as ReturnType<typeof ProviderRegistry.getConversationHistoryService>);
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.inputs.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, records: [{
      schemaVersion: 1, id: 'old-input', state: 'accepted', userTurnOrdinal: 1,
      providerUserMessageId: 'native-user', timestamp: 2,
      rawDisplayText: 'Old overlay', canonicalText: 'Old overlay', images: [], contentDigest: 'a'.repeat(64),
    }],
  }));

  const reopened = await repository.ensureHydrated(metadata.id);

  expect(reopened?.messages[0]?.displayContent).toBe('Provider text');
});

test('migration completes old assignments and deletions before removing their sidecars', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, deviceKey: DEVICE_KEY,
  }));
  const removed = { ...metadata, id: 'removed' };
  await store.saveMetadata(removed);
  await adapter.write(`${DEVICE_PATH}/removed.deleted.json`, JSON.stringify({
    schemaVersion: 1, conversationId: removed.id, deletedAt: 3,
  }));
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.inputs.json`, '{}');

  const obsoleteInputs = await migrateSessionSidecars(adapter);
  expect(obsoleteInputs).toEqual([`${SESSIONS_PATH}/${metadata.id}.inputs.json`]);
  expect(await adapter.exists(obsoleteInputs[0])).toBe(true);
  for (const file of obsoleteInputs) await adapter.delete(file);
  expect(await migrateSessionSidecars(adapter)).toEqual([]);

  expect(await adapter.listFilesRecursive(SESSIONS_PATH)).toEqual([`${DEVICE_PATH}/${metadata.id}.meta.json`]);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
  expect(await store.metadataReader.loadMetadata(removed.id)).toBeNull();
});

test('migration retains assigned metadata and respects the scope of old deletion markers', async () => {
  const otherKey = `device-${'b'.repeat(64)}`;
  const otherPath = getDeviceSessionsPath(otherKey);
  await store.saveMetadata({ ...metadata, title: 'Stale shared copy' }, 'unscoped');
  await adapter.write(`${otherPath}/${metadata.id}.meta.json`, JSON.stringify(metadata));
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, deviceKey: otherKey,
  }));
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.deleted.json`, '{}');
  await adapter.write(`.claude/sessions/${metadata.id}.meta.json`, JSON.stringify(metadata));
  await store.saveMetadata({ ...metadata, id: 'device-deleted' });
  await store.saveMetadata({ ...metadata, id: 'device-deleted', title: 'Shared' }, 'unscoped');
  await adapter.write(`${DEVICE_PATH}/device-deleted.deleted.json`, '{}');

  await migrateSessionSidecars(adapter);

  const otherStore = new ConversationPersistenceStore(adapter, otherKey);
  expect(await otherStore.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toBeNull();
  expect(await store.metadataReader.loadMetadata('device-deleted')).toEqual({
    ...metadata, id: 'device-deleted', title: 'Shared',
  });
});

test('assignment recovery retains its valid source until the existing device target is readable', async () => {
  const source = `${SESSIONS_PATH}/${metadata.id}.meta.json`;
  const target = `${DEVICE_PATH}/${metadata.id}.meta.json`;
  const marker = `${SESSIONS_PATH}/${metadata.id}.assigned.json`;
  await store.saveMetadata(metadata, 'unscoped');
  await adapter.write(target, '{');
  await adapter.write(marker, JSON.stringify({ schemaVersion: 1, conversationId: metadata.id, deviceKey: DEVICE_KEY }));
  await adapter.write(CLAUDIAN_SETTINGS_PATH, JSON.stringify({ userName: 'Example' }));

  await new SharedStorageService(createObsidianPlugin(app), DEFAULT_CLAUDIAN_SETTINGS).initialize();

  expect(await adapter.read(source)).toBe(JSON.stringify(metadata));
  expect(await adapter.read(target)).toBe('{');
  expect(await adapter.exists(marker)).toBe(true);

  const repaired = { ...metadata, title: 'Repaired device record' };
  await adapter.write(target, JSON.stringify(repaired));
  await new SharedStorageService(createObsidianPlugin(app), DEFAULT_CLAUDIAN_SETTINGS).initialize();
  expect(await adapter.exists(source)).toBe(false);
  expect(await adapter.exists(marker)).toBe(false);
  expect(await store.metadataReader.load(metadata.id)).toMatchObject({ source: 'device', metadata: repaired });
});

test.each(['{', JSON.stringify({ schemaVersion: 1, conversationId: metadata.id, deviceKey: '../invalid' })])(
  'migration retains unassigned metadata when its obsolete assignment is invalid: %s', async (content) => {
    await store.saveMetadata(metadata, 'unscoped');
    await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, content);

    await migrateSessionSidecars(adapter);

    expect(await store.metadataReader.load(metadata.id)).toEqual({ metadata, source: 'unscoped', needsMigration: false });
    expect(await adapter.listFilesRecursive(SESSIONS_PATH)).toEqual([`${SESSIONS_PATH}/${metadata.id}.meta.json`]);
  },
);

test('a pending deletion rejects execution authority', async () => {
  const repository = createRepository();
  const conversation = await repository.create();
  repository.registerExecutionBinding(conversation.id, 'binding', 0);
  const deletion = repository.delete(conversation.id);
  const authority = repository.assertConversationExecutionAuthority(conversation.id, 'binding', 0);

  await expect(authority).rejects.toThrow('no longer available');
  await deletion;
  expect(await store.metadataReader.loadMetadata(conversation.id)).toBeNull();
});

test('a delayed scan cannot undo a local assignment or redirect later writes and deletion', async () => {
  const repository = createRepository();
  const conversation = { ...metadata, providerId: 'claude', sessionId: null, messages: [] };
  await store.saveMetadata(metadata, 'unscoped');
  const entry = { conversation, source: 'unscoped' as const, needsMigration: false };
  await repository.adoptMetadataConversations([entry]);
  const scanned = await store.metadataReader.load(metadata.id);

  await repository.assignToCurrentDevice(metadata.id);
  await repository.adoptMetadataConversations([{ ...entry, ...scanned!, conversation }]);
  await repository.rename(metadata.id, 'Assigned title');

  expect(await store.metadataReader.load(metadata.id)).toMatchObject({ source: 'device', metadata: { title: 'Assigned title' } });
  expect(await adapter.listFilesRecursive(SESSIONS_PATH)).toEqual([`${DEVICE_PATH}/${metadata.id}.meta.json`]);
  await repository.delete(metadata.id);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toBeNull();
});


test('migration continues when a listed assignment disappears before it is read', async () => {
  const assignmentPath = `${SESSIONS_PATH}/${metadata.id}.assigned.json`;
  await store.saveMetadata(metadata, 'unscoped');
  await adapter.write(assignmentPath, '{}');
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.inputs.json`, '{}');
  const read = app.vault.adapter.read.bind(app.vault.adapter);
  vi.spyOn(app.vault.adapter, 'read').mockImplementation(async (file) => {
    if (file === assignmentPath) await fs.unlink(path.join(root, file));
    return read(file);
  });

  await expect(migrateSessionSidecars(adapter)).resolves.toEqual([`${SESSIONS_PATH}/${metadata.id}.inputs.json`]);

  expect(await fs.readdir(path.join(root, SESSIONS_PATH))).toEqual([`${metadata.id}.inputs.json`, `${metadata.id}.meta.json`]);
  expect(await store.metadataReader.loadMetadata(metadata.id)).toEqual(metadata);
});

test('initialization loads settings while sidecar discovery is pending and waits for assignment recovery', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, deviceKey: DEVICE_KEY,
  }));
  await adapter.write(CLAUDIAN_SETTINGS_PATH, JSON.stringify({ userName: 'Example' }));
  const list = app.vault.adapter.list.bind(app.vault.adapter);
  let entered!: () => void;
  const listingStarted = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const listingGate = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(app.vault.adapter, 'list').mockImplementation(async folder => {
    entered();
    await listingGate;
    return list(folder);
  });
  const exists = vi.spyOn(app.vault.adapter, 'exists');
  const storage = new SharedStorageService(createObsidianPlugin(app), DEFAULT_CLAUDIAN_SETTINGS);
  let finished = false;
  const initializing = storage.initialize().then(result => { finished = true; return result; });
  try {
    await listingStarted;
    expect(exists).toHaveBeenCalledWith(CLAUDIAN_SETTINGS_PATH);
    expect(finished).toBe(false);
  } finally {
    release();
    await initializing;
  }
  expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
  expect(await adapter.exists(`${SESSIONS_PATH}/${metadata.id}.meta.json`)).toBe(false);
});

test('initialization joins recovery before reporting a settings failure', async () => {
  await store.saveMetadata(metadata, 'unscoped');
  await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
    schemaVersion: 1, conversationId: metadata.id, deviceKey: DEVICE_KEY,
  }));
  await adapter.write(CLAUDIAN_SETTINGS_PATH, '{}');
  const failure = new Error('Settings unavailable');
  const read = app.vault.adapter.read.bind(app.vault.adapter);
  vi.spyOn(app.vault.adapter, 'read').mockImplementation(file => {
    if (file === CLAUDIAN_SETTINGS_PATH) return Promise.reject(failure);
    return read(file);
  });
  const storage = new SharedStorageService(createObsidianPlugin(app), DEFAULT_CLAUDIAN_SETTINGS);
  await expect(storage.initialize()).rejects.toBe(failure);
  expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
  expect(await adapter.exists(`${SESSIONS_PATH}/${metadata.id}.assigned.json`)).toBe(false);
});

test.each(['list', 'read', 'rename'] as const)(
  'initialization loads settings after a cleanup %s failure and retries next time',
  async (operation) => {
    await store.saveMetadata(metadata, 'unscoped');
    await adapter.write(`${SESSIONS_PATH}/${metadata.id}.assigned.json`, JSON.stringify({
      schemaVersion: 1, conversationId: metadata.id, deviceKey: DEVICE_KEY,
    }));
    await adapter.write(CLAUDIAN_SETTINGS_PATH, JSON.stringify({ userName: 'Example' }));
    const storage = new SharedStorageService(createObsidianPlugin(app), DEFAULT_CLAUDIAN_SETTINGS);
    const original = app.vault.adapter[operation].bind(app.vault.adapter) as (...args: string[]) => ReturnType<App['vault']['adapter'][typeof operation]>;
    let failed = false;
    (vi.spyOn(app.vault.adapter, operation) as import('vitest').MockInstance<(...args: string[]) => ReturnType<App['vault']['adapter'][typeof operation]>>).mockImplementation((...args: string[]): ReturnType<App['vault']['adapter'][typeof operation]> => {
      if (!failed && args[0].startsWith(SESSIONS_PATH)) {
        failed = true;
        throw new Error('Storage unavailable');
      }
      return original(...args);
    });
    vi.mocked(Notice).mockClear();

    await expect(storage.initialize()).resolves.toMatchObject({ claudian: { userName: 'Example' } });
    expect(Notice).toHaveBeenCalledWith('Failed to clean up obsolete session files; will retry next launch');

    await storage.initialize();
    expect(await fs.readdir(path.join(root, SESSIONS_PATH))).toEqual(['devices']);
    expect(JSON.parse(await adapter.read(`${DEVICE_PATH}/${metadata.id}.meta.json`))).toEqual(metadata);
  },
);


test.each([null, 42, {}, [], undefined])('leaves a malformed title record untouched and keeps the session list usable (%o)', async title => {
  const invalid = { ...metadata, id: 'zz-bad-title', title };
  const invalidPath = `${DEVICE_PATH}/${invalid.id}.meta.json`;
  await store.saveMetadata(metadata);
  await adapter.write(invalidPath, JSON.stringify(invalid));
  const before = await adapter.read(invalidPath);
  const scan = await store.metadataReader.scanMetadata();
  const repository = createRepository();
  repository.mergeMetadataConversations(scan.metadata.map(record => ({
    ...record, providerId: record.providerId ?? 'claude', messages: [], sessionId: null,
  })));
  const sections = organizeSessionList(repository.list(), { organization: 'list', sort: 'last-updated', language: 'en' });
  expect(sections[0].conversations.map(record => record.id)).toEqual([metadata.id]);
  expect(scan).toMatchObject({ complete: true, invalidMetadataCount: 1 });
  expect(await adapter.read(invalidPath)).toBe(before);
});
