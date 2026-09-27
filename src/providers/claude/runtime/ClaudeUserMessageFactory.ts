import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'crypto';

import type { ImageAttachment } from '../../../core/types';
import type { UserContentBlock } from './types';

function buildUserContentBlocks(prompt: string, images?: ImageAttachment[]): UserContentBlock[] {
  const content: UserContentBlock[] = [];

  for (const image of images ?? []) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: image.mediaType,
        data: image.data,
      },
    });
  }

  if (prompt.trim()) {
    content.push({
      type: 'text',
      text: prompt,
    });
  }

  return content;
}

/** Every Claudian send carries a UUID so native echoes can correlate it. */
export type ClaudeSDKUserMessage = SDKUserMessage & { readonly uuid: string };

export function buildClaudeSDKUserMessage(
  prompt: string,
  sessionId: string,
  images?: ImageAttachment[],
): ClaudeSDKUserMessage {
  if (!images || images.length === 0) {
    return {
      type: 'user',
      message: {
        role: 'user',
        content: prompt,
      },
      parent_tool_use_id: null,
      session_id: sessionId,
      uuid: randomUUID(),
    };
  }

  return {
    type: 'user',
    message: {
      role: 'user',
      content: buildUserContentBlocks(prompt, images),
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    uuid: randomUUID(),
  };
}
