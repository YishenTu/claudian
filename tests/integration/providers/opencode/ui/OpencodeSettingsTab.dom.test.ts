/** @vitest-environment jsdom */
import '@/providers';

import { existsSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import { axe } from '@test/helpers/accessibility';
import { controlChangeSettled } from '@test/helpers/ObsidianSettingsDOM';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ClaudianSettings } from '@/core/types';
import { OpencodeExecutionBackend } from '@/providers/opencode/execution/OpencodeExecutionBackend';
import { OpencodeServerService } from '@/providers/opencode/http/OpencodeServerService';
import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { OpencodeCLIResolver } from '@/providers/opencode/runtime/OpencodeCLIResolver';
import { createOpencodeModels } from '@/providers/opencode/runtime/OpencodeModels';
import { getOpencodeProviderSettings } from '@/providers/opencode/settings';
import { createOpencodeSettingsTabRenderer } from '@/providers/opencode/ui/OpencodeSettingsTab';

import { createOpencodeHTTPMetadataFixture } from '../metadata/OpencodeHTTPMetadataFixture';

vi.mock('obsidian', () => import('@test/helpers/ObsidianSettingsDOM'));
const deviceKey = getInstallationKey();

async function setup(config: Record<string, unknown> = {}) {
  const fixture = createOpencodeHTTPMetadataFixture();
  const persist = vi.fn(async (_settings: ClaudianSettings) => undefined);
  const app = await createProviderHostFixture({
    settings: { providerConfigs: { claude: { enabled: true }, opencode: { ...fixture.createPlugin().settings.providerConfigs.opencode, ...config } } },
    beforePersist: persist,
    overrides: { workingDirectory: fixture.root, getResolvedProviderCliPath: async () => fixture.cliPath },
  });
  const { host, lifecycle: registry } = app;
  const runtimeHost = host.getRuntimeHost('opencode');
  const servers = new OpencodeServerService();
  const service = new OpencodeMetadataService(runtimeHost, registry, { serverService: servers });
  const catalog = createOpencodeModels(runtimeHost, service);
  const cliResolver = new OpencodeCLIResolver();
  const reset = vi.spyOn(cliResolver, 'reset');
  const context = { plugin: host, notifyProviderModelOptionsChanged: vi.fn(), renderCustomContextLimits: vi.fn() };
  const container = document.body.createDiv();
  const view = createOpencodeSettingsTabRenderer({ cliResolver, metadataService: service, modelCatalog: catalog }).render(container, context);
  await catalog.refresh();
  persist.mockClear(); context.notifyProviderModelOptionsChanged.mockClear();
  return { fixture, host, registry, persist, reset, runtimeHost, servers, service, context, container, ui: within(container), async dispose() {
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
    await waitFor(() => expect(f.reset).toHaveBeenCalledTimes(1));
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
  const disposed = vi.spyOn(session, 'dispose');
  f.registry.acquire({ providerId: 'opencode', createSession: () => session }, {} as never, 'chat');
  const load = vi.spyOn(f.service, 'loadCatalog');
  const warm = vi.spyOn(f.service, 'warmModelMetadata');
  try {
    fireEvent.click(f.ui.getByRole('switch', { name: 'Enable OpenCode' }));
    await waitFor(() => expect(f.context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('opencode'));
    expect(getOpencodeProviderSettings(f.host.settings).enabled).toBe(true);
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(f.registry.getProviderGeneration('opencode')).toBe(1);
    expect(load).not.toHaveBeenCalled(); expect(warm).not.toHaveBeenCalled();
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
  const originalReset = f.reset.getMockImplementation();
  let transitioning = false;
  f.registry.registerTransitionHook('opencode', {
    beforeTransition: async () => { transitioning = true; },
    afterTransition: async () => { transitioning = false; },
  });
  const resets: Array<{ paths: Record<string, string>; transitioning: boolean }> = [];
  f.reset.mockImplementation(() => {
    resets.push({ paths: { ...getOpencodeProviderSettings(f.host.settings).cliPathsByHost }, transitioning });
    originalReset?.();
  });
  try {
    editCLI(f.ui, configured);
    await waitFor(() => expect(f.reset).toHaveBeenCalledTimes(1));
    expect(f.persist).toHaveBeenCalled();
    expect(resets).toEqual([{ paths: { [deviceKey]: configured }, transitioning: true }]);
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
