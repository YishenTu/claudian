import type { TFile } from 'obsidian';

export interface MentionItem {
  type: 'file' | 'mcp-server' | 'context-file' | 'context-folder';
  name: string;
  path?: string;
  absolutePath?: string;
  contextRoot?: string;
  folderName?: string;
  file?: TFile;
}

export interface ContextPathEntry {
  contextRoot: string;
  folderName: string;
  displayName: string;
  displayNameLower: string;
}
