/** @vitest-environment jsdom */

import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { controlChangeSettled } from '@test/helpers/ObsidianHost';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import spawn from 'cross-spawn';

import { ProviderWorkspaceRegistry } from '@/core/providers/ProviderWorkspaceRegistry';
import { registerProviderModules } from '@/core/providers/registerProviderModules';
import {
  type AntigravityWorkspaceServices,
  createAntigravityWorkspaceServices,
} from '@/providers/antigravity/app/AntigravityWorkspaceServices';
import { antigravityProviderRegistration } from '@/providers/antigravity/registration';
import { getAntigravityProviderSettings, updateAntigravityProviderSettings } from '@/providers/antigravity/settings';
import { antigravitySettingsTabRenderer } from '@/providers/antigravity/ui/AntigravitySettingsTab';
import { claudeProviderRegistration } from '@/providers/claude/registration';

registerProviderModules([claudeProviderRegistration, antigravityProviderRegistration]);

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const NATIVE_PLACEHOLDER = 'C:\\Users\\you\\AppData\\Local\\agy\\agy.exe';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let fixture: Awaited<ReturnType<typeof createProviderHostFixture>>;
let workspace: AntigravityWorkspaceServices;
let container: HTMLElement;
let renderer: { dispose(): void } | undefined;
let wsl: WSLProcessFixture;

beforeEach(async () => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  fixture = await createProviderHostFixture();
  updateAntigravityProviderSettings(fixture.settings, { enabled: true, visibleModels: ['gemini-4-argon'] });
  workspace = await createAntigravityWorkspaceServices(fixture.host);
  ProviderWorkspaceRegistry.setServices('antigravity', workspace);
  container = document.body.createDiv();
  wsl = new WSLProcessFixture();
  wsl.binaries.set('agy', { path: '/home/me/.local/bin/agy', version: '1.5.12' });
  vi.mocked(spawn).mockImplementation(wsl.spawn);
  // A Windows vault, as the fixture's own `overrides` would supply it; WSL maps it to the Linux cwd.
  Object.defineProperty(fixture.host, 'workingDirectory', { value: 'C:\\vault' });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
});

afterEach(async () => {
  Object.defineProperty(process, 'platform', platform);
  renderer?.dispose();
  renderer = undefined;
  await workspace.dispose();
  ProviderWorkspaceRegistry.setServices('antigravity', undefined);
  await fixture.dispose();
  container.remove();
  vi.mocked(spawn).mockReset();
});

function render(): void {
  const rendered = antigravitySettingsTabRenderer.render(container, {
    notifyProviderModelOptionsChanged: () => undefined, plugin: fixture.host,
  });
  if (!rendered) throw new Error('Antigravity settings must expose cleanup');
  renderer = rendered;
}

function cliInput(): HTMLInputElement {
  const disclosure = within(container).getByRole('button', { name: 'Antigravity installation' });
  if (disclosure.getAttribute('aria-expanded') === 'false') fireEvent.click(disclosure);
  return within(container).getByRole('textbox', { name: 'CLI path' }) as HTMLInputElement;
}

describe('Windows installation method', () => {
  it.each([
    ['native-windows', 'wsl'], ['wsl', 'native-windows'],
  ] as const)('switches %s → %s and validates the CLI path for the selected installation', async (initial, requested) => {
    await fixture.host.applyProviderRuntimeSettings(['antigravity'], settings => {
      updateAntigravityProviderSettings(settings, { installationMethod: initial, wslDistroOverride: 'Ubuntu' });
    });
    render();
    const method = within(container).getByRole('combobox', { name: 'Installation method' }) as HTMLSelectElement;
    const distro = within(container).getByRole('textbox', { name: 'WSL distro override' }) as HTMLInputElement;
    const cli = cliInput();
    const card = cli.closest<HTMLElement>('.claudian-cli-installation')!;
    expect(method.value).toBe(initial);

    fireEvent.change(method, { target: { value: requested } });
    await controlChangeSettled(method);

    expect(getAntigravityProviderSettings(fixture.settings).installationMethod).toBe(requested);
    expect(getAntigravityProviderSettings(await fixture.settingsStorage.load()).installationMethod).toBe(requested);
    expect(distro.disabled).toBe(requested !== 'wsl');
    expect(cli.placeholder).toBe(requested === 'wsl' ? 'agy' : NATIVE_PLACEHOLDER);
    fireEvent.input(cli, { target: { value: '/missing/linux/agy' } });
    await waitFor(() => expect(cli.getAttribute('aria-invalid')).toBe(String(requested !== 'wsl')));
    // Enter starts the save (disabling the field) only for a valid path; enabled again means it settled.
    fireEvent.keyDown(cli, { key: 'Enter' });
    await waitFor(() => expect(cli.disabled).toBe(false));
    // WSL accepts a Linux path that does not exist on the Windows host; native Windows rejects it before saving.
    const savedPath = requested === 'wsl' ? '/missing/linux/agy' : undefined;
    expect(getAntigravityProviderSettings(fixture.settings).cliPathsByHost[fixture.storage.installationKey]).toBe(savedPath);
    expect((await axe(card)).violations).toEqual([]);
  });

  it('inspects the agy CLI inside the selected distro', async () => {
    updateAntigravityProviderSettings(fixture.settings, { installationMethod: 'wsl', wslDistroOverride: 'Ubuntu' });
    render();
    const card = cliInput().closest<HTMLElement>('.claudian-cli-installation')!;
    await waitFor(() => expect(within(card).getByText('/home/me/.local/bin/agy')).toBeTruthy());
    expect(within(card).getByText('v1.5.12')).toBeTruthy();
    const probes = wsl.requests.filter(request => request.executable !== 'agy');
    expect(probes.map(request => [request.executable, request.argv.at(-1)])).toEqual([['/bin/sh', 'agy'], ['/home/me/.local/bin/agy', '--version']]);
    for (const request of probes) expect(request.args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', '/mnt/c/vault']));
  });
});
