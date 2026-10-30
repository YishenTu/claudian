import { Setting, type ToggleComponent } from 'obsidian';

let nextNameId = 0;

/** Adds semantics missing from Obsidian's Setting without replacing host controls. */
export class AccessibleSetting extends Setting {
  private nameControl(control: HTMLElement): void {
    if (control.hasAttribute('aria-label') || control.hasAttribute('aria-labelledby')) return;
    this.nameEl.id ||= `claudian-setting-name-${++nextNameId}`;
    control.setAttribute('aria-labelledby', this.nameEl.id);
  }

  override addText(callback: Parameters<Setting['addText']>[0]): this {
    return super.addText(control => {
      callback(control);
      this.nameControl(control.inputEl);
    });
  }

  override addTextArea(callback: Parameters<Setting['addTextArea']>[0]): this {
    return super.addTextArea(control => {
      callback(control);
      this.nameControl(control.inputEl);
    });
  }

  override addDropdown(callback: Parameters<Setting['addDropdown']>[0]): this {
    return super.addDropdown(control => {
      callback(control);
      this.nameControl(control.selectEl);
    });
  }

  override addToggle(callback: Parameters<Setting['addToggle']>[0]): this {
    return super.addToggle(control => {
      const input = exposeToggleState(control);
      callback(control);
      if (!input.hasAttribute('aria-label') && !input.hasAttribute('aria-labelledby')) {
        for (const attribute of ['aria-label', 'aria-labelledby']) {
          const value = control.toggleEl.getAttribute(attribute);
          if (value !== null) input.setAttribute(attribute, value);
        }
      }
      this.nameControl(input);
    });
  }

  override setHeading(): this {
    super.setHeading();
    // These are peer sections beneath the host's settings page title.
    this.nameEl.setAttribute('role', 'heading');
    this.nameEl.setAttribute('aria-level', '2');
    return this;
  }
}

function exposeToggleState(control: ToggleComponent): HTMLInputElement {
  const { toggleEl } = control;
  const input = toggleEl.querySelector('input')!;
  input.setAttribute('role', 'switch');
  // A label cannot have role=switch. Focus its native checkbox instead; the
  // host's Enter/Space handler still receives the bubbling keyboard events.
  toggleEl.tabIndex = -1;
  input.tabIndex = 0;
  toggleEl.classList.add('claudian-setting-toggle');
  const syncValue = (): void => {
    input.checked = control.getValue();
    input.setAttribute('aria-checked', String(control.getValue()));
  };
  const setValue = control.setValue.bind(control);
  control.setValue = value => {
    try {
      return setValue(value);
    } finally {
      // setValue can synchronously re-enter during a rejected change's rollback.
      syncValue();
    }
  };
  const syncDisabled = (): void => {
    input.disabled = control.disabled;
    input.setAttribute('aria-disabled', String(control.disabled));
  };
  const setDisabled = control.setDisabled.bind(control);
  control.setDisabled = disabled => {
    const result = setDisabled(disabled);
    syncDisabled();
    return result;
  };
  syncValue();
  syncDisabled();
  return input;
}
