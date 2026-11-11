import { type Setting, type TextComponent } from 'obsidian';

import { AccessibleSetting } from '@/shared/settings/AccessibleSetting';

export interface HostnameCLIPathSettingOptions {
  container: HTMLElement;
  description: string;
  disabled?: boolean;
  getValue: () => string;
  name: string;
  onChange: (value: string) => Promise<void> | void;
  placeholder: string;
  validate?: (value: string) => string | null;
}

export interface HostnameCLIPathSettingControl {
  revalidate: () => boolean;
  setDescription: (description: string) => void;
  setDisabled: (disabled: boolean) => void;
  setPlaceholder: (placeholder: string) => void;
  setting: Setting;
  text: TextComponent;
  validationEl: HTMLElement;
}

export function renderHostnameCLIPathSetting(
  options: HostnameCLIPathSettingOptions,
): HostnameCLIPathSettingControl {
  let currentValue = options.getValue().trim();
  let disabled = options.disabled ?? false;
  let text!: TextComponent;
  const setting = new AccessibleSetting(options.container)
    .setName(options.name)
    .setDesc(options.description);
  const validationEl = options.container.createDiv({
    cls: 'claudian-cli-path-validation claudian-setting-validation claudian-setting-validation-error claudian-hidden',
  });

  const updateValidation = (value: string): boolean => {
    const error = options.validate?.(value) ?? null;
    validationEl.setText(error ?? '');
    validationEl.toggleClass('claudian-hidden', !error);
    text.inputEl.toggleClass('claudian-input-error', Boolean(error));
    text.inputEl.setAttribute('aria-invalid', String(Boolean(error)));
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

  text.inputEl.addClass('claudian-settings-cli-path-input');
  text.inputEl.setAttribute('aria-label', options.name);
  updateValidation(currentValue);

  const setDisabled = (nextDisabled: boolean): void => {
    disabled = nextDisabled;
    text.inputEl.disabled = nextDisabled;
    text.inputEl.setAttribute('aria-disabled', String(nextDisabled));
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
