import { type App, Plugin, type PluginManifest, type PluginSettingTab } from 'obsidian';

class FixturePlugin extends Plugin {}

export function createObsidianPlugin(app: App, manifest: Partial<PluginManifest> = {}): Plugin {
  return new FixturePlugin(app, {
    id: 'test-plugin', name: 'Test plugin', version: '1.0.0', minAppVersion: '1.0.0',
    author: 'Test', description: '', ...manifest,
  });
}

/** Mounts through the shared host's update/hide lifecycle. */
export function mountSettingTab(tab: PluginSettingTab, container: HTMLElement): () => void {
  tab.containerEl = container;
  tab.update();
  return () => tab.hide();
}
