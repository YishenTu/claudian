/** @vitest-environment jsdom */

import '@test/helpers/ObsidianSettingsDOM';

import { axe } from '@test/helpers/accessibility';
import { controlChangeSettled } from '@test/helpers/ObsidianSettingsDOM';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ProviderSettingsTabRendererContext } from '@/core/providers/types';
import { getCodexProviderSettings } from '@/providers/codex/settings';
import { createCodexSettingsTabRenderer } from '@/providers/codex/ui/CodexSettingsTab';

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

vi.mock('obsidian', async () => ({
  ...(await vi.importActual<typeof import('@test/__mocks__/obsidian')>('@test/__mocks__/obsidian')),
  ...(await vi.importActual<typeof import('@test/helpers/ObsidianSettingsDOM')>('@test/helpers/ObsidianSettingsDOM')),
}));
vi.mock('@/providers/codex/runtime/CodexCLIInstallation', () => ({
  inspectCodexInstallation: async () => ({ path: null, version: null, source: 'auto' }),
}));
vi.mock('@/shared/settings/EnvironmentSettingsSection', () => ({ renderEnvironmentSettingsSection() {} }));
vi.mock('@/shared/settings/ProviderModelsSection', () => ({
  renderProviderModelsSection: () => ({ refresh() {}, dispose() {} }),
}));

afterEach(() => {
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
  const settings = { providerConfigs: { codex: {
    enabled: true, installationMethodsByHost: { [key]: initial }, wslDistroOverridesByHost: { [key]: 'Ubuntu' },
  } } };
  const persist = vi.fn(async () => { if (outcome === 'rejected') throw new Error('Disk full'); });
  const coordinator = new SettingsCoordinator(settings, persist);
  const container = document.body.createDiv();
  const context = {
    plugin: {
      settings, storage: { installationKey: key }, getRuntimeHost: () => ({}),
      mutateSettings: coordinator.mutate.bind(coordinator),
      applyProviderRuntimeSettings: async (_ids: string[], mutation: Parameters<typeof coordinator.mutate>[0]) => {
        await coordinator.mutate(mutation);
        if (outcome === 'committed-error') throw new Error('Runtime reset failed');
      },
    },
    notifyProviderModelOptionsChanged() {}, renderCustomContextLimits() {},
  } as unknown as ProviderSettingsTabRendererContext;
  createCodexSettingsTabRenderer({ cliResolver: { reset() {} }, modelCatalog: {} } as Parameters<typeof createCodexSettingsTabRenderer>[0])
    .render(container, context);
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
  expect(persist).toHaveBeenCalledTimes(1);
  expect(error instanceof Error).toBe(outcome !== 'accepted');
});
