import { Setting, type ToggleComponent } from 'obsidian';

export interface ProviderEnablementSettingOptions {
  container: HTMLElement;
  description: string;
  disabled?: boolean;
  getValue: () => boolean;
  name: string;
  onChange: (enabled: boolean) => Promise<void> | void;
}

export interface ProviderEnablementSettingControl {
  setDisabled: (disabled: boolean) => void;
  setting: Setting;
  toggle: ToggleComponent;
}

export function renderProviderEnablementSetting(
  options: ProviderEnablementSettingOptions,
): ProviderEnablementSettingControl {
  let disabled = options.disabled ?? false;
  let toggle!: ToggleComponent;
  const setting = new Setting(options.container)
    .setName(options.name)
    .setDesc(options.description)
    .addToggle((component) => {
      toggle = component;
      component
        .setValue(options.getValue())
        .onChange(async (enabled) => {
          if (disabled) {
            component.setValue(options.getValue());
            return;
          }

          try {
            await options.onChange(enabled);
          } finally {
            component.setValue(options.getValue());
          }
        });
    });

  const setDisabled = (nextDisabled: boolean): void => {
    disabled = nextDisabled;
    const component = toggle as ToggleComponent & {
      setDisabled?: (value: boolean) => ToggleComponent;
      toggleEl?: HTMLElement;
    };
    component.setDisabled?.(nextDisabled);
    component.toggleEl?.setAttribute?.('aria-disabled', String(nextDisabled));
  };

  const toggleElement = (toggle as ToggleComponent & { toggleEl?: HTMLElement }).toggleEl;
  toggleElement?.setAttribute?.('aria-label', options.name);
  setDisabled(disabled);

  return { setDisabled, setting, toggle };
}
