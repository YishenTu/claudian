import type { BrowserSelectionContext } from '@/core/prompt/browserContext';
import type { CanvasSelectionContext } from '@/core/prompt/canvasContext';
import type { EditorSelectionContext } from '@/core/prompt/editorContext';
import type { BrowserSelectionController } from '@/features/chat/input/BrowserSelectionController';
import type { CanvasSelectionController } from '@/features/chat/input/CanvasSelectionController';
import type { SelectionController } from '@/features/chat/input/SelectionController';

const SELECTION_POLL_INTERVAL = 250;

function pollSource(poll: () => void | Promise<void>): void {
  try {
    void Promise.resolve(poll()).catch(() => undefined);
  } catch {
    // A failed tick is retried on the next one.
  }
}

/** Independent copies of the selections visible when a submission was captured. */
export interface ComposerSelectionCapture {
  editorSelection?: EditorSelectionContext;
  browserSelection?: BrowserSelectionContext;
  canvasSelection?: CanvasSelectionContext;
}

export interface ComposerSelectionSources {
  editor: Pick<SelectionController, 'start' | 'stop' | 'poll' | 'getContext'>;
  browser: Pick<BrowserSelectionController, 'poll' | 'clear' | 'getContext'>;
  canvas: Pick<CanvasSelectionController, 'poll' | 'clear' | 'getContext'>;
}

/**
 * Owns the editor, browser, and canvas selections a tab's composer can attach: their shared
 * polling lifetime while the tab is active, and the snapshot a submission captures.
 */
export class ComposerSelections {
  private readonly editor: ComposerSelectionSources['editor'];
  private readonly browser: ComposerSelectionSources['browser'];
  private readonly canvas: ComposerSelectionSources['canvas'];
  #pollTimer: number | null = null;

  constructor(sources: ComposerSelectionSources) {
    this.editor = sources.editor;
    this.browser = sources.browser;
    this.canvas = sources.canvas;
  }

  start(): void {
    if (this.#pollTimer !== null) return;
    this.editor.start();
    this.#pollTimer = window.setInterval(() => {
      // Independent sources: one failing poll must not starve the others.
      pollSource(() => this.editor.poll());
      pollSource(() => this.browser.poll());
      pollSource(() => this.canvas.poll());
    }, SELECTION_POLL_INTERVAL);
  }

  /** Stopping drops every captured selection. */
  stop(): void {
    if (this.#pollTimer !== null) {
      window.clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    this.editor.stop();
    this.browser.clear();
    this.canvas.clear();
  }

  capture(): ComposerSelectionCapture {
    const editorSelection = this.editor.getContext();
    const browserSelection = this.browser.getContext();
    const canvasSelection = this.canvas.getContext();
    return {
      ...(browserSelection ? { browserSelection: { ...browserSelection } } : {}),
      ...(canvasSelection ? {
        canvasSelection: { ...canvasSelection, nodeIds: [...canvasSelection.nodeIds] },
      } : {}),
      ...(editorSelection ? {
        editorSelection: {
          ...editorSelection,
          ...(editorSelection.cursorContext
            ? { cursorContext: { ...editorSelection.cursorContext } }
            : {}),
        },
      } : {}),
    };
  }
}
