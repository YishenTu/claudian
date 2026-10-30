/** @vitest-environment jsdom */

import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { createCodexWorkspaceHarness } from '@test/helpers/providers/codex/CodexWorkspaceHarness';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { getCodexProviderSettings } from '@/providers/codex/settings';

it('preserves spaces typed into the real Codex WSL CLI path until the final commit', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const key = getInstallationKey();
  const fixture = await createCodexWorkspaceHarness({ installationMethodsByHost: { [key]: 'wsl' } });
  const { settings } = fixture;
  const container = document.body.createDiv();
  const renderer = fixture.services.settingsTabRenderer!;
  let control: ReturnType<typeof renderer.render> = undefined;
  try {
    control = renderer.render(container, { plugin: fixture.host, notifyProviderModelOptionsChanged() {}, renderCustomContextLimits() {} });
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
    expect((await axe(input.closest('.claudian-cli-installation')!)).violations).toEqual([]);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    control?.dispose();
    await fixture.dispose();
    container.remove();
  }
});
