/**
 * Context Menu Registration for Claudian
 *
 * Registers right-click menu items for adding files/selections to chat.
 */

import type { Menu, App, Editor } from 'obsidian';
import { Notice, TFile } from 'obsidian';
import type ClaudianPlugin from '../../main';
import { VIEW_TYPE_CLAUDIAN } from '../../core/types';
import type { ClaudianView } from './ClaudianView';

/**
 * Get the active Claudian view if available.
 */
function getActiveClaudianView(app: App): ClaudianView | null {
  const leaves = app.workspace.getLeavesOfType(VIEW_TYPE_CLAUDIAN);
  if (leaves.length === 0) return null;
  return leaves[0].view as ClaudianView;
}

/**
 * Add a file to the active Claudian chat context.
 */
export function addFileToChat(app: App, file: TFile): boolean {
  const view = getActiveClaudianView(app);
  if (!view) {
    new Notice('Please open Claudian chat first');
    return false;
  }

  const tabManager = view.getTabManager();
  if (!tabManager) {
    new Notice('Chat not ready');
    return false;
  }

  const activeTab = tabManager.getActiveTab();
  if (!activeTab) {
    new Notice('No active chat tab');
    return false;
  }

  const fileContextManager = activeTab.ui.fileContextManager;
  if (!fileContextManager) {
    new Notice('File context not available');
    return false;
  }

  const added = fileContextManager.addFile(file.path);
  if (added) {
    new Notice(`Added "${file.basename}" to chat context`);
  } else {
    new Notice(`"${file.basename}" is already in chat context`);
  }

  return added;
}

/**
 * Add selected text to the active Claudian chat.
 */
export function addSelectionToChat(app: App, editor: Editor, file: TFile | null): boolean {
  const selectedText = editor.getSelection();
  if (!selectedText.trim()) {
    new Notice('No text selected');
    return false;
  }

  const view = getActiveClaudianView(app);
  if (!view) {
    new Notice('Please open Claudian chat first');
    return false;
  }

  const tabManager = view.getTabManager();
  if (!tabManager) {
    new Notice('Chat not ready');
    return false;
  }

  const activeTab = tabManager.getActiveTab();
  if (!activeTab) {
    new Notice('No active chat tab');
    return false;
  }

  // Get the input element and append the selection
  const inputEl = activeTab.dom.inputEl;
  if (inputEl) {
    const filename = file?.basename || 'selection';
    const contextText = `\n\n<selection from="${filename}">\n${selectedText}\n</selection>`;

    // Append to existing input or set new
    const currentValue = inputEl.value;
    inputEl.value = currentValue ? currentValue + contextText : contextText.trim();

    // Trigger input event to update UI
    inputEl.dispatchEvent(new Event('input', { bubbles: true }));

    new Notice('Selection added to chat input');
    return true;
  }

  return false;
}

/**
 * Register file menu context items (right-click on files in explorer).
 */
export function registerFileMenu(plugin: ClaudianPlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('file-menu', (menu: Menu, abstractFile) => {
      // Only show for files, not folders
      if (!(abstractFile instanceof TFile)) {
        return;
      }

      const file = abstractFile as TFile;

      menu.addItem((item) => {
        item
          .setTitle('Add to Claudian chat')
          .setIcon('message-square-plus')
          .onClick(() => {
            addFileToChat(plugin.app, file);
          });
      });
    })
  );
}

/**
 * Register editor menu context items (right-click in editor).
 */
export function registerEditorMenu(plugin: ClaudianPlugin): void {
  plugin.registerEvent(
    plugin.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, info: any) => {
      const file = info.file as TFile | null;

      // Add "Add selection to Claudian" menu item
      menu.addItem((item) => {
        item
          .setTitle('Add selection to Claudian')
          .setIcon('message-square-plus')
          .onClick(() => {
            addSelectionToChat(plugin.app, editor, file);
          });
      });

      // Add "Add file to Claudian chat" if we have a file
      if (file) {
        menu.addItem((item) => {
          item
            .setTitle('Add file to Claudian chat')
            .setIcon('file-plus')
            .onClick(() => {
              addFileToChat(plugin.app, file);
            });
        });
      }
    })
  );
}

/**
 * Register all context menus.
 */
export function registerContextMenus(plugin: ClaudianPlugin): void {
  registerFileMenu(plugin);
  registerEditorMenu(plugin);
}
