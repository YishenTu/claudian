import type { TFile } from 'obsidian';

export interface FileMentionItem {
  type: 'file';
  name: string;
  path: string;
  file: TFile;
}

export interface McpServerMentionItem {
  type: 'mcp-server';
  name: string;
}

export interface ContextFileMentionItem {
  type: 'context-file';
  name: string;
  absolutePath: string;
  contextRoot: string;
  folderName: string;
}

export interface ContextFolderMentionItem {
  type: 'context-folder';
  name: string;
  contextRoot: string;
  folderName: string;
}

export type MentionItem =
  | FileMentionItem
  | McpServerMentionItem
  | ContextFileMentionItem
  | ContextFolderMentionItem;

export interface ExternalContextEntry {
  contextRoot: string;
  folderName: string;
  displayName: string;
  displayNameLower: string;
}

export function createExternalContextEntry(
  contextRoot: string,
  folderName: string,
  displayName: string
): ExternalContextEntry {
  return {
    contextRoot,
    folderName,
    displayName,
    displayNameLower: displayName.toLowerCase(),
  };
}
