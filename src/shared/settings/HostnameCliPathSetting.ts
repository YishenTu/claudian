import { Setting, type TextComponent } from 'obsidian';

export interface HostnameCliPathSettingOptions {
  container: HTMLElement;
  description: string;
  disabled?: boolean;
  getValue: () => string;
  name: string;
  onChange: (value: string) => Promise<void> | void;
  placeholder: string;
  validate?: (value: string) => string | null;
}

export interface HostnameCliPathSettingControl {
  revalidate: () => boolean;
  setDescription: (description: string) => void;
  setDisabled: (disabled: boolean) => void;
  setPlaceholder: (placeholder: string) => void;
  setting: Setting;
  text: TextComponent;
  validationEl: HTMLElement;
}

export function renderHostnameCliPathSetting(
  options: HostnameCliPathSettingOptions,
): HostnameCliPathSettingControl {
  let currentValue = options.getValue().trim();
  let disabled = options.disabled ?? false;
  let text!: TextComponent;
  const setting = new Setting(options.container)
    .setName(options.name)
    .setDesc(options.description);
  const validationEl = options.container.createDiv({
    cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
  });

  const updateValidation = (value: string): boolean => {
    const error = options.validate?.(value) ?? null;
    setElementText(validationEl, error ?? '');
    toggleElementClass(validationEl, 'claudian-hidden', !error);
    toggleElementClass(text.inputEl, 'claudian-input-error', Boolean(error));
    return !error;
  };

  const synchronizeValue = (): void => {
    currentValue = options.getValue().trim();
    text.setValue(currentValue);
  };

  setting.addText((component) => {
    text = component;
    component
      .setPlaceholder(options.placeholder)
      .setValue(currentValue)
      .onChange(async (value) => {
        if (disabled) {
          synchronizeValue();
          return;
        }
        if (!updateValidation(value)) {
          return;
        }

        const normalizedValue = value.trim();
        if (normalizedValue === currentValue) {
          component.setValue(currentValue);
          return;
        }

        try {
          await options.onChange(normalizedValue);
          synchronizeValue();
        } catch (error) {
          synchronizeValue();
          updateValidation(currentValue);
          throw error;
        }
      });
  });

  addElementClass(text.inputEl, 'claudian-settings-cli-path-input');
  text.inputEl.setAttribute?.('aria-label', options.name);
  updateValidation(currentValue);

  const setDisabled = (nextDisabled: boolean): void => {
    disabled = nextDisabled;
    text.inputEl.disabled = nextDisabled;
    text.inputEl.setAttribute?.('aria-disabled', String(nextDisabled));
  };
  const setDescription = (description: string): void => {
    setting.setDesc(description);
  };
  const setPlaceholder = (placeholder: string): void => {
    text.inputEl.placeholder = placeholder;
  };
  const revalidate = (): boolean => updateValidation(text.inputEl.value);

  setDisabled(disabled);

  return {
    revalidate,
    setDescription,
    setDisabled,
    setPlaceholder,
    setting,
    text,
    validationEl,
  };
}

function addElementClass(element: HTMLElement, className: string): void {
  const obsidianElement = element as HTMLElement & { addClass?: (name: string) => void };
  if (obsidianElement.addClass) {
    obsidianElement.addClass(className);
    return;
  }
  element.classList?.add(className);
}

function toggleElementClass(element: HTMLElement, className: string, force: boolean): void {
  const obsidianElement = element as HTMLElement & {
    toggleClass?: (name: string, value: boolean) => void;
  };
  if (obsidianElement.toggleClass) {
    obsidianElement.toggleClass(className, force);
    return;
  }
  element.classList?.toggle(className, force);
}

function setElementText(element: HTMLElement, value: string): void {
  const obsidianElement = element as HTMLElement & { setText?: (text: string) => void };
  if (obsidianElement.setText) {
    obsidianElement.setText(value);
    return;
  }
  element.textContent = value;
}
