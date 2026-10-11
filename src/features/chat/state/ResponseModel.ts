import type { StreamingThinkingBlock } from '@/features/chat/state/types';

/** One response cursor. Foreground and background responses keep separate open blocks. */
export class ResponseModel {
  messageId: string | null = null;
  text = '';
  thinking: StreamingThinkingBlock | null = null;
  startedAt: number | null = null;

  reset(): void {
    this.messageId = null;
    this.text = '';
    this.thinking = null;
    this.startedAt = null;
  }
}
