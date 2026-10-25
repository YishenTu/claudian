import { buildContextFromHistory } from '@/core/prompt/historyContext';
import { appendExecutionContext } from '@/core/prompt/promptContext';
import { buildRecoveryPrompt, decodeRecoveryPrompt } from '@/core/prompt/recoveryPrompt';

import type { ProviderExecutionContext } from '../../../core/execution';
import type { ChatMessage, ImageAttachment } from '../../../core/types';
import type { ACPContentBlock } from '../../acp';

export interface OpencodePromptRequest {
  text: string;
  images?: ImageAttachment[];
  context?: ProviderExecutionContext;
}

/** The span of the composed prompt text that the user typed. */
export interface OpencodeTextRange {
  readonly start: number;
  readonly end: number;
}

export interface OpencodePrompt {
  readonly blocks: ACPContentBlock[];
  /** Absent when replayed history already ends with this turn's query. */
  readonly userText: OpencodeTextRange | null;
}

function composeOpencodePromptText(
  request: OpencodePromptRequest,
  conversationHistory: ChatMessage[],
): { text: string; userText: OpencodeTextRange | null } {
  // Captured context always follows the typed text.
  const prompt = appendExecutionContext(request.text, request.context);

  const historyContext = buildContextFromHistory(conversationHistory);
  if (!historyContext) {
    return { text: prompt, userText: { start: 0, end: request.text.length } };
  }
  // Replayed history stays in an envelope that history readers strip.
  const text = buildRecoveryPrompt(historyContext, prompt, conversationHistory);
  const start = text.length - prompt.length;
  return {
    text,
    userText: decodeRecoveryPrompt(text)?.currentInput != null
      ? { start, end: start + request.text.length }
      : null,
  };
}

export function buildOpencodePrompt(
  request: OpencodePromptRequest,
  conversationHistory: ChatMessage[] = [],
): OpencodePrompt {
  const { text, userText } = composeOpencodePromptText(request, conversationHistory);
  const blocks: ACPContentBlock[] = [{ type: 'text', text }];

  for (const image of request.images ?? []) {
    if (!image.data) {
      continue;
    }

    blocks.push({
      data: image.data,
      mimeType: image.mediaType,
      type: 'image',
    });
  }

  return { blocks, userText };
}
