import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { GrokNativeProcess } from '@test/helpers/providers/grok/GrokNativeProcess';
import spawn from 'cross-spawn';

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { GrokCommandMetadataProbe } from '@/providers/grok/app/GrokCommandMetadataProbe';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

let host: ProviderHost;
let native: GrokNativeProcess;
let probe: GrokCommandMetadataProbe;
let loader: GrokCommandLoader;
beforeEach(async () => {
  ({ host } = await createProviderHostFixture());
  native = new GrokNativeProcess();
  vi.mocked(spawn).mockReturnValue(native.child);
  probe = new GrokCommandMetadataProbe(host.getRuntimeHost('grok'));
  loader = new GrokCommandLoader(probe);
});
afterEach(async () => { await probe.dispose(); vi.clearAllMocks(); });

import type { ProviderCommandLoaderContext } from '@/core/providers/types';
import { GrokCommandLoader } from '@/providers/grok/app/GrokCommandLoader';

function createContext(
  overrides: Partial<ProviderCommandLoaderContext> = {},
): ProviderCommandLoaderContext {
  return {
    allowIsolatedMetadataCreation: false,
    conversation: null,
    plugin: host,
    ...overrides,
  };
}

describe('GrokCommandLoader', () => {
  it('uses a ready command snapshot without starting metadata discovery', async () => {

    await expect(loader.loadCommands(createContext({
      readyCommandSnapshot: [{
        content: '',
        id: 'grok:test',
        kind: 'command',
        name: 'test',
        source: 'sdk',
      }],
    }))).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'test' })],
      status: 'ready',
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(native.commandRequests).toHaveLength(0);
  });

  it('does not create isolated metadata unless explicitly allowed', async () => {

    await expect(loader.loadCommands(createContext())).resolves.toMatchObject({
      status: 'requires-session',
    });
    expect(spawn).not.toHaveBeenCalled();
    expect(native.commandRequests).toHaveLength(0);
  });

  it('loads commands through the provider-owned metadata probe', async () => {
    native.commandsImplementation = () => ({ commands: [{ name: 'skill', description: '', _meta: { path: '/skills/test/SKILL.md' } }] });

    await expect(loader.loadCommands(createContext({
      allowIsolatedMetadataCreation: true,
    }))).resolves.toMatchObject({
      items: [expect.objectContaining({ name: 'skill' })],
      status: 'ready',
    });
    expect(native.commandRequests).toHaveLength(1);
  });

  it('preserves caller cancellation during native command discovery', async () => {
    const controller = new AbortController();
    const failure = new Error('caller cancelled');
    native.commandsImplementation = () => { controller.abort(failure); return { commands: [] }; };

    await expect(loader.loadCommands(createContext({
      allowIsolatedMetadataCreation: true,
      signal: controller.signal,
    }))).rejects.toBe(failure);
  });

  it('maps native discovery failures to the Grok retryable error', async () => {
    native.commandsImplementation = () => { throw new Error('native failure'); };

    await expect(loader.loadCommands(createContext({
      allowIsolatedMetadataCreation: true,
    }))).resolves.toEqual({
      message: 'Could not load Grok Build skills and commands.',
      retryable: true,
      status: 'error',
    });
  });
});
