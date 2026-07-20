import type { App, EventRef } from 'obsidian';
import { Notice, TFile } from 'obsidian';

import { formatVaultFileMention } from '../../shared/mention/formatMention';

interface FileMenuViewHost {
  appendToActiveInput(text: string): boolean;
}

export interface FileMenuHost {
  readonly app: App;
  activateView(): Promise<void>;
  getView(): FileMenuViewHost | null;
  registerEvent(eventRef: EventRef): void;
}

export async function addFileToClaudian(host: FileMenuHost, file: TFile): Promise<boolean> {
  try {
    await host.activateView();
    const appended = host.getView()?.appendToActiveInput(formatVaultFileMention(file.path)) ?? false;
    if (!appended) {
      new Notice('Claudian chat is not ready.');
    }
    return appended;
  } catch {
    new Notice('Failed to add file to Claudian.');
    return false;
  }
}

export function registerFileMenu(host: FileMenuHost): void {
  host.registerEvent(
    host.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile)) return;

      menu.addItem((item) => item
        .setTitle('Add to Claudian')
        .setIcon('message-square-plus')
        .onClick(() => addFileToClaudian(host, file)));
    }),
  );
}
