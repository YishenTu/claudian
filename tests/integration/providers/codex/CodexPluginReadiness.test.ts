import { createForkTestEnvironment, type ForkTestEnvironment } from '@test/helpers/features/chat/ProviderForkTestHarness';
import { createNativeRPCProcess } from '@test/helpers/providers/NativeRPCTestProcess';
import spawn from 'cross-spawn';

import { CodexExecutionBackend } from '@/providers/codex/execution/CodexExecutionBackend';
import { CodexSkillListingService } from '@/providers/codex/skills/CodexSkillListingService';

jest.mock('cross-spawn', () => jest.fn());

const PLUGIN_ID = 'startup-probe@openai-curated-remote';

function installServer(env: ForkTestEnvironment, holdCatalog = false) {
  const operations: string[] = [];
  const snapshots = new Map<string, boolean>();
  const processes: ReturnType<typeof createNativeRPCProcess>[] = [];
  let onCatalogRequested!: () => void;
  const catalogRequested = new Promise<void>(resolve => { onCatalogRequested = resolve; });
  let ordinal = 0;
  jest.mocked(spawn).mockImplementation(() => {
    let loaded = false;
    const native = createNativeRPCProcess(async (method, params, notify) => {
      operations.push(method);
      if (method === 'initialize') return {
        codexHome: env.root, platformFamily: 'unix', platformOs: 'macos', userAgent: 'test',
      };
      if (method === 'plugin/installed') {
        onCatalogRequested();
        if (holdCatalog) return new Promise(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 20));
        setTimeout(() => { loaded = true; }, 60);
        return { marketplaces: [{ plugins: [{
          id: PLUGIN_ID, installed: true, enabled: true, interface: { capabilities: ['skills'] },
        }] }] };
      }
      if (method === 'skills/list') return { data: [{ cwd: env.root, errors: [], skills: loaded ? [{
        name: 'startup-probe:startup-probe', description: 'Fixture skill',
        path: `${env.root}/plugins/cache/openai-curated-remote/startup-probe/1.0.0/skills/startup-probe/SKILL.md`,
        pluginId: PLUGIN_ID, enabled: true, scope: 'user',
      }] : [] }] };
      if (method === 'thread/start') {
        const id = `thread-${++ordinal}`;
        snapshots.set(id, loaded);
        return { thread: { id, path: null, turns: [] }, sandbox: { type: 'workspaceWrite' } };
      }
      if (method === 'turn/start') {
        const threadId = params.threadId as string;
        const id = `turn-${++ordinal}`;
        const text = snapshots.get(threadId) ? 'plugin-loaded' : 'plugin-missing';
        notify('turn/started', { threadId, turn: { id, items: [], status: 'inProgress' } });
        notify('item/started', { threadId, turnId: id, item: { id: 'msg', text: '', type: 'agentMessage' } });
        notify('item/agentMessage/delta', { threadId, turnId: id, itemId: 'msg', delta: text });
        notify('item/completed', { threadId, turnId: id, item: { id: 'msg', text, type: 'agentMessage' } });
        notify('turn/completed', { threadId, turn: { id, items: [], status: 'completed' } });
        return { turn: { id, items: [], status: 'inProgress' } };
      }
      throw new Error(`Unexpected method: ${method}`);
    });
    processes.push(native);
    return native;
  });
  return { operations, snapshots, processes, catalogRequested };
}

describe('Codex plugin startup through native RPC', () => {
  let env: ForkTestEnvironment;
  beforeEach(async () => { env = await createForkTestEnvironment(); });
  afterEach(async () => { await env.dispose(); jest.mocked(spawn).mockReset(); });

  it('loads plugins before the first thread snapshot and retains them on subsequent turns and sessions', async () => {
    const { operations, snapshots } = installServer(env);
    const backend = new CodexExecutionBackend(env.host);
    const chat = await env.open(backend);
    await env.send(chat, 'First');
    expect([...snapshots.values()]).toEqual([true]);
    await env.send(chat, 'Second');
    expect([...snapshots.values()]).toEqual([true]);
    expect(operations.filter(method => method === 'plugin/installed')).toHaveLength(1);
    const other = await env.open(backend);
    await env.send(other, 'New session');
    expect([...snapshots.values()]).toEqual([true, true]);
    expect(operations.filter(method => method === 'plugin/installed')).toHaveLength(2);
  });

  it('includes plugin skills in the first catalog result from each fresh process', async () => {
    installServer(env);
    const service = new CodexSkillListingService(env.host);
    try {
      for (const forceReload of [false, true]) {
        expect(await service.listSkills({ forceReload })).toEqual([
          expect.objectContaining({ name: 'startup-probe:startup-probe', pluginId: PLUGIN_ID }),
        ]);
      }
    } finally { await service.dispose(); }
  });

  it('cancels startup without creating a thread and closes the owned process', async () => {
    const { operations, processes, catalogRequested } = installServer(env, true);
    const chat = await env.open(new CodexExecutionBackend(env.host));
    const pending = env.send(chat, 'First', 'cancelled');
    await catalogRequested;
    chat.coordinator.cancel();
    await pending;
    expect(operations).not.toContain('thread/start');
    expect(processes.every(proc => proc.killed)).toBe(true);
  });

  it('aborts skill discovery and closes its process during plugin loading', async () => {
    const { processes, catalogRequested } = installServer(env, true);
    const controller = new AbortController();
    const service = new CodexSkillListingService(env.host);
    const pending = service.listSkills({ signal: controller.signal });
    const rejected = pending.catch(error => error);
    try {
      await catalogRequested;
      controller.abort();
      expect(await rejected).toEqual(controller.signal.reason);
      expect(processes.every(proc => proc.killed)).toBe(true);
    } finally { await service.dispose(); }
  });
});
