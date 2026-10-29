/** @vitest-environment jsdom */

import '@test/helpers/ObsidianSettingsDOM';

import { axe } from '@test/helpers/accessibility';
import type * as SettingsDOM from '@test/helpers/ObsidianSettingsDOM';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ProviderSettingsTabRendererContext } from '@/core/providers/types';
import { getCodexProviderSettings } from '@/providers/codex/settings';
import { createCodexSettingsTabRenderer } from '@/providers/codex/ui/CodexSettingsTab';

let mockPending: Promise<void>;
let mockError: unknown;
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

vi.mock('obsidian', async () => {
  const actual = (await vi.importActual<typeof SettingsDOM>('../../../../helpers/ObsidianSettingsDOM'));
  return {
    ...actual,
    Setting: class extends actual.Setting {
      setHeading() { return this; }
      addToggle(callback: (component: unknown) => void) {
        const toggleEl = this.settingEl.createEl('input', { attr: { type: 'checkbox', role: 'switch' } });
        const component = {
          toggleEl,
          setValue(value: boolean) { toggleEl.checked = value; return this; },
          setDisabled(value: boolean) { toggleEl.disabled = value; return this; },
          onChange(fn: (value: boolean) => void) {
            toggleEl.addEventListener('change', () => fn(toggleEl.checked)); return this;
          },
        };
        callback(component); return this;
      }
      addDropdown(callback: Parameters<typeof actual.Setting.prototype.addDropdown>[0]) {
        return super.addDropdown(component => {
          const onChange = component.onChange.bind(component);
          component.onChange = fn => onChange(value => {
            mockPending = Promise.resolve(fn(value)).catch(error => { mockError = error; });
          });
          callback(component);
        });
      }
    },
  };
});
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
  mockError = undefined;
  mockPending = Promise.resolve();
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
  const row = within(container).getByText('Installation method').parentElement!;
  const select = within(row).getByRole('combobox') as HTMLSelectElement;
  const distro = within(container).getByPlaceholderText('Ubuntu') as HTMLInputElement;
  const cliCard = container.querySelector<HTMLElement>('.claudian-cli-installation')!;
  fireEvent.click(within(cliCard).getByRole('button', { name: 'Codex CLI installation' }));
  const cli = within(cliCard).getByRole('textbox', { name: 'Codex CLI path' }) as HTMLInputElement;
  expect(select.value).toBe(initial);
  fireEvent.change(select, { target: { value: requested } });
  await mockPending;
  const expected = outcome === 'rejected' ? initial : requested;
  expect(getCodexProviderSettings(settings).installationMethod).toBe(expected);
  expect(select.value).toBe(expected);
  expect(distro.disabled).toBe(expected !== 'wsl');
  expect(cli.placeholder).toBe(expected === 'wsl' ? 'codex' : 'C:\\Users\\you\\AppData\\Roaming\\npm\\codex.exe');
  fireEvent.input(cli, { target: { value: '/missing/linux/codex' } });
  await waitFor(() => expect(cli.getAttribute('aria-invalid')).toBe(String(expected !== 'wsl')));
  expect((await axe(cliCard)).violations).toEqual([]);
  expect(persist).toHaveBeenCalledTimes(1);
  expect(mockError instanceof Error).toBe(outcome !== 'accepted');
});
