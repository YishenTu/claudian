/** @jest-environment jsdom */
import '@/providers';
import '@test/helpers/ObsidianSettingsDOM';

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { fireEvent, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

import { SettingsCoordinator } from '@/app/settings/SettingsCoordinator';
import * as ProcessProbe from '@/core/process/ProcessProbe';
import type * as CLIProbe from '@/core/providers/cli/CLIInstallationProbe';
import { probeCLIInstallation } from '@/core/providers/cli/CLIInstallationProbe';
import { getDeepSeekProviderSettings } from '@/providers/deepseek/settings';
import { createDeepSeekSettingsTabRenderer } from '@/providers/deepseek/ui/DeepSeekSettingsTab';

jest.mock('obsidian', () => {
  class Setting {
    settingEl: HTMLElement;
    controlEl: HTMLElement;
    constructor(container: HTMLElement) { this.settingEl = container.createDiv(); this.controlEl = this.settingEl; }
    setClass(value: string) { this.settingEl.addClass(value); return this; }
    setName(value: string) { this.settingEl.createDiv({ text: value }); return this; }
    setDesc(value: string) { this.settingEl.createDiv({ text: value }); return this; }
    setHeading() { return this; }
    addToggle(callback: (toggle: unknown) => void) {
      const toggleEl = this.settingEl.createEl('input', { attr: { type: 'checkbox', role: 'switch' } });
      const toggle = {
        toggleEl,
        setValue(value: boolean) { toggleEl.checked = value; return this; },
        setDisabled(value: boolean) { toggleEl.disabled = value; return this; },
        onChange(fn: (value: boolean) => Promise<void>) {
          toggleEl.addEventListener('change', () => { void fn(toggleEl.checked); });
          return this;
        },
      };
      callback(toggle);
      return this;
    }
    addTextArea(callback: (text: unknown) => void) {
      const inputEl = this.settingEl.createEl('textarea');
      const text = {
        inputEl,
        setPlaceholder(value: string) { inputEl.placeholder = value; return this; },
        setValue(value: string) { inputEl.value = value; return this; },
        onChange(fn: (value: string) => void) { inputEl.addEventListener('input', () => fn(inputEl.value)); return this; },
      };
      callback(text);
      return this;
    }
    addText(callback: (text: unknown) => void) {
      const inputEl = this.settingEl.createEl('input');
      const text = {
        inputEl,
        setPlaceholder(value: string) { inputEl.placeholder = value; return this; },
        setValue(value: string) { inputEl.value = value; return this; },
        onChange(fn: (value: string) => void) { inputEl.addEventListener('input', () => fn(inputEl.value)); return this; },
      };
      callback(text);
      return this;
    }
  }
  return { Setting, Modal: class {}, Notice: class {}, setIcon() {} };
});
jest.mock('@/core/device/InstallationKey', () => ({
  ...jest.requireActual('@/core/device/InstallationKey'),
  getInstallationKey: () => 'device:current',
}));
jest.mock('@/core/providers/cli/CLIInstallationProbe', () => ({
  probeCLIInstallation: jest.fn(async ({ path }: { path: string | null }) => ({ path, version: path ? '0.2.0-rc.2' : null, source: 'auto' })),
}));
jest.mock('@/shared/settings/ProviderModelsSection', () => ({ renderProviderModelsSection: () => ({ refresh: jest.fn() }) }));
jest.mock('@/shared/settings/EnvironmentSettingsSection', () => ({ renderEnvironmentSettingsSection: jest.fn() }));

function createHost(deepseekEnabled: boolean) {
  const transitions: string[][] = [];
  let transitionActive = false;
  const mutationsInsideTransition: boolean[] = [];
  const host: any = {
    settings: { providerConfigs: { claude: { enabled: !deepseekEnabled }, deepseek: { enabled: deepseekEnabled } } },
    storage: { installationKey: 'device:current' },
    getResolvedProviderCliPath: async () => null,
    mutateSettings: jest.fn(async (mutation: (settings: Record<string, unknown>) => void) => {
      mutationsInsideTransition.push(transitionActive);
      mutation(host.settings);
    }),
    runProviderExecutionTransition: jest.fn(async (providerIds: string[], run: () => Promise<unknown>) => {
      transitions.push(providerIds);
      transitionActive = true;
      try { return await run(); } finally { transitionActive = false; }
    }),
  };
  host.applyProviderRuntimeSettings = jest.fn(async (
    providerIds: string[], mutation: (settings: Record<string, unknown>) => void, onApplied?: () => void,
  ) => host.runProviderExecutionTransition(providerIds, async () => {
    await host.mutateSettings(mutation);
    onApplied?.();
  }));
  return { host, transitions, mutationsInsideTransition };
}

/** Lets on-demand module loading and the validation it gates settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

function render(deepseekEnabled = true, resolvedPath: string | null = null, configuredPath = '') {
  const fixture = createHost(deepseekEnabled);
  fixture.host.getResolvedProviderCliPath = async () => resolvedPath;
  fixture.host.settings.providerConfigs.deepseek.cliPathsByHost = { 'device:current': configuredPath };
  const cliResolver = { reset: jest.fn() };
  const container = document.body.createDiv();
  const context = { plugin: fixture.host, notifyProviderModelOptionsChanged: jest.fn(), renderCustomContextLimits: jest.fn() };
  createDeepSeekSettingsTabRenderer({ cliResolver: cliResolver as never, modelCatalog: {} as never })
    .render(container, context as never);
  return { ...fixture, cliResolver, context, container, ui: within(container) };
}

describe('DeepSeekSettingsTab', () => {
  afterEach(() => { document.body.replaceChildren(); });

  it('persists a return to the committed baseline after an earlier preset save finishes', async () => {
    const { host, ui, container } = render();
    let finish!: () => void;
    const saved: string[] = [];
    const first = new Promise<void>(resolve => { finish = resolve; });
    const coordinator = new SettingsCoordinator(host.settings, async settings => {
      saved.push(getDeepSeekProviderSettings(settings).presetPlugins);
      if (saved.length === 1) await first;
    });
    host.mutateSettings.mockImplementation((mutation: Parameters<typeof coordinator.mutate>[0]) => coordinator.mutate(mutation));
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
    const { host, ui, container } = render();
    let fail!: (cause: Error) => void;
    const persist = jest.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const coordinator = new SettingsCoordinator(host.settings, persist);
    host.mutateSettings.mockImplementation((mutation: Parameters<typeof coordinator.mutate>[0]) => coordinator.mutate(mutation));
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
    const cli = process.platform === 'win32' ? 'C:\\test\\resources\\runtime\\cli\\bin\\dsh.cmd' : `${app}/Contents/Resources/runtime/cli/bin/dsh`;
    const { ui, container } = render(true, cli, app);
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
    const actual = jest.requireActual<typeof CLIProbe>('@/core/providers/cli/CLIInstallationProbe');
    jest.mocked(probeCLIInstallation).mockImplementationOnce(actual.probeCLIInstallation);
    try {
      const { ui, container } = render(true, cli, app);
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
    const probe = jest.spyOn(ProcessProbe, 'runProcessProbe').mockResolvedValue('dsh 0.2.0-rc.9');
    const actual = jest.requireActual<typeof CLIProbe>('@/core/providers/cli/CLIInstallationProbe');
    jest.mocked(probeCLIInstallation).mockImplementationOnce(actual.probeCLIInstallation);
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
      const { ui } = render(true, command, command);
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
    const { host, container, ui } = render();
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
    const { host, transitions, mutationsInsideTransition, container, ui } = render();
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
    expect(mutationsInsideTransition).toEqual([true]);
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
    const { host, transitions, container, ui } = render();
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
    const { host, transitions, mutationsInsideTransition, cliResolver, ui } = render();
    cliResolver.reset.mockImplementation(() => {
      expect(getDeepSeekProviderSettings(host.settings).cliPathsByHost).toEqual({ 'device:current': '/opt/dsh' });
    });
    fireEvent.click(ui.getByRole('button', { name: 'DeepSeek Harness installation' }));
    const input = ui.getByRole('textbox', { name: 'CLI path' });
    fireEvent.input(input, { target: { value: ' /opt/dsh ' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(cliResolver.reset).toHaveBeenCalledTimes(1));
    expect(host.applyProviderRuntimeSettings).toHaveBeenCalledTimes(1);
    expect(transitions).toEqual([['deepseek']]);
    expect(mutationsInsideTransition).toEqual([true]);
    expect(getDeepSeekProviderSettings(host.settings).cliPathsByHost).toEqual({ 'device:current': '/opt/dsh' });
  });

  it('commits enablement inside the DeepSeek execution transition', async () => {
    const { host, transitions, mutationsInsideTransition, context, ui } = render(false);
    const toggle = ui.getByRole('switch', { name: 'Enable DeepSeek Harness' }) as HTMLInputElement;

    fireEvent.click(toggle);
    await waitFor(() => expect(getDeepSeekProviderSettings(host.settings).enabled).toBe(true));
    expect(transitions).toEqual([['deepseek']]);
    expect(mutationsInsideTransition).toEqual([true]);
    await waitFor(() => expect(context.notifyProviderModelOptionsChanged).toHaveBeenCalledWith('deepseek'));
    expect(toggle.checked).toBe(true);

    host.settings.providerConfigs.claude.enabled = false;
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.checked).toBe(true));
    expect(getDeepSeekProviderSettings(host.settings).enabled).toBe(true);
    expect(transitions).toEqual([['deepseek']]);
  });
});
