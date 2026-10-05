import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { resolveSessionMentions } from '@/features/chat/input/resolveSessionMentions';
import type { SideChatSubmission } from '@/features/chat/side-chat/SideChatRuntime';

/** A command reserves its queue position while its detached input is prepared. */
export class SideChatCommandSubmission {
  readonly settled: Promise<SideChatSubmission | null>;
  readonly #controller = new AbortController();
  #released = false;

  constructor(
    host: ChatFeatureHost,
    submission: SideChatSubmission,
    private readonly restore: (error?: unknown) => void,
  ) {
    const captured = JSON.parse(JSON.stringify(submission)) as SideChatSubmission;
    this.settled = resolveSessionMentions(host, captured.content, this.#controller.signal)
      .then(resolved => ({
        ...captured,
        content: resolved.text,
        displayContent: resolved.text,
        context: { ...captured.context, ...(resolved.references.length ? { sessionReferences: resolved.references } : {}) },
      }))
      .catch(error => {
        this.#restore(this.#controller.signal.aborted ? undefined : error);
        return null;
      });
  }

  accept(): boolean {
    if (this.#released || this.#controller.signal.aborted) return false;
    this.#released = true;
    return true;
  }

  cancel(): void {
    this.#controller.abort();
    this.#restore();
  }

  #restore(error?: unknown): void {
    if (this.#released) return;
    this.#released = true;
    this.restore(error);
  }
}
