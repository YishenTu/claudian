/** @vitest-environment jsdom */
import { existsSync, rmSync, writeFileSync } from 'node:fs';

import { axe } from '@test/helpers/accessibility';
import { runtimeHostFor } from '@test/helpers/providerRuntimeHost';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { OpencodeHTTPClient } from '@/providers/opencode/http/OpencodeHTTPClient';
import { OpencodeMetadataService } from '@/providers/opencode/metadata/OpencodeMetadataService';
import { createOpencodeModels } from '@/providers/opencode/runtime/OpencodeModels';
import { createOpencodeSettingsTabRenderer } from '@/providers/opencode/ui/OpencodeSettingsTab';

import { createOpencodeHTTPMetadataFixture } from '../metadata/OpencodeHTTPMetadataFixture';

vi.mock('obsidian', async () => {
  const controls = (await vi.importActual<typeof import('@test/helpers/ObsidianSettingsDOM')>('@test/helpers/ObsidianSettingsDOM'));
  return { ...controls, Setting: class extends controls.Setting { setHeading() { return this; } } };
});
// Other settings controls are outside the discovery/display contract.
vi.mock('@/shared/settings/CLIInstallationSetting', () => ({ renderCLIInstallationSetting: () => undefined }));
vi.mock('@/shared/settings/EnvironmentSettingsSection', () => ({ renderEnvironmentSettingsSection: () => undefined }));
vi.mock('@/providers/opencode/ui/OpencodeMigrationNotice', () => ({ renderOpencodeMigrationNotice: () => () => undefined }));
vi.mock('@/shared/settings/ProviderModelEnablementWarning', () => ({
  renderLastEnabledProviderWarning: () => ({}),
  renderProviderModelEnablementWarning: () => ({ refresh: () => undefined }),
}));

const createEl = HTMLElement.prototype.createEl;
HTMLElement.prototype.createEl = function <K extends keyof HTMLElementTagNameMap>(
  this: HTMLElement, tag: K, info?: DomElementInfo | string, callback?: (element: HTMLElementTagNameMap[K]) => void,
): HTMLElementTagNameMap[K] {
  const element = createEl.call(this, tag, info) as HTMLElementTagNameMap[K];
  if (typeof info === 'object' && typeof info.type === 'string') element.setAttribute('type', info.type);
  if (typeof info === 'object' && typeof info.value === 'string') element.setAttribute('value', info.value);
  callback?.(element);
  return element;
};

function setup() {
  const fixture = createOpencodeHTTPMetadataFixture();
  const host = fixture.createPlugin();
  host.storage = { installationKey: 'test' };
  const runtimeHost = runtimeHostFor(host, 'opencode');
  const service = new OpencodeMetadataService(runtimeHost, host.executionLifecycleRegistry);
  const catalog = createOpencodeModels(runtimeHost, service);
  const container = document.body.createDiv();
  const render = () => createOpencodeSettingsTabRenderer({
    cliResolver: { reset: () => undefined }, metadataService: service, modelCatalog: catalog,
  }).render(container, { plugin: host } as any);
  return { fixture, catalog, container, render, async dispose() {
    await catalog.dispose();
    await service.dispose();
    fixture.dispose();
    container.remove();
  } };
}

afterEach(() => vi.restoreAllMocks());

it.each([true, false])('shows the native request failure and only its supplied error ref (%s), then permits retry', async hasRef => {
  const f = setup();
  const errorFile = f.fixture.environment.CATALOG_FILE! + '.error';
  writeFileSync(errorFile, JSON.stringify({ status: 500, body: {
    _tag: 'UnknownError', message: 'Catalog initialization failed' + 'x'.repeat(1_200), ...(hasRef ? { ref: 'err_catalog_test' } : {}),
  } }));
  expect(f.catalog.getSnapshot().status).toBe('idle');
  const view = f.render();
  try {
    await waitFor(() => expect(f.catalog.getSnapshot().status).not.toBe('idle'), { timeout: 40_000 });
    await f.catalog.refresh();
    expect(f.catalog.getSnapshot().status).toBe('failed');
    const status = within(f.container).getByRole('status');
    expect(status.textContent).toContain('Catalog initialization failed');
    expect(status.textContent).toContain('500');
    expect(status.textContent).toContain('.opencode/opencode.json');
    expect(status.textContent?.includes('err_catalog_test')).toBe(hasRef);
    expect(f.container.textContent).not.toContain('OpenCode server returned no enabled models');
    expect(f.container.textContent).not.toContain('No OpenCode models reported');
    rmSync(errorFile);
    fireEvent.click(within(f.container).getByRole('button', { name: 'Discover' }));
    await waitFor(() => expect(f.catalog.getSnapshot().status).toBe('ready'));
    expect(within(f.container).getByRole('checkbox', { name: /DeepSeek Chat/ })).toBeTruthy();
    expect(status.textContent).toBe('');
    expect((await axe(f.container)).violations).toEqual([]);
  } finally { view?.dispose(); await f.dispose(); }
});

it('reports a request timeout without inventing an error ref or a successful empty response', async () => {
  const f = setup();
  writeFileSync(f.fixture.environment.CATALOG_FILE! + '.hang', '');
  const request = OpencodeHTTPClient.prototype.request;
  vi.spyOn(OpencodeHTTPClient.prototype, 'request').mockImplementation(function (this: OpencodeHTTPClient, route, options = {}) {
    return request.call(this, route, { ...options, ...(route === '/api/model' ? { timeoutMs: 100 } : {}) });
  });
  expect(f.catalog.getSnapshot().status).toBe('idle');
  const view = f.render();
  try {
    await waitFor(() => expect(f.catalog.getSnapshot().status).not.toBe('idle'), { timeout: 40_000 });
    await f.catalog.refresh();
    expect(f.catalog.getSnapshot().status).toBe('failed');
    const status = within(f.container).getByRole('status');
    expect(status.textContent).toContain('timed out');
    expect(status.textContent).toContain('opencode debug paths');
    expect(status.textContent).not.toContain('err_');
    expect(f.container.textContent).not.toContain('OpenCode server returned no enabled models');
  } finally { view?.dispose(); await f.dispose(); }
});

it('keeps a confirmed empty response successful, gives configuration guidance, and can discover models later', async () => {
  const f = setup();
  writeFileSync(f.fixture.environment.CATALOG_FILE!, '[]');
  const view = f.render();
  try {
    await waitFor(() => expect(f.catalog.getSnapshot().status).toBe('ready'), { timeout: 40_000 });
    expect(f.catalog.getSnapshot()).toMatchObject({ discoveredCount: 0, error: undefined });
    expect(f.container.textContent).toContain('OpenCode server returned no enabled models');
    expect(f.container.textContent).toContain('.opencode/opencode.json');
    expect(f.container.textContent).toContain('V1 plugins');
    expect(f.container.textContent).not.toContain('err_');
    expect(within(f.container).getByRole('status').textContent).toContain('OpenCode server returned no enabled models');
    f.fixture.writeCatalog();
    // Native catalog changes must reach the already-open settings without another Discover click.
    await waitFor(() => expect(within(f.container).getByRole('checkbox', { name: /DeepSeek Chat/ })).toBeTruthy());
    writeFileSync(f.fixture.environment.CATALOG_FILE! + '.providers', JSON.stringify([{ id: 'deepseek', name: 'Native Provider Name' }]));
    await waitFor(() => expect(within(f.container).getByRole('option', { name: /Native Provider Name/ })).toBeTruthy());
  } finally { view?.dispose(); await f.dispose(); }
});

it('keeps saved selections and explains an empty catalog even when unavailable model rows remain', async () => {
  const f = setup();
  const view = f.render();
  try {
    await waitFor(() => expect(f.catalog.getSnapshot().status).toBe('ready'), { timeout: 40_000 });
    await f.catalog.changeSelection({ type: 'set', modelId: 'deepseek/chat', selected: true });
    writeFileSync(f.fixture.environment.CATALOG_FILE!, '[]');
    fireEvent.click(within(f.container).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(f.catalog.getSnapshot().status).toBe('ready'), { timeout: 40_000 });
    expect(f.catalog.getSnapshot()).toMatchObject({
      discoveredCount: 0, selectedIds: ['deepseek/chat'], models: [{ id: 'deepseek/chat', isAvailable: false }],
    });
    expect(within(f.container).getByRole('status').textContent).toContain('OpenCode server returned no enabled models');
    expect((within(f.container).getByRole('checkbox', { name: /deepseek\/chat/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(f.container).getByRole('button', { name: 'Remove deepseek/chat' })).toBeTruthy();
    expect((await axe(f.container)).violations).toEqual([]);
  } finally { view?.dispose(); await f.dispose(); }
});

it('filters a native custom provider named all independently from All providers', async () => {
  const f = setup();
  writeFileSync(f.fixture.environment.CATALOG_FILE!, JSON.stringify([
    { providerID: 'all', id: 'chat', name: 'All Chat', enabled: true, variants: [] },
    { providerID: 'other', id: 'chat', name: 'Other Chat', enabled: true, variants: [] },
  ]));
  const view = f.render();
  try {
    await waitFor(() => expect(f.catalog.getSnapshot().status).toBe('ready'), { timeout: 40_000 });
    expect(f.catalog.getSnapshot().models.map(model => model.providerKey).sort()).toEqual(['all', 'other']);
    const ui = within(f.container);
    const filter = ui.getByRole('combobox');
    const provider = within(filter).getByRole('option', { name: 'all (1)' }) as HTMLOptionElement;
    fireEvent.change(filter, { target: { value: provider.value } });
    expect(ui.getAllByRole('checkbox')).toHaveLength(1);
    expect(ui.getByRole('checkbox', { name: /All Chat/ })).toBeTruthy();
    expect(ui.queryByRole('checkbox', { name: /Other Chat/ })).toBeNull();
    const everyProvider = within(filter).getByRole('option', { name: /All providers/ }) as HTMLOptionElement;
    fireEvent.change(filter, { target: { value: everyProvider.value } });
    expect(ui.getAllByRole('checkbox')).toHaveLength(2);
    expect((await axe(f.container)).violations).toEqual([]);
  } finally { view?.dispose(); await f.dispose(); }
});

it('clears manual refresh failure guidance after background recovery and retains success on a later background error', async () => {
  const f = setup();
  const errorFile = f.fixture.environment.CATALOG_FILE! + '.error';
  const view = f.render();
  const writeFailure = () => writeFileSync(errorFile, JSON.stringify({ status: 500, body: {
    _tag: 'UnknownError', message: 'Catalog temporarily unavailable', ref: 'err_background_test',
  } }));
  try {
    await waitFor(() => expect(f.catalog.getSnapshot().status).toBe('ready'), { timeout: 40_000 });
    await waitFor(() => expect(existsSync(f.fixture.environment.ENDPOINT_FILE + '.subscribed')).toBe(true));
    writeFailure();
    fireEvent.click(within(f.container).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(f.catalog.getSnapshot().status).toBe('failed'));
    expect(within(f.container).getByRole('status').textContent).toContain('Catalog temporarily unavailable');
    expect(within(f.container).getByRole('checkbox', { name: /DeepSeek Chat/ })).toBeTruthy();

    rmSync(errorFile);
    f.fixture.writeCatalog('Recovered Chat');
    await waitFor(() => expect(within(f.container).getByRole('checkbox', { name: /Recovered Chat/ })).toBeTruthy());
    expect(f.catalog.getSnapshot()).toMatchObject({ status: 'ready', stale: false, error: undefined });
    expect(within(f.container).getByRole('status').textContent).toBe('');
    expect((await axe(f.container)).violations).toEqual([]);

    // Observe a real failing HTTP read, rather than asserting before the event is handled.
    const request = OpencodeHTTPClient.prototype.request;
    let backgroundRejected = false;
    vi.spyOn(OpencodeHTTPClient.prototype, 'request').mockImplementation(async function (this: OpencodeHTTPClient, route, options) {
      try { return await request.call(this, route, options); }
      catch (error) { if (route === '/api/model') backgroundRejected = true; throw error; }
    });
    writeFailure();
    f.fixture.writeCatalog('Unavailable Update');
    await waitFor(() => expect(backgroundRejected).toBe(true));
    expect(f.catalog.getSnapshot()).toMatchObject({ status: 'ready', error: undefined });
    expect(within(f.container).getByRole('checkbox', { name: /Recovered Chat/ })).toBeTruthy();
    expect(within(f.container).queryByRole('checkbox', { name: /Unavailable Update/ })).toBeNull();
    expect(within(f.container).getByRole('status').textContent).toBe('');
  } finally { view?.dispose(); await f.dispose(); }
});
