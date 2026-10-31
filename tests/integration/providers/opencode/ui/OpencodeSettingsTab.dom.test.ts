// @test-ci {"inputs":["tests/helpers/providers/opencode/OpencodeNativePeer.cjs"]}
/** @vitest-environment jsdom */
import '@/providers';

import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { axe } from '@test/helpers/accessibility';
import { controlChangeSettled } from '@test/helpers/ObsidianHost';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { mountProviderSettings } from '@test/helpers/ProviderSettingsHarness';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import spawn from 'cross-spawn';

import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ClaudianSettings } from '@/core/types';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';
import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { OpencodeCLIResolver } from '@/providers/opencode/runtime/OpencodeCLIResolver';
import { createOpencodeModels } from '@/providers/opencode/runtime/OpencodeModels';
import { getOpencodeProviderSettings, updateOpencodeProviderSettings } from '@/providers/opencode/settings';
import { createOpencodeSettingsTabRenderer } from '@/providers/opencode/ui/OpencodeSettingsTab';

import { createOpencodeHTTPMetadataFixture } from '../metadata/OpencodeHTTPMetadataFixture';

// The native peer runs through the real spawn; WSL cases route only wsl.exe to the shared fixture.
vi.mock('cross-spawn', async importOriginal => ({ default: vi.fn((await importOriginal<{ default: typeof spawn }>()).default) }));
const { default: nativeSpawn } = await vi.importActual<{ default: typeof spawn }>('cross-spawn');

const deviceKey = getInstallationKey();

async function setup(config: Record<string, unknown> = {}) {
  const fixture = createOpencodeHTTPMetadataFixture();
  const persist = vi.fn(async (_settings: ClaudianSettings) => undefined);
  const app = await fixture.createHostFixture({ config, beforePersist: persist });
  app.settings.providerConfigs.claude = { enabled: true };
  const { host, lifecycle: registry } = app;
  const runtimeHost = host.getRuntimeHost('opencode');
  const servers = new OpencodeServerService();
  const service = new OpencodeMetadataService(runtimeHost, registry, { serverService: servers });
  const catalog = createOpencodeModels(runtimeHost, service);
  // The renderer consumes only the resolver's reset port; record each reset with the settings it observed.
  const resets: Array<{ paths: Record<string, string>; transitioning: boolean }> = [];
  let transitioning = false;
  registry.registerTransitionHook('opencode', {
    beforeTransition: async () => { transitioning = true; },
    afterTransition: async () => { transitioning = false; },
  });
  const cliResolver = { reset: () => { resets.push({ paths: { ...getOpencodeProviderSettings(host.settings).cliPathsByHost }, transitioning }); } };
  const context = { plugin: host, notifyProviderModelOptionsChanged: vi.fn(), renderCustomContextLimits: vi.fn() };
  const container = document.body.createDiv();
  const view = createOpencodeSettingsTabRenderer({ cliResolver, metadataService: service, modelCatalog: catalog }).render(container, context);
  await catalog.refresh();
  persist.mockClear(); context.notifyProviderModelOptionsChanged.mockClear();
  return { fixture, host, registry, persist, resets, runtimeHost, servers, service, context, container, ui: within(container), async dispose() {
    view?.dispose(); await catalog.dispose(); await service.dispose(); await servers.dispose(); await app.dispose(); fixture.dispose(); container.remove();
  } };
}

function editCLI(ui: ReturnType<typeof within>, value: string): HTMLInputElement {
  fireEvent.click(ui.getByRole('button', { name: 'OpenCode installation' }));
  const input = ui.getByRole('textbox', { name: 'CLI path' }) as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter' });
  return input;
}

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

it.each([false, true])('restores automatic CLI detection without losing another computer override (host override: %s)', async hasHostOverride => {
  const f = await setup({ cliPath: '/legacy/opencode', cliPathsByHost: { 'other-host': '/keep/opencode', ...(hasHostOverride ? { [deviceKey]: '/host/opencode' } : {}) } });
  try {
    fireEvent.click(f.ui.getByRole('button', { name: 'OpenCode installation' }));
    const input = f.ui.getByRole('textbox', { name: 'CLI path' }) as HTMLInputElement;
    expect(input.value).toBe(hasHostOverride ? '/host/opencode' : '/legacy/opencode');
    fireEvent.input(input, { target: { value: '' } }); fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(f.resets).toHaveLength(1));
    expect(getOpencodeProviderSettings(f.host.settings).cliPath).toBe('');
    expect(getOpencodeProviderSettings(f.host.settings).cliPathsByHost).toEqual({ 'other-host': '/keep/opencode' });
    expect(f.registry.getProviderGeneration('opencode')).toBe(1);
  } finally { await f.dispose(); }
});

it('commits enablement through the real lifecycle and refreshes model options without starting discovery', async () => {
  const f = await setup({ enabled: false });
  const session = new OpencodeExecutionBackend(f.runtimeHost, { serverService: f.servers }).createSession({
    workingDirectory: f.fixture.root, lifecycle: 'persistent', nativePersistence: 'provider-default',
    interactionPort: { requestApproval: async r => ({ interactionId: r.interactionId, decision: 'deny' }), askUserQuestion: async r => ({ interactionId: r.interactionId, answers: null }), dismissInteraction() {} },
  });
  f.registry.acquire({ providerId: 'opencode', createSession: () => session }, {} as never, 'chat');
  vi.mocked(spawn).mockClear();
  try {
    fireEvent.click(f.ui.getByRole('switch', { name: 'Enable OpenCode' }));
    await waitFor(() => expect(f.context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('opencode'));
    // Bounds a missing signal: discovery would launch the native CLI (version probe, then server) within this window.
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(spawn).not.toHaveBeenCalled();
    expect(getOpencodeProviderSettings(f.host.settings).enabled).toBe(true);
    // The enablement transition ends the session it supersedes.
    expect(session.getStatus()).toBe('disposed');
    expect(f.registry.getProviderGeneration('opencode')).toBe(1);
    expect(existsSync(f.fixture.environment.ENDPOINT_FILE!)).toBe(false);
    expect((await axe(f.container)).violations).toEqual([]);
  } finally { await f.dispose(); }
});

it.each([false, true])('resynchronizes enablement to committed settings after transition failure (committed: %s)', async committed => {
  const f = await setup();
  if (committed) f.registry.registerTransitionHook('opencode', { afterTransition: async () => { throw new Error('publication failed'); } });
  else f.persist.mockRejectedValueOnce(new Error('storage failed'));
  try {
    const toggle = f.ui.getByRole('switch', { name: 'Enable OpenCode' }) as HTMLInputElement;
    fireEvent.click(toggle);
    await expect(controlChangeSettled(toggle)).rejects.toThrow(committed ? 'publication failed' : 'storage failed');
    expect(getOpencodeProviderSettings(f.host.settings).enabled).toBe(!committed);
    expect(toggle.checked).toBe(!committed);
    expect(f.context.notifyProviderModelOptionsChanged).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
});

it.each([false, true])('validates and commits a CLI path before resetting resolution within the transition (quoted: %s)', async quoted => {
  const f = await setup();
  // A space in the basename exercises quote normalization on every platform.
  const executable = path.join(f.fixture.root, 'my opencode');
  writeFileSync(executable, 'native executable boundary');
  const configured = quoted ? `"${executable}"` : executable;
  try {
    editCLI(f.ui, configured);
    await waitFor(() => expect(f.resets).toHaveLength(1));
    expect(f.persist).toHaveBeenCalled();
    expect(f.resets).toEqual([{ paths: { [deviceKey]: configured }, transitioning: true }]);
  } finally { await f.dispose(); }
});

it('renders native environment guidance without vault-managed skill or command editors', async () => {
  const f = await setup();
  try {
    const environment = f.ui.getByRole('textbox', { name: 'OpenCode environment variables' }) as HTMLTextAreaElement;
    expect(environment.placeholder).toBe('OPENCODE_DB=/path/to/opencode.db');
    expect(f.ui.getByText('Extra environment variables passed to OpenCode.')).toBeTruthy();
    expect(f.ui.queryByText(/^(Skills|Commands|Hidden Commands and Skills)$/)).toBeNull();
  } finally { await f.dispose(); }
});

describe('Windows installation method', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let wsl: WSLProcessFixture;
  let app: Awaited<ReturnType<typeof createProviderHostFixture>>;
  let persist: ReturnType<typeof vi.fn<(settings: ClaudianSettings) => Promise<void>>>;
  let publish: ReturnType<typeof vi.fn<() => void>>;
  let workspace: { servers: OpencodeServerService; service: OpencodeMetadataService; catalog: ReturnType<typeof createOpencodeModels> };
  beforeEach(async () => {
    persist = vi.fn(async () => undefined);
    publish = vi.fn();
    // A Windows vault; WSL maps it to the Linux cwd.
    app = await createProviderHostFixture({
      settings: { providerConfigs: { opencode: { enabled: true, visibleModels: [] } } },
      beforePersist: persist, afterPublish: () => publish(), overrides: { workingDirectory: 'C:\\vault' },
    });
    const servers = new OpencodeServerService();
    const service = new OpencodeMetadataService(app.host.getRuntimeHost('opencode'), app.lifecycle, { serverService: servers });
    workspace = { servers, service, catalog: createOpencodeModels(app.host.getRuntimeHost('opencode'), service) };
    wsl = new WSLProcessFixture();
    wsl.binaries.set('opencode', { path: '/home/me/.opencode/bin/opencode', version: 'opencode 2.2.3' });
    vi.mocked(spawn).mockImplementation((command, args, options) => {
      if (/(?:^|[\\/])wsl\.exe$/u.test(command)) return wsl.spawn(command, args, options);
      throw new Error('Native CLI unavailable in settings test');
    });
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  });
  afterEach(async () => {
    Object.defineProperty(process, 'platform', platform);
    vi.mocked(spawn).mockImplementation(nativeSpawn);
    await workspace.catalog.dispose(); await workspace.service.dispose(); await workspace.servers.dispose(); await app.dispose();
  });

  function render() {
    const renderer = createOpencodeSettingsTabRenderer({ cliResolver: new OpencodeCLIResolver(), metadataService: workspace.service, modelCatalog: workspace.catalog });
    const { ui } = mountProviderSettings(renderer, app.host);
    fireEvent.click(ui.getByRole('button', { name: 'OpenCode installation' }));
    return { ui, cli: ui.getByRole('textbox', { name: 'CLI path' }) as HTMLInputElement };
  }

  it.each([
    ['native-windows', 'wsl', 'rejected'], ['wsl', 'native-windows', 'rejected'],
    ['native-windows', 'wsl', 'accepted'], ['wsl', 'native-windows', 'accepted'],
    ['native-windows', 'wsl', 'committed-error'], ['wsl', 'native-windows', 'committed-error'],
  ] as const)('synchronizes %s → %s controls with settings after a %s save', async (initial, requested, outcome) => {
    // Seed through the runtime path so the session-store baseline matches the initial target.
    await app.host.applyProviderRuntimeSettings(['opencode'], settings => {
      updateOpencodeProviderSettings(settings, { installationMethod: initial, wslDistroOverride: 'Ubuntu' });
    });
    persist.mockClear();
    if (outcome === 'rejected') persist.mockRejectedValueOnce(new Error('Disk full'));
    if (outcome === 'committed-error') publish.mockImplementationOnce(() => { throw new Error('Runtime reset failed'); });
    const { ui, cli } = render();
    const method = ui.getByRole('combobox', { name: 'Installation method' }) as HTMLSelectElement;
    const distro = ui.getByRole('textbox', { name: 'WSL distro override' }) as HTMLInputElement;
    const card = cli.closest<HTMLElement>('.claudian-cli-installation')!;
    expect(method.value).toBe(initial);
    fireEvent.change(method, { target: { value: requested } });
    const failure = await controlChangeSettled(method).then(() => null, (error: unknown) => error);
    expect(failure instanceof Error ? failure.message : failure)
      .toBe({ accepted: null, rejected: 'Disk full', 'committed-error': 'Runtime reset failed' }[outcome]);
    // The method change is written once, with its session invalidation; the only other write completes that invalidation.
    expect(persist.mock.calls.map(([settings]) => [
      getOpencodeProviderSettings(settings).installationMethod, settings.pendingProviderSessionInvalidations.opencode !== undefined,
    ])).toEqual(outcome === 'rejected' ? [[requested, true]] : [[requested, true], [requested, false]]);
    const expected = outcome === 'rejected' ? initial : requested;
    expect(getOpencodeProviderSettings(app.settings).installationMethod).toBe(expected);
    expect(getOpencodeProviderSettings(await app.settingsStorage.load()).installationMethod).toBe(expected);
    expect(method.value).toBe(expected);
    expect(distro.disabled).toBe(expected !== 'wsl');
    expect(cli.placeholder).toBe(expected === 'wsl' ? 'opencode' : 'C:\\Users\\you\\AppData\\Roaming\\npm\\opencode.cmd');
    fireEvent.input(cli, { target: { value: '/missing/linux/opencode' } });
    await waitFor(() => expect(cli.getAttribute('aria-invalid')).toBe(String(expected !== 'wsl')));
    // Enter starts the save (disabling the field) only for a valid path; enabled again means it settled.
    fireEvent.keyDown(cli, { key: 'Enter' });
    await waitFor(() => expect(cli.disabled).toBe(false));
    // WSL accepts a Linux path that does not exist on the Windows host; native Windows rejects it before saving.
    const savedPath = expected === 'wsl' ? '/missing/linux/opencode' : undefined;
    expect(getOpencodeProviderSettings(app.settings).cliPathsByHost[deviceKey]).toBe(savedPath);
    expect(getOpencodeProviderSettings(await app.settingsStorage.load()).cliPathsByHost[deviceKey]).toBe(savedPath);
    expect((await axe(card)).violations).toEqual([]);
  });

  it('inspects the OpenCode CLI inside the selected distro', async () => {
    updateOpencodeProviderSettings(app.settings, { installationMethod: 'wsl', wslDistroOverride: 'Ubuntu' });
    const { cli } = render();
    const card = within(cli.closest<HTMLElement>('.claudian-cli-installation')!);
    await waitFor(() => expect(card.getByText('/home/me/.opencode/bin/opencode')).toBeTruthy());
    expect(card.getByText('v2.2.3')).toBeTruthy();
    // Model discovery also reads the Linux environment through WSL; only the installation probe is asserted here.
    const probes = wsl.requests.filter(request => request.executable !== '/usr/bin/awk');
    expect(probes.map(request => [request.executable, request.argv.at(-1)])).toEqual([['/bin/sh', 'opencode'], ['/home/me/.opencode/bin/opencode', '--version']]);
    for (const request of probes) expect(request.args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', '/mnt/c/vault']));
  });
});
