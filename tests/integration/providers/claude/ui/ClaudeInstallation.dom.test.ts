/** @vitest-environment jsdom */
import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { mountProviderSettings } from '@test/helpers/ProviderSettingsHarness';
import { WSLProcessFixture } from '@test/helpers/WSLProcessFixture';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import spawn from 'cross-spawn';

import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ProviderCLIResolutionContext } from '@/core/providers/types';
import { createClaudeWorkspaceServices } from '@/providers/claude/app/ClaudeWorkspaceServices';
import { getClaudeProviderSettings } from '@/providers/claude/settings';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

it('persists Windows WSL controls and inspects Linux CLI paths through the selected distro', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const native = new WSLProcessFixture();
  const cli = '/home/me/Claude Code/claude';
  native.binaries.set(cli, { path: cli, version: '2.1.99 (Claude Code)' });
  vi.mocked(spawn).mockReset().mockImplementation(native.spawn);
  const style = document.head.appendChild(document.createElement('style'));
  style.textContent = '.claudian-hidden { display: none; }';
  const key = getInstallationKey();
  try {
    let resolveCli: (settings: Record<string, unknown>, context?: ProviderCLIResolutionContext) => string | null | Promise<string | null> = () => null;
    const fixture = await createProviderHostFixture({ overrides: {
      workingDirectory: 'C:\\Vault',
      getResolvedProviderCliPath: async (_id, context) => resolveCli(fixture.settings, context),
    } });
    const services = await createClaudeWorkspaceServices(fixture.host, { catalogProbe: async () => ({ models: [], outputStyles: [] }) });
    onTestFinished(() => services.dispose());
    resolveCli = (settings, context) => services.cliResolver.resolveFromSettings(settings, context);
    const { container } = mountProviderSettings(services.settingsTabRenderer!, fixture.host);
    const current = () => getClaudeProviderSettings(fixture.settings);
    const durable = async () => getClaudeProviderSettings(await fixture.settingsStorage.load());

    const method = within(container).getByRole('combobox', { name: 'Installation method' });
    expect(within(container).queryByRole('textbox', { name: 'WSL distro override' })).toBeNull();
    fireEvent.change(method, { target: { value: 'wsl' } });
    await waitFor(() => expect(current().installationMethod).toBe('wsl'));
    expect((await durable()).installationMethod).toBe('wsl');
    const distro = await within(container).findByRole('textbox', { name: 'WSL distro override' });
    fireEvent.input(distro, { target: { value: 'Debian' } });
    await waitFor(() => expect(current().wslDistroOverride).toBe('Debian'));
    expect((await durable()).wslDistroOverride).toBe('Debian');

    fireEvent.click(within(container).getByRole('button', { name: 'Claude Code installation' }));
    const input = within(container).getByRole<HTMLInputElement>('textbox', { name: 'Claude Code CLI path' });
    expect(input.placeholder).toBe('claude');
    fireEvent.input(input, { target: { value: cli } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(current().cliPathsByHost[key]).toBe(cli));
    expect((await durable()).cliPathsByHost[key]).toBe(cli);
    // The path exists only in the distro: host file checks would reject it, and the version comes from the WSL probe.
    await waitFor(() => expect(within(container).getByText('v2.1.99')).toBeTruthy());
    // The host-scoped setting is the configured path, so the inspection reports it as custom.
    expect(within(input.closest<HTMLElement>('.claudian-cli-installation')!).getByRole('status').textContent).toBe('Custom path');
    expect(input.getAttribute('aria-invalid')).toBe('false');
    const probe = native.requests.find(request => request.executable === cli);
    expect(probe?.args.slice(0, 2)).toEqual(['--distribution', 'Debian']);
    expect(probe?.argv).toEqual(['--version']);

    fireEvent.input(input, { target: { value: 'C:\\native\\claude.exe' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(within(container).getByRole('alert').textContent).toContain('WSL mode expects'));
    expect((await durable()).cliPathsByHost[key]).toBe(cli);

    fireEvent.change(method, { target: { value: 'native-windows' } });
    await waitFor(() => expect(current().installationMethod).toBe('native-windows'));
    expect((await durable()).installationMethod).toBe('native-windows');
    await waitFor(() => expect(within(container).queryByRole('textbox', { name: 'WSL distro override' })).toBeNull());
    expect((distro as HTMLInputElement).disabled).toBe(true);
    expect((await axe(container)).violations).toEqual([]);
  } finally {
    style.remove();
    Object.defineProperty(process, 'platform', platform);
  }
});
