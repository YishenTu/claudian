/** @vitest-environment jsdom */


import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { controlChangeSettled } from '@test/helpers/ObsidianHost';
import { createCodexWorkspaceHarness } from '@test/helpers/providers/codex/CodexWorkspaceHarness';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { getCodexProviderSettings } from '@/providers/codex/settings';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const fixtures: Awaited<ReturnType<typeof createCodexWorkspaceHarness>>[] = [];
const controls: Array<{ dispose(): void }> = [];

afterEach(async () => {
  controls.splice(0).forEach(control => control.dispose());
  await Promise.all(fixtures.splice(0).map(fixture => fixture.dispose()));
  Object.defineProperty(process, 'platform', originalPlatform);
  vi.restoreAllMocks(); document.body.replaceChildren();
});

it.each([
  ['native-windows', 'wsl', 'rejected'], ['wsl', 'native-windows', 'rejected'],
  ['native-windows', 'wsl', 'accepted'], ['wsl', 'native-windows', 'accepted'],
  ['native-windows', 'wsl', 'committed-error'], ['wsl', 'native-windows', 'committed-error'],
] as const)('synchronizes %s → %s controls with settings after a %s save', async (initial, requested, outcome) => {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: 'win32' });
  const key = getInstallationKey();
  const persist = vi.fn(async () => { if (outcome === 'rejected') throw new Error('Disk full'); });
  const fixture = await createCodexWorkspaceHarness({
    installationMethodsByHost: { [key]: initial }, wslDistroOverridesByHost: { [key]: 'Ubuntu' },
  }, { beforePersist: persist });
  fixtures.push(fixture);
  const { settings, host } = fixture;
  await fixture.settingsStorage.save(settings);
  if (outcome === 'committed-error') {
    const apply = host.applyProviderRuntimeSettings.bind(host);
    vi.spyOn(host, 'applyProviderRuntimeSettings').mockImplementation(async (...args) => {
      await apply(...args);
      throw new Error('Runtime reset failed');
    });
  }
  const container = document.body.createDiv();
  const control = fixture.services.settingsTabRenderer!.render(container, {
    plugin: host, notifyProviderModelOptionsChanged() {}, renderCustomContextLimits() {},
  });
  if (control) controls.push(control);
  const select = within(container).getByRole<HTMLSelectElement>('combobox', { name: 'Installation method' });
  const distro = within(container).getByPlaceholderText('Ubuntu') as HTMLInputElement;
  const cliCard = container.querySelector<HTMLElement>('.claudian-cli-installation')!;
  fireEvent.click(within(cliCard).getByRole('button', { name: 'Codex CLI installation' }));
  const cli = within(cliCard).getByRole('textbox', { name: 'Codex CLI path' }) as HTMLInputElement;
  expect(select.value).toBe(initial);
  fireEvent.change(select, { target: { value: requested } });
  const error = await controlChangeSettled(select).then(() => undefined, (failure: unknown) => failure);
  const expected = outcome === 'rejected' ? initial : requested;
  expect(getCodexProviderSettings(settings).installationMethod).toBe(expected);
  expect(select.value).toBe(expected);
  expect(distro.disabled).toBe(expected !== 'wsl');
  expect(cli.placeholder).toBe(expected === 'wsl' ? 'codex' : 'C:\\Users\\you\\AppData\\Roaming\\npm\\codex.exe');
  fireEvent.input(cli, { target: { value: '/missing/linux/codex' } });
  await waitFor(() => expect(cli.getAttribute('aria-invalid')).toBe(String(expected !== 'wsl')));
  expect((await axe(cliCard)).violations).toEqual([]);
  expect(persist).toHaveBeenCalled();
  expect(getCodexProviderSettings(await fixture.settingsStorage.load()).installationMethod).toBe(expected);
  expect(error instanceof Error).toBe(outcome !== 'accepted');
});
