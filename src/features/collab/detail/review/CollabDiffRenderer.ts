import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import { t } from '@/i18n/i18n';

import type * as CodeMirrorDiffModule from './CollabCodeMirrorDiffModule';

export type CollabDiffTheme = 'dark' | 'light';
export type CollabDiffLayout = 'split' | 'unified';

export interface CollabDiffThemeSource {
  current(): CollabDiffTheme;
  subscribe(listener: (theme: CollabDiffTheme) => void): () => void;
}

export interface CollabTextDiffInput {
  readonly container: HTMLElement;
  readonly layout?: CollabDiffLayout;
  readonly newText: string | null;
  readonly oldText: string | null;
  readonly onOpenFile?: () => void;
  readonly path: string;
  readonly previousPath?: string;
}

export interface CollabDiffRendererOptions {
  readonly loadDiffs?: () => Promise<typeof CodeMirrorDiffModule>;
  readonly themeSource?: CollabDiffThemeSource;
}

class ObsidianThemeSource implements CollabDiffThemeSource {
  constructor(private readonly body: HTMLElement) {}

  current(): CollabDiffTheme {
    return this.body.classList.contains('theme-dark') ? 'dark' : 'light';
  }

  subscribe(listener: (theme: CollabDiffTheme) => void): () => void {
    const observer = new MutationObserver(() => listener(this.current()));
    observer.observe(this.body, { attributeFilter: ['class'], attributes: true });
    return () => observer.disconnect();
  }
}

function rendererError(
  code: 'operation-failed' | 'quota-exceeded',
  reason: string,
): CollabError {
  return new CollabError({
    code,
    recoveryActions: code === 'operation-failed' ? ['retry'] : ['open-diagnostics'],
    safeContext: { reason },
  });
}

function lineCountExceeds(value: string): boolean {
  if (value.length === 0) return false;
  let lines = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) === 10) lines += 1;
    if (lines > CLAUDIAN_COLLAB_LIMITS.maxTextDiffLines) return true;
  }
  return false;
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function assertRenderable(input: CollabTextDiffInput): void {
  if (
    (input.oldText === null && input.newText === null)
    || input.path.length === 0
    || input.path.includes('\u0000')
  ) {
    throw rendererError('operation-failed', 'diff-input-invalid');
  }
  for (const contents of [input.oldText, input.newText]) {
    if (contents === null) continue;
    if (
      utf8ByteLength(contents) > CLAUDIAN_COLLAB_LIMITS.maxTextDiffBytes
      || lineCountExceeds(contents)
    ) {
      throw rendererError('quota-exceeded', 'diff-text-limit');
    }
  }
}

let sharedModulePromise: Promise<typeof CodeMirrorDiffModule> | null = null;

export function preloadCollabDiffRenderer() {
  sharedModulePromise ??= import('./CollabCodeMirrorDiffModule').catch((error: unknown) => {
    sharedModulePromise = null;
    throw error;
  });
  return sharedModulePromise;
}

function appendExternalLinkIcon(container: HTMLElement): void {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = container.ownerDocument.createElementNS(namespace, 'svg');
  svg.classList.add('svg-icon', 'lucide-external-link');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('viewBox', '0 0 24 24');
  for (const pathData of [
    'M15 3h6v6',
    'M10 14 21 3',
    'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
  ]) {
    const path = container.ownerDocument.createElementNS(namespace, 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
  }
  container.appendChild(svg);
}

export class CollabDiffRenderer {
  #active: {
    input: CollabTextDiffInput;
    layout: CollabDiffLayout;
    root: HTMLElement;
    header: HTMLElement;
    view: ReturnType<typeof CodeMirrorDiffModule.createDiffView>;
  } | null = null;
  #currentLayout: CollabDiffLayout = 'unified';
  #destroyed = false;
  #generation = 0;
  #module: typeof CodeMirrorDiffModule | null = null;
  #modulePromise: Promise<typeof CodeMirrorDiffModule> | null = null;
  readonly #loadDiffs: NonNullable<CollabDiffRendererOptions['loadDiffs']>;
  readonly #themeSource: CollabDiffThemeSource;
  readonly #unsubscribeTheme: () => void;

  constructor(options: CollabDiffRendererOptions = {}) {
    this.#loadDiffs = options.loadDiffs ?? preloadCollabDiffRenderer;
    this.#themeSource = options.themeSource ?? new ObsidianThemeSource(activeDocument.body);
    this.#unsubscribeTheme = this.#themeSource.subscribe(theme => {
      this.#active?.view.setTheme(theme);
    });
  }

  async render(input: CollabTextDiffInput): Promise<void> {
    assertRenderable(input);
    if (this.#destroyed) throw new CollabError({ code: 'cancelled' });
    this.#currentLayout = input.layout ?? this.#currentLayout;
    const generation = ++this.#generation;
    this.#modulePromise ??= this.#loadDiffs().catch((error: unknown) => {
      this.#modulePromise = null;
      throw error;
    });
    const module = await this.#modulePromise;
    if (this.#destroyed || generation !== this.#generation) return;
    this.#module = module;
    this.#show(input);
  }

  clear(): void {
    if (this.#destroyed) return;
    this.#generation += 1;
    this.#cleanActive();
  }

  setLayout(layout: CollabDiffLayout): void {
    if (this.#destroyed || this.#currentLayout === layout) return;
    this.#currentLayout = layout;
    if (this.#active) this.#show(this.#active.input);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#generation += 1;
    this.#cleanActive();
    this.#unsubscribeTheme();
  }

  #show(input: CollabTextDiffInput): void {
    const active = this.#active;
    if (active && active.layout === this.#currentLayout
      && active.input.path === input.path && active.input.previousPath === input.previousPath
      && active.input.oldText === input.oldText && active.input.newText === input.newText
      && active.root.ownerDocument === input.container.ownerDocument) {
      input.container.appendChild(active.root);
      active.input = input;
      this.#renderHeader(active.header, input);
      return;
    }
    this.#cleanActive();
    if (!this.#module) return;
    const root = input.container.createDiv({ cls: 'claudian-collab-diff' });
    const header = root.createDiv({ cls: 'claudian-collab-diff-header' });
    this.#renderHeader(header, input);
    const body = root.createDiv();
    try {
      const view = this.#module.createDiffView({
        layout: this.#currentLayout,
        newText: input.newText ?? '',
        oldText: input.oldText ?? '',
        parent: body,
        path: input.path,
        previousPath: input.previousPath,
        theme: this.#themeSource.current(),
      });
      this.#active = { header, input, layout: this.#currentLayout, root, view };
    } catch (error) {
      root.remove();
      throw error;
    }
  }

  #cleanActive(): void {
    const active = this.#active;
    this.#active = null;
    if (!active) return;
    active.view.destroy();
    active.root.remove();
  }

  #renderHeader(header: HTMLElement, input: CollabTextDiffInput): void {
    header.replaceChildren();
    const name = header.createSpan();
    name.textContent = input.previousPath && input.previousPath !== input.path
      ? `${input.previousPath} → ${input.path}` : input.path;
    if (input.oldText === null || input.newText === null) {
      const status = header.createSpan();
      status.textContent = t(input.oldText === null
        ? 'collab.publish.fileKind.added' : 'collab.publish.fileKind.deleted');
    }
    if (!input.onOpenFile) return;
    const action = input.onOpenFile;
    const button = header.createEl('button');
    button.type = 'button';
    button.className = 'claudian-collab-review-display-toggle claudian-collab-review-file-open';
    button.dataset.collabReviewOpenFile = '';
    button.setAttribute('aria-label', t('collab.review.openFile'));
    appendExternalLinkIcon(button);
    button.addEventListener('click', event => {
      event.stopPropagation();
      action();
    });
  }
}
