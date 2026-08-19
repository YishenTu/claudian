import { CLAUDIAN_COLLAB_LIMITS } from '@/core/collab/ClaudianCollabConstants';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import { t } from '@/i18n/i18n';

export type CollabDiffTheme = 'dark' | 'light';
export type CollabDiffLayout = 'split' | 'unified';

export interface CollabDiffThemeSource {
  current(): CollabDiffTheme;
  subscribe(listener: (theme: CollabDiffTheme) => void): () => void;
}

export interface PierreDiffOptions {
  readonly diffStyle: CollabDiffLayout;
  readonly disableErrorHandling: true;
  readonly overflow: 'wrap';
  readonly preferredHighlighter: 'shiki-js';
  readonly renderHeaderFilenameSuffix?: () => HTMLElement;
  readonly themeType: CollabDiffTheme;
  readonly unsafeCSS: string;
}

export interface PierreDiffRenderInput {
  readonly containerWrapper: HTMLElement;
  readonly forceRender?: true;
  readonly newFile: {
    readonly contents: string;
    readonly lang?: string;
    readonly name: string;
  } | null;
  readonly oldFile: {
    readonly contents: string;
    readonly lang?: string;
    readonly name: string;
  } | null;
}

export interface PierreDiffInstance {
  cleanUp(): void;
  onThemeChange(): void;
  render(input: PierreDiffRenderInput): boolean;
  rerender(): void;
  setOptions(options: PierreDiffOptions): void;
  setThemeType(theme: CollabDiffTheme): void;
}

export interface PierreDiffModule {
  readonly FileDiff: new (options: PierreDiffOptions) => PierreDiffInstance;
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
  readonly loadDiffs?: () => Promise<PierreDiffModule>;
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

let sharedPierreModulePromise: Promise<PierreDiffModule> | null = null;

export function preloadCollabDiffRenderer(): Promise<PierreDiffModule> {
  sharedPierreModulePromise ??= (
    import('@pierre/diffs') as unknown as Promise<PierreDiffModule>
  ).catch((error: unknown) => {
    sharedPierreModulePromise = null;
    throw error;
  });
  return sharedPierreModulePromise;
}

function loadPierreDiffs(): Promise<PierreDiffModule> {
  return preloadCollabDiffRenderer();
}

const OBSIDIAN_DIFF_THEME_CSS = `
:host {
  --diffs-bg: var(--background-primary);
  --diffs-bg-separator-override: var(--background-primary);
}
`;

function createPierreFile(
  contents: string,
  name: string,
): NonNullable<PierreDiffRenderInput['newFile']> {
  return {
    contents,
    lang: 'text',
    name,
  };
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
  private active: { container: HTMLElement; instance: PierreDiffInstance } | null = null;
  private currentLayout: CollabDiffLayout = 'unified';
  private destroyed = false;
  private generation = 0;
  private modulePromise: Promise<PierreDiffModule> | null = null;
  private openFileAction: (() => void) | null = null;
  private readonly loadDiffs: () => Promise<PierreDiffModule>;
  private readonly themeSource: CollabDiffThemeSource;
  private readonly unsubscribeTheme: () => void;

  constructor(options: CollabDiffRendererOptions = {}) {
    this.loadDiffs = options.loadDiffs ?? loadPierreDiffs;
    this.themeSource = options.themeSource ?? new ObsidianThemeSource(activeDocument.body);
    this.unsubscribeTheme = this.themeSource.subscribe(theme => {
      if (!this.active) return;
      this.active.instance.setThemeType(theme);
      this.active.instance.onThemeChange();
    });
  }

  async render(input: CollabTextDiffInput): Promise<void> {
    assertRenderable(input);
    if (this.destroyed) throw new CollabError({ code: 'cancelled' });
    this.currentLayout = input.layout ?? this.currentLayout;
    this.openFileAction = input.onOpenFile ?? null;
    const generation = ++this.generation;
    this.modulePromise ??= this.loadDiffs().catch((error: unknown) => {
      this.modulePromise = null;
      throw error;
    });
    const module = await this.modulePromise;
    if (this.destroyed || generation !== this.generation) return;

    const options = this.pierreOptions(this.themeSource.current());
    const containerChanged = this.active !== null
      && this.active.container !== input.container;
    const active = this.active ?? {
      container: input.container,
      instance: new module.FileDiff(options),
    };
    if (this.active) active.instance.setOptions(options);
    active.container = input.container;
    this.active = active;
    try {
      active.instance.render({
        containerWrapper: input.container,
        ...(containerChanged ? { forceRender: true } : {}),
        newFile: input.newText === null
          ? null
          : createPierreFile(input.newText, input.path),
        oldFile: input.oldText === null
          ? null
          : createPierreFile(input.oldText, input.previousPath ?? input.path),
      });
    } catch (error) {
      this.cleanActive();
      throw error;
    }
  }

  clear(): void {
    if (this.destroyed) return;
    this.generation += 1;
    this.openFileAction = null;
    this.cleanActive();
  }

  setLayout(layout: CollabDiffLayout): void {
    if (this.destroyed || this.currentLayout === layout) return;
    this.currentLayout = layout;
    const instance = this.active?.instance;
    if (!instance) return;
    instance.setOptions(this.pierreOptions(this.themeSource.current()));
    instance.rerender();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.generation += 1;
    this.openFileAction = null;
    this.cleanActive();
    this.unsubscribeTheme();
  }

  private cleanActive(): void {
    if (!this.active) return;
    this.active.instance.cleanUp();
    this.active.container.replaceChildren();
    this.active = null;
  }

  private pierreOptions(themeType: CollabDiffTheme): PierreDiffOptions {
    return {
      diffStyle: this.currentLayout,
      disableErrorHandling: true,
      overflow: 'wrap',
      preferredHighlighter: 'shiki-js',
      ...(this.openFileAction
        ? { renderHeaderFilenameSuffix: this.renderHeaderFilenameSuffix }
        : {}),
      themeType,
      unsafeCSS: OBSIDIAN_DIFF_THEME_CSS,
    };
  }

  private readonly renderHeaderFilenameSuffix = (): HTMLElement => {
    const action = this.openFileAction;
    const button = createEl('button');
    button.type = 'button';
    button.className = [
      'claudian-collab-review-display-toggle',
      'claudian-collab-review-file-open',
    ].join(' ');
    button.dataset.collabReviewOpenFile = '';
    button.setAttribute('aria-label', t('collab.review.openFile'));
    appendExternalLinkIcon(button);
    button.addEventListener('click', event => {
      event.stopPropagation();
      action?.();
    });
    return button;
  };
}
