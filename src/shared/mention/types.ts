import type { TFile } from 'obsidian';

import type {
  AgentMentionProvider,
  AgentMentionSource,
} from '../../core/providers/types';

export interface FileMentionItem {
  type: 'file';
  name: string;
  path: string;
  file: TFile;
}

export interface FolderMentionItem {
  type: 'folder';
  name: string;
  path: string;
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
  source: AgentMentionSource;
}

export interface AgentFolderMentionItem {
  type: 'agent-folder';
  name: string;
}

export type { AgentMentionProvider };

export type MentionItem =
  | FileMentionItem
  | FolderMentionItem
  | McpServerMentionItem
  | ContextFileMentionItem
  | ContextFolderMentionItem
  | AgentMentionItem
  | AgentFolderMentionItem;
