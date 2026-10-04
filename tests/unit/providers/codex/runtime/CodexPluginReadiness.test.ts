import { createNativeRPCProcess } from '@test/helpers/providers/NativeRPCTestProcess';
import { testDate } from '@test/helpers/testClock';
import spawn from 'cross-spawn';

import { CodexAppServerProcess } from '@/providers/codex/runtime/CodexAppServerProcess';
import { waitForCodexPluginReadiness } from '@/providers/codex/runtime/CodexPluginReadiness';
import { CodexRPCTransport } from '@/providers/codex/runtime/CodexRPCTransport';

jest.mock('cross-spawn', () => jest.fn());

const PLUGIN_ID = 'probe@openai-curated-remote';
const INSTALLED = { marketplaces: [{ plugins: [{
  id: PLUGIN_ID, installed: true, enabled: true, interface: { capabilities: ['skills'] },
}] }] };
const catalog = (loaded: boolean) => ({ data: [{ cwd: '/vault', errors: [], skills: loaded ? [{
  name: 'probe:skill', pluginId: PLUGIN_ID, path: '/fixture/SKILL.md', enabled: true, scope: 'user',
}] : [] }] });

describe('Codex plugin readiness over JSON-RPC', () => {
  let proc: CodexAppServerProcess;
  let transport: CodexRPCTransport;
  let controller: AbortController;

  beforeEach(() => {
    jest.useFakeTimers({ now: testDate().getTime() });
    controller = new AbortController();
  });
  afterEach(async () => {
    controller.abort();
    transport?.dispose();
    await proc?.shutdown();
    jest.useRealTimers();
    jest.mocked(spawn).mockReset();
  });

  function start(handle: Parameters<typeof createNativeRPCProcess>[0]) {
    jest.mocked(spawn).mockImplementation(() => createNativeRPCProcess(handle));
    proc = new CodexAppServerProcess({ command: 'codex', args: [], spawnCwd: '/vault', env: {} });
    proc.start();
    transport = new CodexRPCTransport(proc);
    transport.start();
    controller.signal.addEventListener('abort', () => transport.dispose(), { once: true });
    return waitForCodexPluginReadiness(transport, '/vault', controller.signal);
  }

  it('waits for slow bundle loading even after the installed catalog and an unrelated change notification arrive', async () => {
    let loaded = false;
    const pending = start(async (method, _params, notify) => {
      if (method === 'plugin/installed') {
        await new Promise(resolve => setTimeout(resolve, 100));
        notify('skills/changed', {});
        setTimeout(() => { loaded = true; }, 600);
        return INSTALLED;
      }
      return catalog(loaded);
    });
    let finished = false;
    void pending.then(() => { finished = true; });
    await jest.advanceTimersByTimeAsync(699);
    expect(finished).toBe(false);
    await jest.advanceTimersByTimeAsync(101);
    await pending;
    expect(loaded).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    { marketplaces: [] },
    { marketplaces: [{ plugins: [{ ...INSTALLED.marketplaces[0].plugins[0], enabled: false }] }] },
    { marketplaces: [{ plugins: [{ ...INSTALLED.marketplaces[0].plugins[0], interface: { capabilities: ['apps'] } }] }] },
  ])('does not wait for nonexistent skill roots: %j', async installed => {
    const methods: string[] = [];
    await start(method => {
      methods.push(method);
      return installed;
    });
    expect(methods).toEqual(['plugin/installed']);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('does not accept plugin skills from another working directory', async () => {
    let loaded = false;
    const pending = start(method => {
      if (method === 'plugin/installed') {
        setTimeout(() => { loaded = true; }, 100);
        return INSTALLED;
      }
      return { data: [catalog(loaded).data[0], { ...catalog(true).data[0], cwd: '/other' }] };
    });
    let finished = false;
    void pending.then(() => { finished = true; });
    await jest.advanceTimersByTimeAsync(99);
    expect(finished).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(loaded).toBe(true);
  });

  it.each(['plugin/installed', 'skills/list'])('continues when the optional %s probe fails', async failure => {
    await start(method => {
      if (method === failure) throw new Error('Unsupported method or unavailable catalog');
      return INSTALLED;
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('bounds a server that never answers plugin discovery', async () => {
    const pending = start(() => new Promise(() => undefined));
    await jest.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(jest.getTimerCount()).toBe(0);
  });

  it('shares one deadline across discovery and missing skill roots', async () => {
    const pending = start(async method => {
      if (method === 'plugin/installed') {
        await new Promise(resolve => setTimeout(resolve, 20_000));
        return INSTALLED;
      }
      return catalog(false);
    });
    let finished = false;
    void pending.then(() => { finished = true; });
    await jest.advanceTimersByTimeAsync(29_999);
    expect(finished).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['request', 'retry'])('cancels during a pending %s without leaving timers', async phase => {
    const pending = start(method => {
      if (method === 'plugin/installed') return phase === 'request' ? new Promise(() => undefined) : INSTALLED;
      return catalog(false);
    });
    const rejected = pending.catch(error => error);
    await jest.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await rejected).toEqual(controller.signal.reason);
    expect(jest.getTimerCount()).toBe(0);
    expect(proc.isAlive()).toBe(true); // Process lifetime remains the caller's responsibility.
  });
});
