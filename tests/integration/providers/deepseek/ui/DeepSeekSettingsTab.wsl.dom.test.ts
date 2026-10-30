/** @vitest-environment jsdom */
import '@/providers';

import { axe } from '@test/helpers/accessibility';
import { NativePeer } from '@test/helpers/deepseek/NativePeer';
import { controlChangeSettled } from '@test/helpers/ObsidianHost';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { mountProviderSettings } from '@test/helpers/ProviderSettingsHarness';
import { WSLProcessFixture, type WSLProcessRequest } from '@test/helpers/WSLProcessFixture';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import spawn from 'cross-spawn';

import { getInstallationKey } from '@/core/device/InstallationKey';
import { createDeepSeekWorkspaceServices } from '@/providers/deepseek/app/DeepSeekWorkspaceServices';
import { DeepSeekCLIResolver } from '@/providers/deepseek/runtime/DeepSeekCLIResolver';
import { createDeepSeekModels } from '@/providers/deepseek/runtime/DeepSeekModels';
import { getDeepSeekProviderSettings } from '@/providers/deepseek/settings';
import { createDeepSeekSettingsTabRenderer } from '@/providers/deepseek/ui/DeepSeekSettingsTab';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const ENTRY = '/usr/lib/node_modules/@deepseek-ai/dsh/dist/cli.js';
let wsl: WSLProcessFixture;

beforeEach(() => {
  wsl = new WSLProcessFixture();
  wsl.binaries.set('dsh', { path: '/usr/bin/dsh', version: 'dsh 0.2.0' });
  wsl.binaries.set('node', { path: '/usr/bin/node', version: 'v24.16.0' });
  // The npm entry resolver prints the JSON-encoded package entry; WSLInstallation's own suite runs the real script.
  wsl.reply = request => request.executable === '/usr/bin/node' && request.argv[0] === '-e' ? { stdout: JSON.stringify(ENTRY) } : undefined;
  vi.mocked(spawn).mockReset().mockImplementation(wsl.spawn);
  vi.stubEnv('SystemRoot', 'C:\\Windows');
});
afterEach(() => { Object.defineProperty(process, 'platform', platform); vi.unstubAllEnvs(); });

const probesFor = (distro: string) => wsl.requests.filter(request => request.args.includes(distro));
const lookup = (request: WSLProcessRequest) => [request.executable, request.argv[0] === '-e' ? '-e' : '', request.argv.at(-1)].filter(Boolean).join(' ');

it('switches to Linux WSL discovery in the vault distro, reserving Linux preset tools and explaining Desktop-only installs', async () => {
  const fixture = await createProviderHostFixture({
    settings: { providerConfigs: { deepseek: { enabled: true } } },
    overrides: { workingDirectory: '\\\\wsl$\\Ubuntu\\home\\me\\Vault' },
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  const modelCatalog = createDeepSeekModels(fixture.host.getRuntimeHost('deepseek'), async () => []);
  onTestFinished(() => modelCatalog.dispose());
  const { container, ui } = mountProviderSettings(createDeepSeekSettingsTabRenderer({ cliResolver: new DeepSeekCLIResolver(), modelCatalog }), fixture.host);
  const durable = async () => getDeepSeekProviderSettings(await fixture.settingsStorage.load());

  const method = ui.getByRole('combobox', { name: 'Installation method' });
  fireEvent.click(ui.getByRole('button', { name: 'DeepSeek Harness installation' }));
  const cli = ui.getByRole('textbox', { name: 'CLI path' });
  const details = ui.getByText(/^Auto prefers dsh/);
  expect(cli).toHaveProperty('placeholder', '%LOCALAPPDATA%\\Programs\\DeepSeek Harness');
  expect(wsl.requests).toEqual([]);
  fireEvent.change(method, { target: { value: 'wsl' } });
  await controlChangeSettled(method);
  expect(getDeepSeekProviderSettings(fixture.settings).installationMethod).toBe('wsl');
  expect((await durable()).installationMethod).toBe('wsl');
  expect(cli).toHaveProperty('placeholder', 'dsh');

  // The refreshed card probes dsh, Linux Node and the npm entry inside the distro inferred from the vault.
  const card = cli.closest<HTMLElement>('.claudian-cli-installation')!;
  await waitFor(() => expect(within(card).getByText('/usr/bin/dsh')).toBeTruthy());
  expect(within(card).getByText('v0.2.0')).toBeTruthy();
  expect(probesFor('Ubuntu').map(lookup)).toEqual([
    '/bin/sh dsh', '/usr/bin/dsh --version', '/bin/sh node', '/usr/bin/node --version', '/usr/bin/node -e /usr/bin/dsh',
  ]);
  for (const request of wsl.requests) expect(request.args).toEqual(expect.arrayContaining(['--distribution', 'Ubuntu', '--cd', '/home/me/Vault']));

  // WSL runs Linux plugins, so the Linux shell tool is reserved even though validation runs on Windows.
  const plugins = ui.getByRole('textbox', { name: 'Additional preset plugins' });
  fireEvent.change(plugins, { target: { value: '- id: tool-bash\n  name: custom-shell' } });
  expect(plugins.getAttribute('aria-invalid')).toBe('true');
  expect(ui.getAllByRole('alert').find(alert => alert.id === plugins.getAttribute('aria-describedby'))?.textContent).toMatch(/already part of Claudian/);
  expect(getDeepSeekProviderSettings(fixture.settings).presetPlugins).toBe('');

  const distro = ui.getByRole('textbox', { name: 'WSL distro override' });
  expect(distro).toHaveProperty('disabled', false);
  fireEvent.input(distro, { target: { value: 'Debian' } });
  await waitFor(async () => expect((await durable()).wslDistroOverride).toBe('Debian'));

  // The same visible details paragraph now explains that Desktop cannot supply a Linux installation.
  expect(details.textContent).toMatch(/^WSL requires Linux Node.js.*Desktop cannot supply a WSL installation/);
  expect(details.closest<HTMLElement>('[hidden]')).toBeNull();
  expect(await axe(container)).toHaveNoViolations();
});

it('retires the running Host when the installation method or WSL distro changes, so the next read launches the new target', async () => {
  const fixture = await createProviderHostFixture({
    // A drive vault has no distro of its own, so the override chooses it.
    settings: { providerConfigs: { deepseek: { enabled: true, wslDistroOverridesByHost: { [getInstallationKey()]: 'Ubuntu' } } } },
    overrides: { workingDirectory: 'C:\\Vault', getResolvedProviderCliPath: async () => '/bin/dsh' },
  });
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  wsl.environment = { HOME: '/home/me' };
  const peer = new NativePeer();
  peer.onCall = method => method === 'session/list' ? { items: [] } : [];
  await peer.open();
  onTestFinished(() => peer.close());
  const { start, lifecycle } = peer.process();
  const workspace = createDeepSeekWorkspaceServices(fixture.host, start);
  onTestFinished(() => workspace.dispose!());
  const targets = () => lifecycle.launches.map(({ execution }) => [execution?.target.method, execution?.target.distroName].filter(Boolean).join(' '));

  await workspace.deepseek.read(async () => undefined);
  expect(targets()).toEqual(['native-windows']);
  const { ui } = mountProviderSettings(workspace.settingsTabRenderer!, fixture.host);
  const method = ui.getByRole('combobox', { name: 'Installation method' });
  fireEvent.change(method, { target: { value: 'wsl' } });
  await controlChangeSettled(method);
  expect(lifecycle.disposed).toBe(1);
  await workspace.deepseek.read(async () => undefined);
  expect(targets()).toEqual(['native-windows', 'wsl Ubuntu']);

  fireEvent.click(ui.getByRole('button', { name: 'DeepSeek Harness installation' }));
  const distro = ui.getByRole('textbox', { name: 'WSL distro override' });
  fireEvent.input(distro, { target: { value: 'Debian' } });
  await waitFor(() => expect(lifecycle.disposed).toBe(2));
  await workspace.deepseek.read(async () => undefined);
  expect(targets()).toEqual(['native-windows', 'wsl Ubuntu', 'wsl Debian']);
});
