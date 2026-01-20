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

export interface AgentMentionItem {
  type: 'agent';
  /** Display name */
  name: string;
  /** Full ID (namespaced for plugins) */
  id: string;
  /** Brief description */
  description?: string;
  /** Source of the agent */
  source: 'plugin' | 'vault' | 'global' | 'builtin';
}

export interface AgentFolderMentionItem {
  type: 'agent-folder';
  name: string;
}

/** Provider interface for agent mentions in the dropdown. */
export interface AgentMentionProvider {
  searchAgents: (query: string) => Array<{
    id: string;
    name: string;
    description?: string;
    source: 'plugin' | 'vault' | 'global' | 'builtin';
  }>;
}

export type MentionItem =
  | FileMentionItem
  | McpServerMentionItem
  | ContextFileMentionItem
  | ContextFolderMentionItem
  | AgentMentionItem
  | AgentFolderMentionItem;

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
