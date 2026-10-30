/** @vitest-environment jsdom */
import { createObsidianPlugin, mountSettingTab } from '@test/helpers/ObsidianSettingsHost';
import { App, PluginSettingTab, type SettingDefinitionItem } from 'obsidian';

it('cleans mounted definitions before update and once on hide', () => {
  const cleanup = vi.fn();
  class Tab extends PluginSettingTab {
    getSettingDefinitions(): SettingDefinitionItem[] {
      return [{ name: 'Example', render: setting => {
        setting.settingEl.textContent = 'Current content';
        return () => {
          expect(setting.settingEl.isConnected).toBe(true);
          cleanup();
        };
      } }];
    }
  }
  const app = new App();
  const tab = new Tab(app, createObsidianPlugin(app));
  const dispose = mountSettingTab(tab, document.body.createDiv());
  expect(tab.containerEl.textContent).toContain('Current content');
  tab.update();
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(tab.containerEl.textContent).toBe('Current content');
  dispose();
  dispose();
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(tab.containerEl.textContent).toBe('');
  document.body.replaceChildren();
});
