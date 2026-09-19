import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { ImageAttachment } from '../../../core/types';

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ImageContentBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: ImageAttachment['mediaType'];
    data: string;
  };
}

export type UserContentBlock = TextContentBlock | ImageContentBlock;

export const MESSAGE_CHANNEL_CONFIG = {
  MAX_QUEUED_MESSAGES: 8, // Memory protection from rapid user input
  MAX_MERGED_CHARS: 12000, // ~3k tokens — batch size under context limits
} as const;

export interface PendingTextMessage {
  type: 'text';
  content: string;
}

export interface PendingAttachmentMessage {
  type: 'attachment';
  message: SDKUserMessage;
}

export type PendingMessage = PendingTextMessage | PendingAttachmentMessage;

export const UNSUPPORTED_SDK_TOOLS = ['EnterPlanMode', 'ExitPlanMode'] as const;

export const DISABLED_BUILTIN_TASK_TOOLS = [
  'TodoWrite',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
] as const;

/** Built-in subagents that don't apply to Obsidian context. */
export const DISABLED_BUILTIN_SUBAGENTS = [
  'Task(statusline-setup)',
] as const;
