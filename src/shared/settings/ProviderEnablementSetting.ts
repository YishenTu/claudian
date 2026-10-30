import { type Setting, type ToggleComponent } from 'obsidian';

import { AccessibleSetting } from '@/shared/settings/AccessibleSetting';

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
  const setting = new AccessibleSetting(options.container)
    .setName(options.name)
    .setDesc(options.description)
    .addToggle((component) => {
      toggle = component;
      let synchronizing = false;
      const synchronizeValue = (): void => {
        synchronizing = true;
        try {
          component.setValue(options.getValue());
        } finally {
          synchronizing = false;
        }
      };
      component
        .setValue(options.getValue())
        .onChange(async (enabled) => {
          // Obsidian invokes onChange for changed programmatic values too.
          if (synchronizing) return;
          if (disabled) {
            synchronizeValue();
            return;
          }

          try {
            await options.onChange(enabled);
          } finally {
            synchronizeValue();
          }
        });
    });

  const setDisabled = (nextDisabled: boolean): void => {
    disabled = nextDisabled;
    toggle.setDisabled(nextDisabled);
  };

  setDisabled(disabled);

  return { setDisabled, setting, toggle };
}
