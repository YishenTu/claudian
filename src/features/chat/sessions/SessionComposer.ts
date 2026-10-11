import type { ChatMessage } from '@/core/types';
import type { ComposerDestination, ComposerDraft, ComposerDraftController } from '@/features/chat/composer/ComposerDraftController';
import { appendMarkdownSnippet } from '@/features/chat/composer/markdownSnippet';

export type SessionComposerPort = Pick<ComposerDraftController, 'destination' | 'capture' | 'consume' | 'restore' | 'changeDestination'>;

/** Only definitely-unsent input travels with the session; ordinary drafts belong to each tab. */
export class SessionComposer implements SessionComposerPort {
  private readonly recovered = new Map<ComposerDestination, ComposerDraft>();

  constructor(private readonly getPresentation: () => SessionComposerPort | null) {}

  get destination(): ComposerDestination { return this.getPresentation()?.destination ?? 'main'; }
  get hasRecovery(): boolean { return this.recovered.size > 0; }

  capture(destination: ComposerDestination = this.destination): ComposerDraft {
    return this.getPresentation()?.capture(destination) ?? { content: '', images: [] };
  }

  consume(destination: ComposerDestination = this.destination): ComposerDraft {
    return this.getPresentation()?.consume(destination) ?? { content: '', images: [] };
  }

  restore(destination: ComposerDestination, draft: Pick<ChatMessage, 'content' | 'images'>,
    options: Parameters<ComposerDraftController['restore']>[2] = {}): void {
    const presentation = this.getPresentation();
    if (presentation) {
      presentation.restore(destination, draft, options);
      return;
    }
    const previous = options.merge ? this.recovered.get(destination) : undefined;
    const content = previous?.content.trim()
      ? appendMarkdownSnippet(draft.content, previous.content.trim()) : draft.content;
    const images = [...(draft.images ?? []), ...(previous?.images ?? [])];
    if (content || images.length) this.recovered.set(destination, { content, images });
    else this.recovered.delete(destination);
  }

  changeDestination(update: () => void): void {
    const presentation = this.getPresentation();
    if (presentation) presentation.changeDestination(update);
    else update();
  }

  restoreRecovered(): void {
    const presentation = this.getPresentation();
    if (!presentation) return;
    for (const [destination, draft] of this.recovered) {
      presentation.restore(destination, draft, { merge: true });
      this.recovered.delete(destination);
    }
  }
}
