import { type Setting, type ToggleComponent } from 'obsidian';

import { AccessibleSetting } from '@/shared/settings/AccessibleSetting';
import { bindCommittedControl } from '@/shared/settings/CommittedControl';

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
      bindCommittedControl(component, options.getValue, async (enabled) => {
        if (disabled) return;
        await options.onChange(enabled);
      });
    });

  const setDisabled = (nextDisabled: boolean): void => {
    disabled = nextDisabled;
    toggle.setDisabled(nextDisabled);
  };

  setDisabled(disabled);

  return { setDisabled, setting, toggle };
}
