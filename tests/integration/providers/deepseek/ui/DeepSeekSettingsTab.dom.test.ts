// @test-ci {"native":true}
/** @vitest-environment jsdom */
import '@/providers';

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { axe } from '@test/helpers/accessibility';
import { createProviderHostFixture } from '@test/helpers/providerRuntimeHost';
import { fireEvent, waitFor, within } from '@testing-library/dom';

import { getInstallationKey } from '@/core/device/InstallationKey';
import type { ProviderExecutionTransitionScope } from '@/core/execution';
import * as ProcessProbe from '@/core/process/ProcessProbe';
import * as CLIProbe from '@/core/providers/cli/CLIInstallationProbe';
import type { ProviderId } from '@/core/providers/types';
import type { ClaudianSettings } from '@/core/types';
import { DeepSeekCLIResolver } from '@/providers/deepseek/runtime/DeepSeekCLIResolver';
import { createDeepSeekModels } from '@/providers/deepseek/runtime/DeepSeekModels';
import { getDeepSeekProviderSettings, updateDeepSeekProviderSettings } from '@/providers/deepseek/settings';
import { createDeepSeekSettingsTabRenderer } from '@/providers/deepseek/ui/DeepSeekSettingsTab';

const deviceKey = getInstallationKey();
/** Observe the real probe completion before starting the DOM-render assertion deadline. */
function observeActualCLIProbe(): Promise<CLIProbe.CLIInstallation> {
  const probe = CLIProbe.probeCLIInstallation;
  return new Promise(resolve => {
    vi.spyOn(CLIProbe, 'probeCLIInstallation').mockImplementationOnce(options => {
      const pending = probe(options);
      resolve(pending);
      return pending;
    });
  });
}

async function createHost(deepseekEnabled: boolean) {
  const transitions: string[][] = [];
  let transitionActive = false;
  const mutationsInsideTransition: boolean[] = [];
  const persist = vi.fn(async (_settings: ClaudianSettings): Promise<void> => undefined);
  const fixture = await createProviderHostFixture({
    settings: { providerConfigs: { claude: { enabled: !deepseekEnabled }, deepseek: { enabled: deepseekEnabled } } },
    beforePersist: async settings => { mutationsInsideTransition.push(transitionActive); await persist(settings); },
  });
  const transition = fixture.lifecycle.runTransition.bind(fixture.lifecycle);
  vi.spyOn(fixture.lifecycle, 'runTransition').mockImplementation(async <T>(ids: ProviderId[], run: (scope: ProviderExecutionTransitionScope) => Promise<T>, parent?: ProviderExecutionTransitionScope): Promise<T> => {
    transitions.push(ids);
    return transition(ids, async scope => {
      transitionActive = true;
      try { return await run(scope); } finally { transitionActive = false; }
    }, parent);
  });
  vi.spyOn(fixture.host, 'runProviderExecutionTransition');
  vi.spyOn(fixture.host, 'applyProviderRuntimeSettings');
  return { ...fixture, persist, transitions, mutationsInsideTransition };
}

/** Lets on-demand module loading and the validation it gates settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

async function render(deepseekEnabled = true, resolvedPath: string | null = null, configuredPath = '') {
  const fixture = await createHost(deepseekEnabled);
  fixture.host.getResolvedProviderCliPath = async () => resolvedPath;
  updateDeepSeekProviderSettings(fixture.host.settings, { cliPathsByHost: { [deviceKey]: configuredPath } });
  const cliResolver = new DeepSeekCLIResolver();
  vi.spyOn(cliResolver, 'reset');
  const modelCatalog = createDeepSeekModels(fixture.host.getRuntimeHost('deepseek'), async () => []);
  const container = document.body.createDiv();
  const context = { plugin: fixture.host, notifyProviderModelOptionsChanged: vi.fn(), renderCustomContextLimits: vi.fn() };
  const view = createDeepSeekSettingsTabRenderer({ cliResolver, modelCatalog }).render(container, context);
  await modelCatalog.refresh();
  fixture.persist.mockClear(); fixture.mutationsInsideTransition.length = 0;
  onTestFinished(async () => { view?.dispose(); await modelCatalog.dispose(); });
  return { ...fixture, cliResolver, context, container, ui: within(container) };
}

describe('DeepSeekSettingsTab', () => {
  afterEach(() => { document.body.replaceChildren(); });

  it('persists a return to the committed baseline after an earlier preset save finishes', async () => {
    const { host, persist, ui, container } = await render();
    let finish!: () => void;
    const saved: string[] = [];
    const first = new Promise<void>(resolve => { finish = resolve; });
    persist.mockImplementation(async settings => {
      saved.push(getDeepSeekProviderSettings(settings).presetPlugins);
      if (saved.length === 1) await first;
    });
    const field = ui.getByRole('textbox', { name: 'Additional preset plugins' });
    const rows = '- id: tool-todo\n  name: "@deepseek-ai/dsh-tool-todo"\n';
    fireEvent.change(field, { target: { value: rows } });
    await waitFor(() => expect(saved).toEqual([rows]));
    fireEvent.change(field, { target: { value: '' } });
    finish();
    await waitFor(() => expect(saved).toEqual([rows, '']));
    await waitFor(() => expect(getDeepSeekProviderSettings(host.settings).presetPlugins).toBe(''));
    expect(ui.queryByRole('alert')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('keeps the latest validation error when an older preset persistence attempt rejects', async () => {
    const { host, persist, ui, container } = await render();
    let fail!: (cause: Error) => void;
    persist.mockImplementation(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const field = ui.getByRole('textbox', { name: 'Additional preset plugins' });
    fireEvent.change(field, { target: { value: '- id: tool-todo\n  name: "@deepseek-ai/dsh-tool-todo"\n' } });
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    fireEvent.change(field, { target: { value: '- id: tool-fs\n  name: "@deepseek-ai/dsh-tool-fs"\n' } });
    expect(ui.getByRole('alert').textContent).toContain('tool-fs');
    fail(new Error('Older persistence failed'));
    await settle();
    expect(ui.getByRole('alert').textContent).toContain('tool-fs');
    expect(getDeepSeekProviderSettings(host.settings).presetPlugins).toBe('');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('shows a selected Desktop app with installation instructions under its CLI path', async () => {
    const app = process.platform === 'win32' ? 'C:\\test\\DeepSeek Harness.exe' : '/test/DeepSeek Harness.app';
    const cli = process.execPath;
    const { ui, container } = await render(true, cli, app);
    fireEvent.click(ui.getByRole('button', { name: 'DeepSeek Harness installation' }));
    const input = ui.getByRole('textbox', { name: 'CLI path' }) as HTMLInputElement;
    expect(input.value).toBe(app);
    const instructions = ui.getByText(/Auto prefers dsh/);
    expect(input.compareDocumentPosition(instructions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(input.closest('.claudian-cli-installation-body')?.contains(instructions)).toBe(true);
    expect(await ui.findByText('Custom path')).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('reads the Desktop CLI version through its bundled runtime without executing the launcher', async () => {
    const windows = process.platform === 'win32';
    const root = mkdtempSync(join(tmpdir(), 'deepseek settings '));
    const app = join(root, windows ? 'Desktop' : 'DeepSeek Harness.app');
    const resources = join(app, windows ? 'resources' : 'Contents/Resources');
    const cli = join(resources, 'runtime/cli/bin', windows ? 'dsh.cmd' : 'dsh');
    const executable = join(app, windows ? 'DeepSeek Harness.exe' : 'Contents/MacOS/DeepSeek Harness');
    const packageRoot = join(resources, 'app.asar/dsh/node_modules/@deepseek-ai/dsh');
    const bin = join(packageRoot, 'lib/bin.js');
    const log = join(root, 'wrapper.log');
    for (const file of [cli, executable, bin]) mkdirSync(dirname(file), { recursive: true });
    writeFileSync(cli, windows ? `@echo invoked > "${log}"\r\n@exit /b 9\r\n` : `#!/bin/sh\nprintf invoked > '${log}'\nexit 9\n`);
    if (windows) copyFileSync(process.execPath, executable);
    else writeFileSync(executable, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`);
    for (const file of [cli, executable]) chmodSync(file, 0o700);
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }));
    writeFileSync(bin, `if (process.env.ELECTRON_RUN_AS_NODE !== '1' || process.argv[2] !== '--version') process.exit(9); console.log('dsh 0.2.0-rc.9');`);
    const probeFinished = observeActualCLIProbe();
    try {
      const { ui, container } = await render(true, cli, app);
      await probeFinished;
      await waitFor(() => expect(ui.getByText('Custom path')).toBeTruthy());
      expect(ui.getByText('v0.2.0-rc.9')).toBeTruthy();
      expect(() => readFileSync(log, 'utf8')).toThrow();
      expect(await axe(container)).toHaveNoViolations();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    ['desktop', false], ['cmd', false], ['ps1', false], ['desktop', true],
  ] as const)('inspects Windows %s through its native Node entry without spawning a command shim (directory alias: %s)', async (kind, useAlias) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const root = mkdtempSync(join(tmpdir(), 'deepseek windows probe '));
    const fixtureRoot = useAlias ? join(root, 'alias') : root;
    if (useAlias) {
      const target = join(root, 'native');
      mkdirSync(target);
      symlinkSync(target, fixtureRoot, 'junction');
    }
    const install = join(fixtureRoot, 'Desktop');
    const resources = join(install, 'resources');
    const packageRoot = kind === 'desktop' ? join(resources, 'app.asar/dsh/node_modules/@deepseek-ai/dsh') : join(root, 'node_modules/@deepseek-ai/dsh');
    const bin = join(packageRoot, 'lib/bin.js');
    const command = kind === 'desktop' ? join(resources, 'runtime/cli/bin/dsh.cmd') : join(root, `dsh.${kind}`);
    const cmdShim = kind === 'desktop' ? command : join(root, 'dsh.cmd');
    const executable = join(install, 'DeepSeek Harness.exe');
    for (const file of [bin, command, executable]) mkdirSync(dirname(file), { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', bin: { dsh: 'lib/bin.js' } }));
    writeFileSync(bin, '#!/usr/bin/env node\n');
    writeFileSync(executable, 'native runtime boundary');
    writeFileSync(cmdShim, `@node "${bin}" %*\r\n`);
    if (kind === 'ps1') writeFileSync(command, '# PowerShell launcher boundary');
    for (const file of [command, cmdShim, executable]) chmodSync(file, 0o700);
    const probe = vi.spyOn(ProcessProbe, 'runProcessProbe').mockResolvedValue('dsh 0.2.0-rc.9');
    const probeFinished = observeActualCLIProbe();
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      const { ui } = await render(true, command, command);
      await probeFinished;
      await waitFor(() => expect(ui.getByText('Custom path')).toBeTruthy());
      expect(ui.getByText('v0.2.0-rc.9')).toBeTruthy();
      const [spec] = probe.mock.calls[0];
      expect(spec.command).not.toBe(command);
      expect(spec.directSpawn).toBe(true);
      // Desktop discovery resolves directory aliases, including macOS's temporary directory.
      const entry = kind === 'desktop' ? realpathSync(bin) : bin;
      expect(spec.args).toEqual([...(kind === 'desktop' ? ['--expose-internals'] : []), entry, '--version']);
      const nodeCommand = expect.stringMatching(/node(?:\.exe)?$/);
      expect(spec.command).toEqual(kind === 'desktop' ? realpathSync(executable) : nodeCommand);
      expect(spec.env.ELECTRON_RUN_AS_NODE).toBe(kind === 'desktop' ? '1' : process.env.ELECTRON_RUN_AS_NODE);
    } finally {
      Object.defineProperty(process, 'platform', platform);
      probe.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists the code-mode preference from its accessibly named switch', async () => {
    const { host, container, ui } = await render();
    const toggle = ui.getByRole('switch', { name: 'Enable code mode' }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    fireEvent.click(toggle);
    await waitFor(() => expect(getDeepSeekProviderSettings(host.settings).codeMode).toBe(true));
    fireEvent.click(toggle);
    await waitFor(() => expect(getDeepSeekProviderSettings(host.settings).codeMode).toBe(false));
    expect(host.runProviderExecutionTransition).not.toHaveBeenCalled();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('previews the effective chat preset and applies valid additional plugin rows as a provider runtime change', async () => {
    const { host, transitions, mutationsInsideTransition, container, ui } = await render();
    const preview = () => ui.getByText(/id: claudian-compatibility/).textContent ?? '';
    expect(ui.getByText('Preset preview', { selector: 'summary' })).toBeTruthy();
    await waitFor(() => expect(preview()).toContain('id: tool-ask-user'));
    expect(preview()).not.toContain('tool-todo');
    const field = ui.getByRole('textbox', { name: 'Additional preset plugins' }) as HTMLTextAreaElement;

    const rows = '- id: tool-todo\n  name: "@deepseek-ai/dsh-tool-todo"\n';
    fireEvent.input(field, { target: { value: rows } });
    // Typing alone never restarts DeepSeek; the edit applies once committed.
    expect(transitions).toEqual([]);
    fireEvent.change(field);
    await waitFor(() => expect(getDeepSeekProviderSettings(host.settings).presetPlugins).toBe(rows));
    expect(transitions).toEqual([['deepseek']]);
    expect(mutationsInsideTransition.length).toBeGreaterThan(0);
    expect(mutationsInsideTransition.every(Boolean)).toBe(true);
    await waitFor(() => expect(preview()).toContain('id: tool-todo'));
    expect(ui.queryByRole('alert')).toBeNull();
    expect(field.getAttribute('aria-invalid')).toBeNull();

    // An unchanged commit does not restart the Host again, even once its validation has settled.
    fireEvent.change(field);
    await settle();
    expect(transitions).toEqual([['deepseek']]);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('keeps invalid additional plugin rows out of settings and explains why', async () => {
    const { host, transitions, container, ui } = await render();
    const field = ui.getByRole('textbox', { name: 'Additional preset plugins' }) as HTMLTextAreaElement;
    fireEvent.input(field, { target: { value: '- id: tool-fs\n  name: "@deepseek-ai/dsh-tool-fs"\n' } });
    fireEvent.change(field);
    expect((await ui.findByRole('alert')).textContent).toMatch(/"tool-fs"/);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.value).toContain('tool-fs');
    expect(getDeepSeekProviderSettings(host.settings).presetPlugins).toBe('');
    expect(transitions).toEqual([]);
    expect(await axe(container)).toHaveNoViolations();

    // Clearing the field is valid and clears the explanation without a restart, since nothing saved changed.
    fireEvent.input(field, { target: { value: '' } });
    fireEvent.change(field);
    await waitFor(() => expect(ui.queryByRole('alert')).toBeNull());
    await settle();
    expect(field.getAttribute('aria-invalid')).toBeNull();
    expect(transitions).toEqual([]);
  });

  it('applies a CLI path for this computer as a provider runtime change and resets resolution afterwards', async () => {
    const { host, transitions, mutationsInsideTransition, cliResolver, ui } = await render();
    const pathsAtReset: Array<Record<string, string>> = [];
    vi.mocked(cliResolver.reset).mockImplementation(() => {
      pathsAtReset.push({ ...getDeepSeekProviderSettings(host.settings).cliPathsByHost });
    });
    fireEvent.click(ui.getByRole('button', { name: 'DeepSeek Harness installation' }));
    const input = ui.getByRole('textbox', { name: 'CLI path' });
    fireEvent.input(input, { target: { value: ' /opt/dsh ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(cliResolver.reset).toHaveBeenCalledTimes(1));
    expect(pathsAtReset).toEqual([{ [deviceKey]: '/opt/dsh' }]);
    expect(host.applyProviderRuntimeSettings).toHaveBeenCalledTimes(1);
    expect(transitions).toEqual([['deepseek']]);
    expect(mutationsInsideTransition.length).toBeGreaterThan(0);
    expect(mutationsInsideTransition.every(Boolean)).toBe(true);
    expect(getDeepSeekProviderSettings(host.settings).cliPathsByHost).toEqual({ [deviceKey]: '/opt/dsh' });
  });

  it('commits enablement inside the DeepSeek execution transition', async () => {
    const { host, transitions, mutationsInsideTransition, context, ui } = await render(false);
    const toggle = ui.getByRole('switch', { name: 'Enable DeepSeek Harness' }) as HTMLInputElement;

    fireEvent.click(toggle);
    await waitFor(() => expect(getDeepSeekProviderSettings(host.settings).enabled).toBe(true));
    expect(transitions).toEqual([['deepseek']]);
    expect(mutationsInsideTransition.length).toBeGreaterThan(0);
    expect(mutationsInsideTransition.every(Boolean)).toBe(true);
    await waitFor(() => expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('deepseek'));
    expect(toggle.checked).toBe(true);

    host.settings.providerConfigs.claude = { ...host.settings.providerConfigs.claude, enabled: false };
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(getDeepSeekProviderSettings(host.settings).enabled).toBe(true);
    expect(transitions).toEqual([['deepseek']]);
  });
});
