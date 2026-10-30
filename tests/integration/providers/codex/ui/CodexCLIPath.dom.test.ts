/** @vitest-environment jsdom */
import '@test/helpers/ObsidianSettingsDOM';

import { deserialize, serialize } from 'node:v8';

import { axe } from '@test/helpers/accessibility';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import { getCodexProviderSettings } from '@/providers/codex/settings';
import { createCodexSettingsTabRenderer } from '@/providers/codex/ui/CodexSettingsTab';

vi.mock('@/core/device/InstallationKey', () => ({ getInstallationKey: () => 'host-a' }));
vi.mock('@/providers/codex/runtime/CodexCLIInstallation', () => ({
  inspectCodexInstallation: async () => ({ path: null, version: null, source: 'auto' }),
}));
vi.mock('@/shared/settings/ProviderModelsSection', () => ({
  renderProviderModelsSection: () => ({ refresh() {}, dispose() {} }),
}));
vi.mock('@/shared/settings/EnvironmentSettingsSection', () => ({ renderEnvironmentSettingsSection() {} }));
vi.mock('obsidian', async () => ({
  ...(await vi.importActual<typeof import('@test/__mocks__/obsidian')>('@test/__mocks__/obsidian')),
  ...(await vi.importActual<typeof import('@test/helpers/ObsidianSettingsDOM')>('@test/helpers/ObsidianSettingsDOM')),
}));

it('preserves spaces typed into the real Codex WSL CLI path until the final commit', async () => {
  globalThis.structuredClone ??= value => deserialize(serialize(value));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const settings = { providerConfigs: { codex: { enabled: true, installationMethodsByHost: { 'host-a': 'wsl' } } } };
  let saved = '';
  const coordinator = new SettingsCoordinator(settings, async draft => { saved = JSON.stringify(draft); });
  const renderer = createCodexSettingsTabRenderer({ cliResolver: { reset() {} }, modelCatalog: {} } as unknown as Parameters<typeof createCodexSettingsTabRenderer>[0]);
  const container = document.body.createDiv();
  const plugin = {
    settings, storage: { installationKey: 'host-a' }, getRuntimeHost: () => ({}),
    mutateSettings: coordinator.mutate.bind(coordinator),
    applyProviderRuntimeSettings: async (_ids: string[], mutation: (draft: typeof settings) => void) => { await coordinator.mutate(mutation); },
  };
  try {
    renderer.render(container, { plugin, notifyProviderModelOptionsChanged() {}, renderCustomContextLimits() {} } as unknown as Parameters<typeof renderer.render>[1]);
    fireEvent.click(within(container).getByRole('button', { name: 'Codex CLI installation' }));
    const input = within(container).getByRole('textbox', { name: 'Codex CLI path' }) as HTMLInputElement;
    expect(getCodexProviderSettings(settings).installationMethod).toBe('wsl');
    input.focus();
    const path = '/home/user/my tools/codex';
    for (const character of path) {
      fireEvent.input(input, { target: { value: input.value + character } });
      await Promise.resolve();
    }
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(getCodexProviderSettings(settings).cliPathsByHost['host-a']).toBe(path));
    expect(getCodexProviderSettings(JSON.parse(saved)).cliPathsByHost['host-a']).toBe(path);
    expect(input.value).toBe(path);
    expect((await axe(input.closest('.claudian-cli-installation')!)).violations).toEqual([]);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    container.remove();
  }
});
