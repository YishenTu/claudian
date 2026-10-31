/** @vitest-environment jsdom */

import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { createCodexWorkspaceHarness } from '@test/helpers/providers/codex/CodexWorkspaceHarness';
import { mountProviderSettings } from '@test/helpers/ProviderSettingsHarness';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { getCodexProviderSettings } from '@/providers/codex/settings';

it('preserves spaces typed into the real Codex WSL CLI path until the final commit', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const key = getInstallationKey();
  const fixture = await createCodexWorkspaceHarness({ installationMethodsByHost: { [key]: 'wsl' } });
  const { settings } = fixture;
  const mounted = mountProviderSettings(fixture.services.settingsTabRenderer!, fixture.host);
  const { container } = mounted;
  try {
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
    await waitFor(() => expect(getCodexProviderSettings(settings).cliPathsByHost[key]).toBe(path));
    expect(getCodexProviderSettings(await fixture.settingsStorage.load()).cliPathsByHost[key]).toBe(path);
    expect(input.value).toBe(path);
    const method = within(container).getByRole('combobox', { name: 'Installation method' });
    const distro = within(container).getByRole('textbox', { name: 'WSL distro override' }) as HTMLInputElement;
    expect(distro.disabled).toBe(false);
    fireEvent.change(method, { target: { value: 'native-windows' } });
    await waitFor(() => expect(distro.disabled).toBe(true));
    expect(getCodexProviderSettings(settings).installationMethod).toBe('native-windows');
    fireEvent.change(method, { target: { value: 'wsl' } });
    await waitFor(() => expect(distro.disabled).toBe(false));
    fireEvent.input(distro, { target: { value: 'Debian' } });
    await waitFor(() => expect(getCodexProviderSettings(settings).wslDistroOverride).toBe('Debian'));
    expect((await axe(method.parentElement!)).violations).toEqual([]);
    expect((await axe(distro.parentElement!)).violations).toEqual([]);
    expect((await axe(input.closest('.claudian-cli-installation')!)).violations).toEqual([]);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    mounted.dispose();
    await fixture.dispose();
    container.remove();
  }
});
