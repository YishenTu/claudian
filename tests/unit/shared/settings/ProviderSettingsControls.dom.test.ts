/** @jest-environment jsdom */

jest.mock('obsidian', () => {
  class MockToggleComponent {
    disabled = false;
    toggleEl = document.createElement('button');
    value = false;
    private callback: ((value: boolean) => Promise<void> | void) | null = null;

    onChange(callback: (value: boolean) => Promise<void> | void): this {
      this.callback = callback;
      return this;
    }

    setDisabled(disabled: boolean): this {
      this.disabled = disabled;
      this.toggleEl.disabled = disabled;
      return this;
    }

    setValue(value: boolean): this {
      this.value = value;
      return this;
    }

    async trigger(value: boolean): Promise<void> {
      await this.callback?.(value);
    }
  }

  class MockTextComponent {
    inputEl = document.createElement('input');
    value = '';
    private callback: ((value: string) => Promise<void> | void) | null = null;

    onChange(callback: (value: string) => Promise<void> | void): this {
      this.callback = callback;
      return this;
    }

    setPlaceholder(value: string): this {
      this.inputEl.placeholder = value;
      return this;
    }

    setValue(value: string): this {
      this.value = value;
      this.inputEl.value = value;
      return this;
    }

    async trigger(value: string): Promise<void> {
      this.inputEl.value = value;
      await this.callback?.(value);
    }
  }

  class MockSetting {
    desc = '';
    name = '';
    settingEl = document.createElement('div');

    constructor(container: HTMLElement) {
      container.appendChild(this.settingEl);
    }

    addText(callback: (text: MockTextComponent) => void): this {
      callback(new MockTextComponent());
      return this;
    }

    addToggle(callback: (toggle: MockToggleComponent) => void): this {
      callback(new MockToggleComponent());
      return this;
    }

    setDesc(desc: string): this {
      this.desc = desc;
      return this;
    }

    setName(name: string): this {
      this.name = name;
      return this;
    }
  }

  return { Setting: MockSetting };
});

import { renderHostnameCliPathSetting } from '@/shared/settings/HostnameCliPathSetting';
import { renderProviderEnablementSetting } from '@/shared/settings/ProviderEnablementSetting';

interface TriggerableToggle {
  disabled: boolean;
  toggleEl: HTMLButtonElement;
  trigger(value: boolean): Promise<void>;
  value: boolean;
}

interface TriggerableText {
  inputEl: HTMLInputElement;
  trigger(value: string): Promise<void>;
  value: string;
}

describe('provider settings controls', () => {
  it('renders enablement state and resynchronizes after callback side effects', async () => {
    const events: string[] = [];
    let persisted = true;
    const control = renderProviderEnablementSetting({
      container: document.createElement('div'),
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
    const toggle = control.toggle as unknown as TriggerableToggle;

    expect(toggle.value).toBe(true);
    expect(toggle.toggleEl.getAttribute('aria-label')).toBe('Enable Test Provider');
    events.length = 0;

    await toggle.trigger(false);

    expect(events).toEqual(['change:false', 'read']);
    expect(toggle.value).toBe(false);
  });

  it('does not invoke enablement callbacks while disabled', async () => {
    const onChange = jest.fn();
    const control = renderProviderEnablementSetting({
      container: document.createElement('div'),
      description: 'Description',
      disabled: true,
      getValue: () => true,
      name: 'Enable Test Provider',
      onChange,
    });
    const toggle = control.toggle as unknown as TriggerableToggle;

    expect(toggle.disabled).toBe(true);
    expect(toggle.toggleEl.getAttribute('aria-disabled')).toBe('true');
    await toggle.trigger(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(toggle.value).toBe(true);
  });

  it('renders and edits the current-host CLI path, including clearing', async () => {
    const changes: string[] = [];
    let persistedPath = '/initial/provider';
    const control = renderHostnameCliPathSetting({
      container: document.createElement('div'),
      description: 'Provider-specific CLI description',
      getValue: () => persistedPath,
      name: 'CLI path',
      onChange: async (value) => {
        changes.push(value);
        persistedPath = value;
      },
      placeholder: '/usr/local/bin/provider',
    });
    const text = control.text as unknown as TriggerableText;

    expect(text.value).toBe('/initial/provider');
    expect(text.inputEl.placeholder).toBe('/usr/local/bin/provider');
    expect(text.inputEl.getAttribute('aria-label')).toBe('CLI path');

    await text.trigger(' /custom/provider ');
    await text.trigger('');

    expect(changes).toEqual(['/custom/provider', '']);
    expect(text.value).toBe('');
  });

  it('validates before callbacks and suppresses duplicate persistence', async () => {
    const events: string[] = [];
    let persistedPath = '/initial/provider';
    const container = document.createElement('div');
    const control = renderHostnameCliPathSetting({
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
    const text = control.text as unknown as TriggerableText;
    events.length = 0;

    await text.trigger('/initial/provider');
    await text.trigger('/invalid/provider');

    expect(events).toEqual([
      'validate:/initial/provider',
      'validate:/invalid/provider',
    ]);
    expect(control.validationEl.textContent).toBe('Invalid path');
    expect(control.validationEl.classList.contains('claudian-hidden')).toBe(false);
    expect(text.inputEl.classList.contains('claudian-input-error')).toBe(true);
  });

  it('supports disabled CLI controls and dynamic presentation updates', async () => {
    const onChange = jest.fn();
    const control = renderHostnameCliPathSetting({
      container: document.createElement('div'),
      description: 'Initial description',
      disabled: true,
      getValue: () => '',
      name: 'CLI path',
      onChange,
      placeholder: '/bin/provider',
    });
    const text = control.text as unknown as TriggerableText;

    expect(text.inputEl.disabled).toBe(true);
    expect(text.inputEl.getAttribute('aria-disabled')).toBe('true');
    await text.trigger('/custom/provider');
    expect(onChange).not.toHaveBeenCalled();

    control.setDisabled(false);
    control.setDescription('Updated description');
    control.setPlaceholder('/updated/provider');

    expect(text.inputEl.disabled).toBe(false);
    expect(text.inputEl.getAttribute('aria-disabled')).toBe('false');
    expect(text.inputEl.placeholder).toBe('/updated/provider');
    expect((control.setting as unknown as { desc: string }).desc).toBe('Updated description');
  });
});
