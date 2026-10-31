import { once } from 'node:events';

import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { PiNativeProcess } from '@test/helpers/providers/pi/PiNativeProcess';
import spawn from 'cross-spawn';

import { resolveCommandDiscoveryTimeoutMs } from '@/core/providers/commands/catalogCommandDiscovery';
import { ProviderCommandDiscoveryStore } from '@/core/providers/commands/ProviderCommandDiscoveryStore';
import { PiCommandLoader } from '@/providers/pi/app/PiCommandLoader';
import { PiCommandCatalog } from '@/providers/pi/commands/PiCommandCatalog';
import { PiCommandMetadataProbe } from '@/providers/pi/execution/PiCommandMetadataProbe';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

it('loads pushed commands through the loader after the provider-owned RPC deadline', async () => {
  vi.useFakeTimers();
  const native = new PiNativeProcess({}, new Map(), () => new Promise(() => undefined));
  const { stdin, stdout } = native.child;
  vi.mocked(spawn).mockReturnValue(native.child);
  const { host: plugin } = await createProviderHostFixture({
    overrides: { workingDirectory: '/vault', getResolvedProviderCliPath: async () => '/bin/pi' },
    settings: { providerConfigs: { pi: { enabled: true } } },
  });
  const probe = new PiCommandMetadataProbe(plugin.getRuntimeHost('pi'));
  const loader = new PiCommandLoader(probe);
  const store = new ProviderCommandDiscoveryStore(signal => loader.loadCommands({
    allowIsolatedMetadataCreation: true,
    conversation: null,
    plugin,
    signal,
  }), {
    resolveTimeoutMs: () => resolveCommandDiscoveryTimeoutMs(new PiCommandCatalog().getDropdownConfig()),
  });
  try {
    const requestWritten = once(stdin, 'data');
    const load = store.load();
    const [chunk] = await requestWritten;
    expect(JSON.parse(chunk.toString())).toEqual({ id: expect.any(String), type: 'get_commands' });
    expect(spawn).toHaveBeenCalledWith('/bin/pi', ['--mode', 'rpc', '--no-session'], expect.objectContaining({ cwd: '/vault' }));
    stdout.push(JSON.stringify({
      type: 'available_commands_update',
      commands: [
        { name: 'skill:project-probe', source: 'skill' },
        { description: 'Run tests', name: 'test', source: 'runtime' },
      ],
    }) + '\n');

    await vi.advanceTimersByTimeAsync(8_000);
    expect(store.getSnapshot()).toEqual({ status: 'loading' });
    expect(native.child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);

    const expected = {
      status: 'ready',
      items: [
        { content: '', description: undefined, id: 'pi:skill:skill:project-probe',
          kind: 'skill', name: 'skill:project-probe', source: 'sdk' },
        { content: '', description: 'Run tests', id: 'pi:runtime:test',
          kind: 'command', name: 'test', source: 'sdk' },
      ],
    };
    await expect(load).resolves.toEqual(expected);
    expect(store.getSnapshot()).toEqual(expected);
    expect(native.child.killed).toBe(true);
    expect(stdout.listenerCount('data')).toBe(0);
  } finally {
    store.dispose();
    await probe.dispose();
    stdin.destroy();
    stdout.destroy();
    vi.mocked(spawn).mockReset();
    vi.useRealTimers();
  }
});
