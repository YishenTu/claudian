/** @jest-environment jsdom */

import { fireEvent, isInaccessible, waitFor, within } from '@testing-library/dom';
import { axe } from 'jest-axe';

jest.mock('obsidian', () => {
  class Setting {
    settingEl: HTMLElement;
    descEl: HTMLElement;
    constructor(container: HTMLElement) {
      this.settingEl = container.createDiv();
      this.descEl = this.settingEl.createDiv();
    }
    setName() { return this; }
    setClass(value: string) { this.settingEl.classList.add(value); return this; }
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
    setHeading() { return this; }
    addTextArea(callback: (text: unknown) => void) { return this.addInput('textarea', callback); }
    setDesc(value: string) { this.descEl.textContent = value; return this; }
    addText(callback: (text: unknown) => void) { return this.addInput('input', callback); }
    addInput(tag: 'input' | 'textarea', callback: (text: unknown) => void) {
      const inputEl = this.settingEl.createEl(tag);
      const text = {
        inputEl,
        setPlaceholder(value: string) { inputEl.placeholder = value; return this; },
        setValue(value: string) { inputEl.value = value; return this; },
        onChange(fn: (value: string) => void) {
          inputEl.addEventListener('input', () => fn(inputEl.value));
          return this;
        },
      };
      callback(text);
      return this;
    }
  }
  return { Setting, Modal: class {}, Notice: class {}, setIcon() {} };
});

import type { ProviderHost } from '@/core/providers/ProviderHost';
import { renderCLIInstallationSetting } from '@/shared/settings/CLIInstallationSetting';
import { renderEnvironmentSettingsSection } from '@/shared/settings/EnvironmentSettingsSection';

describe('CLI installation setting', () => {
  it('shows detected installation while collapsed and saves a manual path on blur', async () => {
    const container = document.body.createDiv();
    let saved = '';
    renderCLIInstallationSetting({
      container,
      cliName: 'Codex CLI',
      name: 'Binary path',
      placeholder: 'Detected automatically',
      getValue: () => saved,
      onChange: (value) => { saved = value; },
      inspect: async () => ({ path: saved || '/opt/bin/codex', version: '0.153.4', source: saved ? 'custom' : 'auto' }),
    });
    const ui = within(container);
    const disclosure = ui.getByRole('button', { name: 'Codex CLI installation' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(ui.queryByRole('textbox')).toBeNull();
    await waitFor(() => expect(ui.getByRole('status').textContent).toBe('Auto-detected'));
    expect(isInaccessible(ui.getByText('/opt/bin/codex'))).toBe(true);
    expect(ui.getByText('v0.153.4')).toBeTruthy();
    expect(isInaccessible(ui.getByRole('status'))).toBe(false);
    fireEvent.click(disclosure);
    const input = ui.getByRole('textbox', { name: 'Binary path' });
    expect(isInaccessible(ui.getByText('/opt/bin/codex'))).toBe(false);
    fireEvent.input(input, { target: { value: ' /custom/codex ' } });
    expect(saved).toBe('');
    fireEvent.blur(input);
    await waitFor(() => expect(saved).toBe('/custom/codex'));
    await waitFor(() => expect(ui.getByRole('status').textContent).toBe('Custom path'));
    expect(isInaccessible(ui.getByText('/custom/codex'))).toBe(false);
    fireEvent.input(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(saved).toBe(''));
    await waitFor(() => expect(ui.getByRole('status').textContent).toBe('Auto-detected'));
    expect(await axe(container)).toHaveNoViolations();
    container.remove();
  });
});

describe('CLI installation feedback', () => {
  let container: HTMLElement;
  beforeEach(() => { container = document.body.createDiv(); });
  afterEach(() => { container.remove(); });

  function render(overrides: Partial<Parameters<typeof renderCLIInstallationSetting>[0]> = {}) {
    return renderCLIInstallationSetting({
      container,
      cliName: 'Test CLI',
      name: 'Binary path',
      placeholder: 'Detected automatically',
      getValue: () => '',
      onChange: () => {},
      inspect: async () => ({ path: null, version: null, source: 'auto' }),
      ...overrides,
    });
  }

  function expand() {
    fireEvent.click(within(container).getByRole('button', { name: 'Test CLI installation' }));
    return within(container).getByRole('textbox', { name: 'Binary path' });
  }

  it('keeps enablement available in the collapsed card without opening the path editor', async () => {
    let enabled = false;
    render({ enablement: {
      name: 'Enable Test', getValue: () => enabled,
      onChange: value => { enabled = value; },
    } });
    const ui = within(container);
    const toggle = ui.getByRole('switch', { name: 'Enable Test' });
    fireEvent.click(toggle);
    await waitFor(() => expect(enabled).toBe(true));
    expect(ui.getByRole('button', { name: 'Test CLI installation' }).getAttribute('aria-expanded')).toBe('false');
    expect(ui.queryByRole('textbox')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
    expand();
    expect(isInaccessible(ui.getByText('Optional CLI path for this computer. Leave empty to detect automatically.'))).toBe(false);
  });

  it('distinguishes a missing binary from an unavailable version', async () => {
    let found = false;
    const control = render({ inspect: async () => ({ path: found ? '/opt/test' : null, version: null, source: 'auto' }) });
    const ui = within(container);
    await waitFor(() => expect(ui.getByRole('status').textContent).toBe('Not found'));
    expect(isInaccessible(ui.getByRole('status'))).toBe(false);
    expect(container.querySelector('[data-state="missing"]')).toBeTruthy();
    found = true;
    void control.refresh();
    await waitFor(() => expect(ui.getByText('Version unavailable')).toBeTruthy());
    expect(ui.getByRole('status').textContent).toBe('Auto-detected');
    expect(container.querySelector('[data-state="found"]')).toBeTruthy();
  });

  it('reports validation errors accessibly and leaves saved settings unchanged', async () => {
    let saved = '';
    render({
      getValue: () => saved,
      onChange: value => { saved = value; },
      validate: value => value ? 'Path does not exist' : null,
    });
    const input = expand();
    fireEvent.input(input, { target: { value: '/missing/test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(saved).toBe('');
    expect(within(container).getByRole('alert').textContent).toBe('Path does not exist');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('ignores an older detection result after applying another path', async () => {
    let saved = '';
    let resolveInitial!: (value: { path: string; version: string; source: 'auto' }) => void;
    const initial = new Promise<{ path: string; version: string; source: 'auto' }>(resolve => { resolveInitial = resolve; });
    render({
      getValue: () => saved,
      onChange: value => { saved = value; },
      inspect: () => saved ? Promise.resolve({ path: saved, version: '2.0.0', source: 'custom' }) : initial,
    });
    const input = expand();
    fireEvent.input(input, { target: { value: '/new/test' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(within(container).getByText('/new/test')).toBeTruthy());
    resolveInitial({ path: '/old/test', version: '1.0.0', source: 'auto' });
    await initial;
    expect(within(container).getByText('/new/test')).toBeTruthy();
    expect(within(container).queryByText('/old/test')).toBeNull();
  });

  it('keeps the draft and shows a save error so the user can retry', async () => {
    let saved = '';
    let fail = true;
    render({
      getValue: () => saved,
      onChange: value => {
        if (fail) throw new Error('Storage unavailable');
        saved = value;
      },
    });
    const input = expand() as HTMLInputElement;
    fireEvent.input(input, { target: { value: '/custom/test' } });
    fireEvent.blur(input);
    await waitFor(() => expect(within(container).getByRole('alert').textContent).toBe('Could not save the path. Try again.'));
    expect(input.value).toBe('/custom/test');
    expect(saved).toBe('');
    fail = false;
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(saved).toBe('/custom/test'));
  });
});


describe('CLI installation environment updates', () => {
  beforeAll(() => {
    HTMLElement.prototype.addClass = function (...classes) { this.classList.add(...classes); };
    HTMLElement.prototype.toggleClass = function (classes, value) {
      for (const name of typeof classes === 'string' ? [classes] : classes) this.classList.toggle(name, value);
    };
    HTMLElement.prototype.empty = function () { this.replaceChildren(); };
  });
  it.each(['typing', 'snippet'] as const)('refreshes sibling provider cards after a shared PATH update via %s', async (method) => {
    const root = document.body.createDiv({ cls: 'claudian-settings' });
    const providers = root.createDiv();
    const general = root.createDiv();
    let envText = '';
    const plugin = {
      settings: { envSnippets: [{ id: 'test', name: 'New path', scope: 'shared', envVars: 'PATH=/new/bin' }] },
      app: { workspace: { getLeavesOfType: () => [] } },
      getEnvironmentVariablesForScope: () => envText,
      applyEnvironmentVariables: async (_scope: string, value: string) => { envText = value; },
      mutateSettings: async (fn: (settings: unknown) => void) => fn(plugin.settings),
    } as unknown as ProviderHost;
    renderCLIInstallationSetting({
      container: providers,
      cliName: 'Test CLI', name: 'Binary path', placeholder: '',
      getValue: () => '', onChange: () => {},
      inspect: async () => ({ path: envText ? '/new/bin/test' : '/old/bin/test', version: '1.0.0', source: 'auto' }),
    });
    fireEvent.click(within(providers).getByRole('button', { name: 'Test CLI installation' }));
    renderEnvironmentSettingsSection({ container: general, plugin, scope: 'shared', name: 'Environment', desc: '', placeholder: 'PATH=...' });
    await waitFor(() => expect(within(providers).getByText('/old/bin/test')).toBeTruthy());
    if (method === 'typing') {
      const textarea = within(general).getByRole('textbox');
      fireEvent.input(textarea, { target: { value: 'PATH=/new/bin' } });
      fireEvent.blur(textarea);
    } else {
      fireEvent.click(within(general).getByRole('button', { name: 'Insert' }));
    }
    await waitFor(() => expect(within(providers).getByText('/new/bin/test')).toBeTruthy());
    root.remove();
  });
});
