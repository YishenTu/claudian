import type { MessageRenderer } from '@/features/chat/rendering/MessageRenderer';
import type { ChatState } from '@/features/chat/state/ChatState';
import type { SubagentManager } from '@/features/chat/subagents/SubagentManager';
import type { StreamController } from '@/features/chat/turns/StreamController';

/** An optional transcript view over a session model. Attachment never changes execution. */
export class SessionTranscript {
  private view: { renderer: MessageRenderer; messagesEl: HTMLElement } | null = null;

  constructor(
    readonly state: ChatState,
    private readonly stream: StreamController,
    private readonly subagents: SubagentManager,
  ) {}

  get renderer(): MessageRenderer | null { return this.view?.renderer ?? null; }
  get messagesEl(): HTMLElement | null { return this.view?.messagesEl ?? null; }

  attach(renderer: MessageRenderer, messagesEl: HTMLElement, getGreeting: () => string): HTMLElement {
    if (this.view) throw new Error('Session transcript already attached');
    this.view = { renderer, messagesEl };
    try {
      const welcome = renderer.renderMessages(this.state.messages, getGreeting, this.stream.liveTranscriptOptions);
      if (this.state.messages.length) welcome.addClass('claudian-hidden');
      this.stream.restorePresentation();
      return welcome;
    } catch (error) {
      this.detach();
      throw error;
    }
  }

  detach(): void {
    this.stream.detachPresentation();
    this.subagents.detachView();
    this.view?.renderer.dispose();
    this.view = null;
  }
}
