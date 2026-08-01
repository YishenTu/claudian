import { Setting } from 'obsidian';

export interface NativeMcpSettingsSectionOptions {
  descriptionAfterCommand: string;
  descriptionBeforeCommand: string;
  documentationLabel: string;
  documentationUrl: string;
  heading: string;
  setupCommand: string;
}

export function renderNativeMcpSettingsSection(
  container: HTMLElement,
  options: NativeMcpSettingsSectionOptions,
): void {
  new Setting(container).setName(options.heading).setHeading();

  const notice = container.createDiv({ cls: 'claudian-mcp-settings-desc' });
  const description = notice.createEl('p', { cls: 'setting-item-description' });
  description.appendText(options.descriptionBeforeCommand);
  description.createEl('code').appendText(options.setupCommand);
  description.appendText(options.descriptionAfterCommand);
  description.createEl('a', {
    href: options.documentationUrl,
    text: options.documentationLabel,
  });
}
