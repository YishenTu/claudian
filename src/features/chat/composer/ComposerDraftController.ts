import type { ChatMessage } from '@/core/types';
import type { ImageContextManager } from '@/features/chat/composer/ImageContextManager';
import type { ComposerInputElement } from '@/shared/composer-dropdown/types';

/**
 * Appends a raw unsent suffix to a restored draft prefix, keeping the suffix bytes intact.
 * Nonblank prefixes are separated from the suffix by at least two newlines.
 */
export function appendRawDraftSuffix(prefix: string, suffix: string): string {
  if (!suffix.trim()) return prefix;
  if (!prefix.trim()) return suffix;
  const separator = prefix.endsWith('\n\n') ? '' : prefix.endsWith('\n') ? '\n' : '\n\n';
  return prefix + separator + suffix;
}

export type ComposerDestination = 'main' | 'side';
export interface ComposerDraft {
  readonly content: string;
  readonly images: NonNullable<ChatMessage['images']>;
}
export type ComposerDrafts = Readonly<Record<ComposerDestination, ComposerDraft>>;

/** Owns visible and parked drafts. Destination is always derived from presentation. */
export class ComposerDraftController {
  private readonly parked: Record<ComposerDestination, ComposerDraft> = {
    main: { content: '', images: [] }, side: { content: '', images: [] },
  };

  constructor(private readonly deps: {
    getInput: () => ComposerInputElement;
    getImages: () => ImageContextManager | null;
    getDestination: () => ComposerDestination;
  }) {}

  get destination(): ComposerDestination { return this.deps.getDestination(); }

  capture(destination: ComposerDestination = this.destination): ComposerDraft {
    const draft = destination === this.destination
      ? { content: this.deps.getInput().value, images: this.deps.getImages()?.getAttachedImages() ?? [] }
      : this.parked[destination];
    return { content: draft.content, images: [...draft.images] };
  }

  consume(destination: ComposerDestination = this.destination): ComposerDraft {
    const draft = this.capture(destination);
    this.restore(destination, { content: '', images: [] });
    return draft;
  }

  restore(destination: ComposerDestination, draft: Pick<ChatMessage, 'content' | 'images'>,
    options: { merge?: boolean; focus?: boolean; notify?: boolean } = {}): void {
    const existing = options.merge ? this.capture(destination) : { content: '', images: [] };
    const next = {
      content: appendRawDraftSuffix(draft.content, existing.content),
      images: [...(draft.images ?? []), ...existing.images],
    };
    this.parked[destination] = next;
    if (destination === this.destination) this.show(next, options.focus, options.notify);
  }

  /** The caller changes panel presentation synchronously; no second destination state is stored here. */
  changeDestination(updatePresentation: () => void): void {
    this.parked[this.destination] = this.capture();
    updatePresentation();
    this.show(this.parked[this.destination]);
  }

  private show(draft: ComposerDraft, focus = false, notify = false): void {
    const input = this.deps.getInput();
    input.value = draft.content;
    if (draft.images.length) this.deps.getImages()?.setImages([...draft.images]);
    else this.deps.getImages()?.clearImages();
    if (focus) input.focus();
    if (notify) {
      const EventConstructor = input.ownerDocument?.defaultView?.Event ?? Event;
      input.dispatchEvent(new EventConstructor('input', { bubbles: true }));
    }
  }
}
