/** @vitest-environment jsdom */

import { controlChangeSettled } from '@test/helpers/ObsidianSettingsDOM';
import { fireEvent, within } from '@testing-library/dom';

vi.mock('obsidian', async () => vi.importActual('@test/helpers/ObsidianSettingsDOM'));

import { renderHostnameCLIPathSetting } from '@/shared/settings/HostnameCLIPathSetting';
import { renderProviderEnablementSetting } from '@/shared/settings/ProviderEnablementSetting';

describe('provider settings controls', () => {
  afterEach(() => { document.body.replaceChildren(); });

  it('renders enablement state and resynchronizes after callback side effects', async () => {
    const events: string[] = [];
    let persisted = true;
    const container = document.body.createDiv();
    const control = renderProviderEnablementSetting({
      container,
      description: 'Provider-specific description',
      getValue: () => {
        events.push('read');
        return persisted;
      },
      name: 'Enable Test Provider',
      onChange: async (enabled) => {
        events.push(`change:${enabled}`);
        persisted = enabled;
      },
    });
    const toggle = within(container).getByRole<HTMLInputElement>('switch', { name: 'Enable Test Provider' });

    expect(toggle.checked).toBe(true);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    events.length = 0;

    toggle.click();
    await controlChangeSettled(toggle);

    expect(events).toEqual(['change:false', 'read']);
    expect(toggle.checked).toBe(false);
    expect(control.toggle.getValue()).toBe(false);
    expect(toggle.getAttribute('aria-checked')).toBe('false');
  });

  it('does not invoke enablement callbacks while disabled', async () => {
    const onChange = vi.fn();
    const container = document.body.createDiv();
    const control = renderProviderEnablementSetting({
      container,
      description: 'Description',
      disabled: true,
      getValue: () => true,
      name: 'Enable Test Provider',
      onChange,
    });
    const toggle = within(container).getByRole<HTMLInputElement>('switch', { name: 'Enable Test Provider' });

    expect(toggle.disabled).toBe(true);
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    toggle.click();
    await controlChangeSettled(toggle);
    // Programmatic host updates also reach the disabled callback guard.
    control.toggle.setValue(false);
    await controlChangeSettled(toggle);
    expect(onChange).not.toHaveBeenCalled();
    expect(toggle.checked).toBe(true);
    expect(control.toggle.getValue()).toBe(true);
  });

  it('renders and edits the current-host CLI path, including clearing', async () => {
    const changes: string[] = [];
    let persistedPath = '/initial/provider';
    const container = document.body.createDiv();
    renderHostnameCLIPathSetting({
      container,
      description: 'Provider-specific CLI description',
      getValue: () => persistedPath,
      name: 'CLI path',
      onChange: async (value) => {
        changes.push(value);
        persistedPath = value;
      },
      placeholder: '/usr/local/bin/provider',
    });
    const text = within(container).getByRole<HTMLInputElement>('textbox', { name: 'CLI path' });

    expect(text.value).toBe('/initial/provider');
    expect(text.placeholder).toBe('/usr/local/bin/provider');
    expect(text.getAttribute('aria-label')).toBe('CLI path');

    fireEvent.input(text, { target: { value: ' /custom/provider ' } });
    await controlChangeSettled(text);
    fireEvent.input(text, { target: { value: '' } });
    await controlChangeSettled(text);

    expect(changes).toEqual(['/custom/provider', '']);
    expect(text.value).toBe('');
  });

  it('validates before callbacks and suppresses duplicate persistence', async () => {
    const events: string[] = [];
    let persistedPath = '/initial/provider';
    const container = document.body.createDiv();
    const control = renderHostnameCLIPathSetting({
      container,
      description: 'Description',
      getValue: () => persistedPath,
      name: 'CLI path',
      onChange: async (value) => {
        events.push(`change:${value}`);
        persistedPath = value;
      },
      placeholder: '/bin/provider',
      validate: (value) => {
        events.push(`validate:${value}`);
        return value.includes('invalid') ? 'Invalid path' : null;
      },
    });
    const text = within(container).getByRole<HTMLInputElement>('textbox', { name: 'CLI path' });
    events.length = 0;

    fireEvent.input(text, { target: { value: '/initial/provider' } });
    await controlChangeSettled(text);
    fireEvent.input(text, { target: { value: '/invalid/provider' } });
    await controlChangeSettled(text);

    expect(events).toEqual([
      'validate:/initial/provider',
      'validate:/invalid/provider',
    ]);
    expect(control.validationEl.textContent).toBe('Invalid path');
    expect(control.validationEl.classList.contains('claudian-hidden')).toBe(false);
    expect(text.classList.contains('claudian-input-error')).toBe(true);
  });

  it('supports disabled CLI controls and dynamic presentation updates', async () => {
    const onChange = vi.fn();
    const container = document.body.createDiv();
    const control = renderHostnameCLIPathSetting({
      container,
      description: 'Initial description',
      disabled: true,
      getValue: () => '',
      name: 'CLI path',
      onChange,
      placeholder: '/bin/provider',
    });
    const text = within(container).getByRole<HTMLInputElement>('textbox', { name: 'CLI path' });

    expect(text.disabled).toBe(true);
    expect(text.getAttribute('aria-disabled')).toBe('true');
    fireEvent.input(text, { target: { value: '/custom/provider' } });
    await controlChangeSettled(text);
    expect(onChange).not.toHaveBeenCalled();

    control.setDisabled(false);
    control.setDescription('Updated description');
    control.setPlaceholder('/updated/provider');

    expect(text.disabled).toBe(false);
    expect(text.getAttribute('aria-disabled')).toBe('false');
    expect(text.placeholder).toBe('/updated/provider');
    expect(within(container).getByText('Updated description')).toBeDefined();
  });
});
