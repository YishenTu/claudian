import { type Extension, type Range, StateEffect, StateField, Text, Transaction } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import { type App, MarkdownView, normalizePath, Notice, TFile } from 'obsidian';

import type { AiEditReviewPersistence } from '../../core/storage/AiEditReviewPersistence';
import type { ToolDiffData } from '../../core/types';
import { getEditorView } from '../../utils/editor';
import { getVaultPath, normalizePathForVault } from '../../utils/path';
import {
  type AiEditHighlightKind,
  type AiEditReviewAnchor,
  type AiEditReviewSpec,
  createAiEditReviewAnchor,
  createAiEditReviewAnchorFromOffsets,
  createAiEditReviewSpecs,
  resolveAiEditReview,
  resolveAiEditReviewAnchor,
  type ResolvedAiEditReview,
} from './AiEditHighlightRanges';
import { calculateDocumentDiff, normalizeReviewText } from './DocumentDiff';
import { VaultEditCapture } from './VaultEditCapture';

interface StoredAiEditReview extends AiEditReviewSpec {
  id: string;
  path: string;
}

interface RenderedAiEditReview {
  review: StoredAiEditReview;
  resolved: ResolvedAiEditReview;
}

interface AiEditReviewRendering {
  reviews: readonly RenderedAiEditReview[];
  onAccept: (reviewId: string) => void;
  onRevert: (reviewId: string, editorView: EditorView) => void;
}

interface OpenEditorCapture {
  fallbackOnly: boolean;
  attempt: number;
  completed: boolean;
  snapshots: Map<string, string>;
  fallbackDiffs: Map<string, ToolDiffData[]>;
  timer?: number;
}

class AiEditReviewWidget extends WidgetType {
  constructor(
    private readonly rendered: RenderedAiEditReview,
    private readonly actions: Pick<AiEditReviewRendering, 'onAccept' | 'onRevert'>,
  ) {
    super();
  }

  toDOM(editorView: EditorView): HTMLElement {
    const { kind, originalLines } = this.rendered.resolved;
    const document = editorView.dom.ownerDocument;
    const ownerWindow = getObsidianWindow(document);
    const reviewEl = ownerWindow.createEl(kind === 'added' ? 'span' : 'div', {
      cls: `claudian-ai-edit-review claudian-ai-edit-review--${kind}`,
    });
    reviewEl.setAttribute('role', 'region');
    reviewEl.setAttribute('aria-label', `${getKindLabel(kind)} AI change review`);
    reviewEl.setAttribute('data-claudian-ai-edit-id', this.rendered.review.id);

    const actionsEl = reviewEl.createSpan({ cls: 'claudian-ai-edit-review-actions' });
    actionsEl.setAttribute('role', 'toolbar');
    actionsEl.setAttribute('aria-label', 'AI change actions');
    actionsEl.append(
      createActionButton(ownerWindow, 'Revert change', 'revert', () => {
        this.actions.onRevert(this.rendered.review.id, editorView);
      }),
      createActionButton(ownerWindow, 'Accept change', 'accept', () => {
        this.actions.onAccept(this.rendered.review.id);
      }),
    );
    reviewEl.appendChild(actionsEl);

    if (kind === 'modified' || kind === 'deleted') {
      const originalEl = ownerWindow.createDiv({ cls: 'claudian-ai-edit-review-original' });
      const lines = originalLines.map(text => {
        const line = ownerWindow.createEl('del', { cls: 'claudian-ai-edit-review-deleted-line' });
        line.textContent = text || '\u00a0';
        originalEl.appendChild(line);
        return line;
      });
      reviewEl.appendChild(originalEl);
      if (lines.length > 2) {
        const remaining = lines.length - 2;
        const collapsedLabel = `Show ${remaining} more deleted ${remaining === 1 ? 'line' : 'lines'}`;
        let expanded = false;
        const toggle = ownerWindow.createEl('button', {
          cls: 'claudian-ai-edit-review-expand',
          text: collapsedLabel,
          attr: { type: 'button', 'aria-expanded': 'false' },
        });
        const update = () => {
          lines.slice(2).forEach(line => { line.hidden = !expanded; });
          toggle.textContent = expanded ? 'Show fewer deleted lines' : collapsedLabel;
          toggle.setAttribute('aria-expanded', String(expanded));
        };
        toggle.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          expanded = !expanded;
          update();
          editorView.requestMeasure();
        });
        update();
        reviewEl.appendChild(toggle);
      }
    }

    return reviewEl;
  }

  eq(other: AiEditReviewWidget): boolean {
    return this.rendered.review.id === other.rendered.review.id;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const replaceAiEditHighlights = StateEffect.define<AiEditReviewRendering>();
const clearAiEditHighlights = StateEffect.define<null>();
const editObservers = new WeakMap<EditorView, (
  transaction: Transaction,
  isManual: boolean,
) => void>();

const aiEditHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (decorations, transaction) => {
    for (const effect of transaction.effects) {
      if (effect.is(replaceAiEditHighlights)) {
        return createDecorations(transaction.state.doc, effect.value);
      }
      if (effect.is(clearAiEditHighlights)) {
        return Decoration.none;
      }
    }
    return decorations.map(transaction.changes);
  },
  provide: field => EditorView.decorations.from(field),
});

// Live Preview replaces source ranges with host widgets. Line decorations and
// review widgets inside those ranges are hidden by CodeMirror's replacement.
// Mirror only the hidden reviews into the host DOM, leaving its renderer intact.
const renderedBlockReviews = ViewPlugin.fromClass(class {
  private readonly observer: MutationObserver;
  private readonly marked = new Set<HTMLElement>();
  private readonly mirrors = new Map<string, HTMLElement>();
  private queued = false;
  private disposed = false;

  constructor(private readonly view: EditorView) {
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(view.contentDOM, { childList: true, subtree: true });
    this.schedule();
  }

  update(): void { this.schedule(); }

  private schedule(): void {
    if (this.queued || this.disposed) return;
    this.queued = true;
    void Promise.resolve().then(() => {
      this.queued = false;
      if (!this.disposed) this.sync();
    });
  }

  private sync(): void {
    const { view } = this;
    const decorations = view.state.field(aiEditHighlightField);
    const blocks = [...view.contentDOM.querySelectorAll<HTMLElement>('.cm-embed-block')]
      .filter(block => !block.parentElement?.closest('.cm-embed-block'));
    const marked = new Set<HTMLElement>();
    const mirrored = new Set<string>();
    const visibleIds = new Set([...view.contentDOM.querySelectorAll(
      '.claudian-ai-edit-review:not(.claudian-ai-edit-review--mirror)',
    )].map(element => element.getAttribute('data-claudian-ai-edit-id')));
    let geometryChanged = false;
    for (const block of blocks) {
      const from = view.posAtDOM(block, 0);
      const domEnd = view.posAtDOM(block, block.childNodes.length);
      // Obsidian also renders math with a zero-length block widget plus a
      // separate source replacement. Its DOM endpoints both map to the start.
      const to = domEnd > from ? domEnd : view.lineBlockAt(from).to;
      if (from >= to) continue;
      decorations.between(from, to, (position, _, decoration) => {
        const spec = decoration.spec as {
          attributes?: Record<string, string>;
          aiEditReviewId?: string;
          widget?: AiEditReviewWidget;
        };
        const attributes = spec.attributes;
        if (position < to && attributes?.['data-claudian-ai-edit-kind']) {
          if (!marked.has(block)) {
            block.setAttribute('data-claudian-ai-edit-id', attributes['data-claudian-ai-edit-id']);
          }
          marked.add(block);
          block.classList.add('claudian-ai-edit-highlight', 'claudian-ai-edit-highlight--rendered');
        }
        const id = spec.aiEditReviewId;
        if (!id || !spec.widget || mirrored.has(id)) return;
        if (visibleIds.has(id)) return;
        mirrored.add(id);
        let mirror = this.mirrors.get(id);
        if (!mirror) {
          mirror = spec.widget.toDOM(view);
          mirror.classList.add('claudian-ai-edit-review--mirror');
          this.mirrors.set(id, mirror);
        }
        if (mirror.parentElement !== block) {
          block.appendChild(mirror);
          geometryChanged = true;
        }
      });
    }
    for (const block of this.marked) {
      if (!marked.has(block)) {
        block.classList.remove('claudian-ai-edit-highlight', 'claudian-ai-edit-highlight--rendered');
        block.removeAttribute('data-claudian-ai-edit-id');
      }
    }
    this.marked.clear();
    marked.forEach(block => this.marked.add(block));
    for (const [id, mirror] of this.mirrors) {
      if (!mirrored.has(id)) {
        mirror.remove();
        this.mirrors.delete(id);
        geometryChanged = true;
      }
    }
    if (geometryChanged) view.requestMeasure();
  }

  destroy(): void {
    this.disposed = true;
    this.observer.disconnect();
    this.mirrors.forEach(mirror => mirror.remove());
    this.marked.forEach(block => {
      block.classList.remove('claudian-ai-edit-highlight', 'claudian-ai-edit-highlight--rendered');
      block.removeAttribute('data-claudian-ai-edit-id');
    });
  }
});

export const aiEditHighlightExtension: Extension = [
  aiEditHighlightField,
  renderedBlockReviews,
  EditorView.updateListener.of(update => {
    for (const transaction of update.transactions) {
      if (!transaction.docChanged) continue;
      const isManual = !transaction.annotation(Transaction.remote)
        && ['input', 'delete', 'move', 'undo', 'redo']
          .some(event => transaction.isUserEvent(event));
      editObservers.get(update.view)?.(transaction, isManual);
    }
  }),
  EditorView.domEventObservers({
    mouseover: (event, view) => updateHoveredReview(view, event.target),
    mouseout: (event, view) => updateHoveredReview(view, event.relatedTarget),
  }),
];

function updateHoveredReview(view: EditorView, target: EventTarget | null): void {
  const node = target as Node | null;
  const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
  const marker = element?.closest('[data-claudian-ai-edit-id]');
  const reviewId = marker && view.dom.contains(marker)
    ? marker.getAttribute('data-claudian-ai-edit-id')
    : null;
  for (const review of view.dom.querySelectorAll('.claudian-ai-edit-review')) {
    review.classList.toggle('claudian-ai-edit-review--hovered',
      reviewId !== null && review.getAttribute('data-claudian-ai-edit-id') === reviewId);
  }
}

const POST_EDIT_REFRESH_DELAY_MS = 300;
const OPEN_EDITOR_CAPTURE_DELAYS_MS = [0, 300, 1000] as const;

export class AiEditHighlightController {
  private readonly reviewsByPath = new Map<string, StoredAiEditReview[]>();
  private readonly refreshTimers = new Map<string, number>();
  private readonly openEditorCaptures = new Map<string, OpenEditorCapture>();
  private nextReviewId = 1;
  private persistenceReady = false;
  private persistenceDirty = false;
  private persistenceWriting = false;
  private pendingPersistence = Promise.resolve();
  private disposed = false;
  private captureErrorShown = false;
  private incompleteDiffShown = false;
  private enabled = true;
  private readonly vaultCapture: VaultEditCapture;

  constructor(private readonly app: App, private readonly persistence?: AiEditReviewPersistence) {
    this.vaultCapture = new VaultEditCapture(app,
      (path, before, after) => this.recordDocumentChange(path, before, after),
      () => {
        if (this.captureErrorShown) return;
        this.captureErrorShown = true;
        new Notice('Some notes could not be read for AI change review. Their changes may be missing.');
      },
      path => this.getOpenEditorText(path),
    );
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || this.enabled === enabled) return;
    this.enabled = enabled;
    if (enabled) {
      this.observeEditors();
      for (const path of this.reviewsByPath.keys()) {
        this.refreshVisibleFile(path);
        this.scheduleRefresh(path);
      }
      return;
    }

    this.vaultCapture.cancel();
    for (const captureId of this.openEditorCaptures.keys()) {
      this.removeOpenEditorCapture(captureId);
    }
    this.clearRefreshTimers();
    this.clearVisibleHighlights();
  }

  async beginVaultCapture(captureId: string): Promise<void> {
    if (!this.enabled) return;
    this.observeEditors();
    this.captureErrorShown = false;
    await this.vaultCapture.begin(captureId);
  }

  async completeVaultCapture(captureId: string): Promise<void> {
    if (!this.enabled) {
      await this.flush();
      return;
    }
    await this.vaultCapture.finish(captureId);
    await this.flush();
  }

  async initialize(): Promise<void> {
    if (!this.persistence || this.persistenceReady) return;
    try {
      const data = await this.persistence.load();
      const decodedDocument = decodeStoredReviews(data);
      const decoded = decodedDocument.reviews;
      for (const review of decoded) {
        const path = this.resolveVaultMarkdownPath(review.path);
        if (path !== review.path) throw new Error('Invalid review path');
      }
      const reviews: StoredAiEditReview[] = [];
      let repaired = decodedDocument.version < 2;
      let repairIncomplete = false;
      for (const review of decoded) {
        const result = await this.repairRestoredReview(review);
        reviews.push(...result.reviews);
        repaired ||= result.changed;
        repairIncomplete ||= result.incomplete;
      }
      for (const review of reviews) {
        const stored = this.reviewsByPath.get(review.path) ?? [];
        stored.push({ ...review, id: `ai-edit-${this.nextReviewId++}` });
        this.reviewsByPath.set(review.path, stored);
      }
      for (const [path, stored] of this.reviewsByPath) {
        const documentText = this.getOpenEditorText(path);
        if (documentText !== null) repaired ||= anchorStoredReviews(documentText, stored);
      }
      this.persistenceReady = true;
      if (repaired) this.persist();
      if (repairIncomplete) {
        new Notice('Some saved AI reviews could not be safely refined. Their existing review data was preserved.');
      }
      for (const path of this.reviewsByPath.keys()) {
        this.refreshVisibleFile(path);
        this.scheduleRefresh(path);
      }
    } catch {
      new Notice('Could not restore pending AI reviews. The saved review file has been preserved.');
    }
  }

  private async repairRestoredReview(review: StoredAiEditReview): Promise<RestoredReviewRepair> {
    if (review.kind !== 'modified'
      || review.originalLines.length <= 1
      || review.currentLines.length <= 1) {
      return { reviews: [review], changed: false, incomplete: false };
    }

    const diff = calculateDocumentDiff(
      review.path,
      review.originalLines.join('\n'),
      review.currentLines.join('\n'),
    );
    if (diff.status === 'unchanged') {
      return { reviews: [review], changed: false, incomplete: false };
    }
    if (diff.status === 'incomplete') {
      return { reviews: [review], changed: false, incomplete: true };
    }
    const localSpecs = createAiEditReviewSpecs(diff.diff.diffLines, {
      lineNumbersAreDocumentRelative: true,
    });
    if (isEquivalentReview(review, localSpecs)) {
      return { reviews: [review], changed: false, incomplete: false };
    }

    let documentText = this.getOpenEditorText(review.path);
    if (documentText === null) {
      try {
        const file = this.app.vault.getFileByPath(review.path);
        documentText = file instanceof TFile
          ? normalizeReviewText(await this.app.vault.read(file))
          : null;
      } catch {
        documentText = null;
      }
    }
    if (documentText === null) {
      return { reviews: [review], changed: false, incomplete: true };
    }
    const resolved = resolveAiEditReview(documentText, review);
    if (!resolved || resolved.kind !== 'modified') {
      return { reviews: [review], changed: false, incomplete: true };
    }

    const lineOffset = resolved.fromLine - 1;
    const absoluteLines = diff.diff.diffLines.map(line => ({
      ...line,
      ...(line.oldLineNum === undefined ? {} : { oldLineNum: line.oldLineNum + lineOffset }),
      ...(line.newLineNum === undefined ? {} : { newLineNum: line.newLineNum + lineOffset }),
    }));
    const specs = createAiEditReviewSpecs(absoluteLines, {
      lineNumbersAreDocumentRelative: true,
    });
    return {
      reviews: specs.map((spec, index) => ({
        ...spec,
        beforeText: spec.beforeText ?? (index === 0 ? review.beforeText : undefined),
        afterText: spec.afterText ?? (index === specs.length - 1 ? review.afterText : undefined),
        path: review.path,
        id: '',
      })),
      changed: true,
      incomplete: false,
    };
  }

  async flush(): Promise<void> {
    await this.vaultCapture.flush();
    await this.pendingPersistence;
    await this.persistence?.flush();
  }

  private persist(): void {
    if (!this.persistenceReady || !this.persistence) return;
    this.persistenceDirty = true;
    if (this.persistenceWriting) return;
    this.persistenceWriting = true;
    // Hold only the in-flight serialized snapshot; later changes coalesce in
    // the controller's authoritative records rather than queuing full copies.
    this.pendingPersistence = Promise.resolve().then(async () => {
      try {
        while (this.persistenceDirty) {
          this.persistenceDirty = false;
          await this.persistence!.save({
            version: 2,
            reviews: [...this.reviewsByPath.values()].flat(),
          });
        }
      } catch {
        new Notice('Could not save pending AI reviews. Keep Obsidian open and try again.');
      } finally {
        this.persistenceWriting = false;
      }
    });
  }

  recordDiffs(diffs: readonly ToolDiffData[]): void {
    if (!this.enabled) return;
    const affectedPaths = new Set<string>();
    for (const diff of diffs) {
      const path = this.resolveVaultMarkdownPath(diff.filePath);
      if (!path || diff.diffLines.length === 0) continue;
      if (this.vaultCapture.active) {
        this.vaultCapture.changed(path);
        continue;
      }

      // Tool completion can precede Obsidian's editor reload. Prefer the
      // captured before/after document over anchoring a patch in stale text.
      const capture = [...this.openEditorCaptures.values()].find(candidate => (
        !candidate.fallbackOnly && candidate.completed && candidate.snapshots.has(path)
      ));
      if (capture) {
        const pending = capture.fallbackDiffs.get(path) ?? [];
        pending.push(diff);
        capture.fallbackDiffs.set(path, pending);
        continue;
      }

      const incoming = createAiEditReviewSpecs(diff.diffLines, {
        lineNumbersAreDocumentRelative: diff.lineNumbersAreDocumentRelative,
      });
      const currentText = this.getOpenEditorText(path);
      const merged = mergePendingReviews(
        this.reviewsByPath.get(path) ?? [], incoming, currentText,
      );
      const stored = merged.map(spec => ({
        ...spec,
        id: `ai-edit-${this.nextReviewId++}`,
        path,
      }));
      if (currentText !== null) anchorStoredReviews(currentText, stored);
      if (stored.length === 0) this.reviewsByPath.delete(path);
      else this.reviewsByPath.set(path, stored);
      affectedPaths.add(path);
    }

    for (const path of affectedPaths) {
      this.refreshVisibleFile(path);
      this.scheduleRefresh(path);
      this.advanceFallbackCaptures(path);
    }
    if (affectedPaths.size > 0) this.persist();
  }

  beginOpenEditorCapture(captureId: string, fallbackOnly = false): void {
    if (!this.enabled) return;
    if (this.vaultCapture.active) return;
    this.observeEditors();
    if (this.openEditorCaptures.has(captureId)) return;

    const snapshots = new Map<string, string>();
    for (const view of this.getMarkdownViews()) {
      const path = view.file?.path;
      const editorView = getEditorView(view.editor);
      if (!path || !path.toLowerCase().endsWith('.md') || !editorView || snapshots.has(path)) {
        continue;
      }
      snapshots.set(path, editorView.state.doc.toString());
    }
    this.openEditorCaptures.set(captureId, {
      fallbackOnly,
      attempt: 0,
      completed: false,
      snapshots,
      fallbackDiffs: new Map(),
    });
  }

  completeOpenEditorCapture(captureId: string, succeeded: boolean): void {
    if (!this.enabled) return;
    const capture = this.openEditorCaptures.get(captureId);
    if (!capture) return;
    // Even a failed command may have written part of a file.
    void succeeded;
    if (capture.completed) return;
    capture.completed = true;
    this.scheduleOpenEditorCaptureCheck(captureId);
  }

  hasHighlights(): boolean {
    return this.reviewsByPath.size > 0;
  }

  clearAll(): void {
    this.reviewsByPath.clear();
    this.clearRefreshTimers();
    for (const view of this.getMarkdownViews()) {
      const editorView = getEditorView(view.editor);
      editorView?.dispatch({ effects: clearAiEditHighlights.of(null) });
    }
    this.persist();
  }

  handleFileOpened(file: TFile | null): void {
    if (!this.enabled) return;
    this.observeEditors();
    if (file && this.reviewsByPath.has(file.path)) {
      this.refreshVisibleFile(file.path);
      this.scheduleRefresh(file.path);
    }
  }

  handleFileModified(file: TFile): void {
    this.vaultCapture.changed(file.path);
    if (this.enabled && this.reviewsByPath.has(file.path)) {
      this.scheduleRefresh(file.path);
    }
  }

  handleFileRenamed(file: TFile, oldPath: string): void {
    this.vaultCapture.rename(oldPath, file.path);
    const stored = this.reviewsByPath.get(oldPath);
    if (!stored) return;
    this.reviewsByPath.delete(oldPath);
    this.reviewsByPath.set(file.path, stored.map(review => ({
      ...review,
      path: file.path,
    })));
    this.refreshVisibleFile(file.path);
    this.persist();
  }

  handleFileDeleted(file: TFile): void {
    if (this.vaultCapture.active) {
      this.vaultCapture.changed(file.path);
      return;
    }
    this.reviewsByPath.delete(file.path);
    this.cancelRefresh(file.path);
    this.persist();
  }

  dispose(): void {
    this.disposed = true;
    this.vaultCapture.dispose();
    for (const captureId of this.openEditorCaptures.keys()) {
      this.removeOpenEditorCapture(captureId);
    }
    this.clearRefreshTimers();
    this.clearVisibleHighlights();
  }

  private scheduleOpenEditorCaptureCheck(captureId: string): void {
    const capture = this.openEditorCaptures.get(captureId);
    if (!capture) return;
    const delay = OPEN_EDITOR_CAPTURE_DELAYS_MS[capture.attempt];
    capture.timer = window.setTimeout(() => {
      capture.timer = undefined;
      this.checkOpenEditorCapture(captureId);
    }, delay);
  }

  private checkOpenEditorCapture(captureId: string): void {
    const capture = this.openEditorCaptures.get(captureId);
    if (!capture) return;

    const diffs: ToolDiffData[] = [];
    for (const [path, beforeText] of capture.snapshots) {
      const afterText = this.getOpenEditorText(path);
      if (afterText === null || afterText === beforeText) continue;
      const result = calculateDocumentDiff(path, beforeText, afterText);
      if (result.status === 'incomplete') continue;
      if (result.status === 'complete') diffs.push(result.diff);
      capture.snapshots.delete(path);
      capture.fallbackDiffs.delete(path);
    }
    if (diffs.length > 0) this.recordDiffs(diffs);

    capture.attempt++;
    if (
      capture.snapshots.size === 0
      || capture.attempt >= OPEN_EDITOR_CAPTURE_DELAYS_MS.length
    ) {
      const fallbackDiffs = [...capture.fallbackDiffs.values()].flat();
      if (capture.snapshots.size > 0 && fallbackDiffs.length === 0) {
        this.showIncompleteDiffNotice();
      }
      this.removeOpenEditorCapture(captureId);
      this.recordDiffs(fallbackDiffs);
      return;
    }
    this.scheduleOpenEditorCaptureCheck(captureId);
  }

  private getOpenEditorText(path: string): string | null {
    for (const view of this.getMarkdownViews()) {
      if (view.file?.path !== path) continue;
      const editorView = getEditorView(view.editor);
      if (editorView) return editorView.state.doc.toString();
    }
    return null;
  }

  private advanceFallbackCaptures(path: string): void {
    const text = this.getOpenEditorText(path);
    if (text === null) return;
    for (const capture of this.openEditorCaptures.values()) {
      if (capture.fallbackOnly && capture.snapshots.has(path)) capture.snapshots.set(path, text);
    }
  }

  private removeOpenEditorCapture(captureId: string): void {
    const capture = this.openEditorCaptures.get(captureId);
    if (!capture) return;
    if (capture.timer !== undefined) window.clearTimeout(capture.timer);
    this.openEditorCaptures.delete(captureId);
  }

  private scheduleRefresh(path: string): void {
    if (!this.enabled) return;
    this.cancelRefresh(path);
    const timer = window.setTimeout(() => {
      this.refreshTimers.delete(path);
      this.refreshVisibleFile(path);
    }, POST_EDIT_REFRESH_DELAY_MS);
    this.refreshTimers.set(path, timer);
  }

  private cancelRefresh(path: string): void {
    const timer = this.refreshTimers.get(path);
    if (timer === undefined) return;
    window.clearTimeout(timer);
    this.refreshTimers.delete(path);
  }

  private clearRefreshTimers(): void {
    for (const timer of this.refreshTimers.values()) {
      window.clearTimeout(timer);
    }
    this.refreshTimers.clear();
  }

  private refreshVisibleFile(path: string): void {
    if (this.disposed || !this.enabled) return;
    this.observeEditors();
    const reviews = this.reviewsByPath.get(path) ?? [];

    for (const view of this.getMarkdownViews()) {
      if (view.file?.path !== path) continue;
      const editorView = getEditorView(view.editor);
      if (!editorView) continue;
      const documentText = editorView.state.doc.toString();
      const renderedReviews = resolveStoredReviews(documentText, reviews);
      if (anchorResolvedReviews(documentText, renderedReviews)) this.persist();
      editorView.dispatch({
        effects: replaceAiEditHighlights.of({
          reviews: renderedReviews,
          onAccept: reviewId => this.acceptReview(path, reviewId),
          onRevert: (reviewId, targetView) => this.revertReview(path, reviewId, targetView),
        }),
      });
    }
  }

  private acceptReview(path: string, reviewId: string): void {
    if (!this.removeReview(path, reviewId)) return;
    this.refreshVisibleFile(path);
  }

  private observeEditors(): void {
    if (!this.enabled) return;
    for (const view of this.getMarkdownViews()) {
      const editor = getEditorView(view.editor);
      const path = view.file?.path;
      if (editor && path) {
        editObservers.set(editor, (transaction, isManual) => (
          this.handleEditorTransaction(path, transaction, isManual)
        ));
      }
    }
  }

  private handleEditorTransaction(
    path: string,
    transaction: Transaction,
    isManual: boolean,
  ): void {
    if (!this.enabled) return;
    if (isManual) {
      this.handleManualEdit(path, transaction);
      return;
    }
    this.mapUntouchedReviews(path, transaction);
  }

  private handleManualEdit(path: string, transaction: Transaction): void {
    this.vaultCapture.manualEdit(path, transaction.startState.doc.toString(), transaction.newDoc.toString(),
      () => this.dismissManualReviews(path, transaction));
  }

  private dismissManualReviews(path: string, transaction: Transaction): void {
    if (this.disposed) return;
    const before = transaction.startState.doc;
    const retained = (this.reviewsByPath.get(path) ?? []).filter(review => {
      const resolved = resolveAiEditReview(before.toString(), review);
      if (!resolved) return true;
      const span = anchoredSpan(before.toString(), review, resolved);
      let touched = false;
      transaction.changes.iterChangedRanges((from, to) => {
        if (from === to) touched ||= span.from <= from && from <= span.to;
        else touched ||= spansOverlap(span, { from, to });
      });
      if (touched) return false;
      mapReviewAnchor(review, span, transaction);
      return true;
    });
    if (retained.length) this.reviewsByPath.set(path, retained);
    else this.reviewsByPath.delete(path);
    this.advanceFallbackCaptures(path);
    this.persist();
    // CodeMirror forbids a nested dispatch from an update listener.
    void Promise.resolve().then(() => this.refreshVisibleFile(path));
  }

  private mapUntouchedReviews(path: string, transaction: Transaction): void {
    if (this.disposed) return;
    const beforeText = transaction.startState.doc.toString();
    let changed = false;
    let needsRefresh = false;
    for (const review of this.reviewsByPath.get(path) ?? []) {
      const resolved = resolveAiEditReview(beforeText, review);
      if (!resolved) continue;
      needsRefresh = true;
      const span = anchoredSpan(beforeText, review, resolved);
      let touched = false;
      transaction.changes.iterChangedRanges((from, to) => {
        if (from === to) touched ||= span.from < from && from < span.to;
        else touched ||= spansOverlap(span, { from, to });
      });
      if (touched) continue;
      mapReviewAnchor(review, span, transaction);
      changed = true;
    }
    if (changed) this.persist();
    if (needsRefresh) void Promise.resolve().then(() => this.refreshVisibleFile(path));
  }

  private revertReview(path: string, reviewId: string, editorView: EditorView): void {
    const review = this.reviewsByPath.get(path)?.find(candidate => candidate.id === reviewId);
    if (!review) return;

    const resolved = resolveAiEditReview(editorView.state.doc.toString(), review);
    if (!resolved) {
      new Notice('Cannot revert this AI change because the surrounding content changed.');
      this.refreshVisibleFile(path);
      return;
    }

    const changes = createRevertChange(editorView.state.doc, resolved);
    const before = editorView.state.doc.toString();
    editorView.dispatch({ changes });
    this.vaultCapture.manualEdit(path, before, editorView.state.doc.toString(), () => {});
    this.advanceFallbackCaptures(path);
    this.removeReview(path, reviewId);
    this.refreshVisibleFile(path);
  }

  private removeReview(path: string, reviewId: string): boolean {
    const reviews = this.reviewsByPath.get(path);
    if (!reviews) return false;
    const index = reviews.findIndex(review => review.id === reviewId);
    if (index < 0) return false;
    reviews.splice(index, 1);
    if (reviews.length === 0) this.reviewsByPath.delete(path);
    this.persist();
    return true;
  }

  private recordDocumentChange(path: string, before: string, after: string): void {
    if (before === after || !this.resolveVaultMarkdownPath(path)) return;
    const composition = composePendingReviews(this.reviewsByPath.get(path) ?? [], before, after);
    if (composition.status === 'incomplete') {
      this.showIncompleteDiffNotice();
      return;
    }
    const reviews = composition.reviews
      .map(spec => ({ ...spec, path, id: `ai-edit-${this.nextReviewId++}` }));
    anchorStoredReviews(after, reviews);
    if (reviews.length) this.reviewsByPath.set(path, reviews);
    else this.reviewsByPath.delete(path);
    this.refreshVisibleFile(path);
    this.scheduleRefresh(path);
    this.persist();
  }

  private showIncompleteDiffNotice(): void {
    if (this.incompleteDiffShown) return;
    this.incompleteDiffShown = true;
    new Notice('An AI edit was too large to compare safely. Existing pending reviews were preserved.');
  }

  private getMarkdownViews(): MarkdownView[] {
    return this.app.workspace
      .getLeavesOfType('markdown')
      .map(leaf => leaf.view)
      .filter((view): view is MarkdownView => view instanceof MarkdownView);
  }

  private clearVisibleHighlights(): void {
    for (const view of this.getMarkdownViews()) {
      const editor = getEditorView(view.editor);
      if (!editor) continue;
      editObservers.delete(editor);
      editor.dispatch({ effects: clearAiEditHighlights.of(null) });
    }
  }

  private resolveVaultMarkdownPath(rawPath: string): string | null {
    const relativePath = normalizePathForVault(rawPath, getVaultPath(this.app));
    if (!relativePath) return null;

    const normalized = normalizePath(relativePath);
    if (
      normalized.startsWith('/')
      || /^[A-Za-z]:\//.test(normalized)
      || normalized.split('/').includes('..')
      || !normalized.toLowerCase().endsWith('.md')
    ) {
      return null;
    }
    return normalized;
  }
}

interface ReviewSpan { from: number; to: number }

function spansOverlap(left: ReviewSpan, right: ReviewSpan): boolean {
  if (left.from === left.to && right.from === right.to) return left.from === right.from;
  if (left.from === left.to) return right.from <= left.from && left.from < right.to;
  if (right.from === right.to) return left.from < right.from && right.from < left.to;
  return left.from < right.to && right.from < left.to;
}

function resolvedSpan(document: Text, review: ResolvedAiEditReview): ReviewSpan {
  if (review.kind === 'deleted') {
    const from = createRevertChange(document, review).from;
    return { from, to: from };
  }
  return { from: document.line(review.fromLine).from, to: document.line(review.toLine).to };
}

function anchoredSpan(
  documentText: string,
  review: StoredAiEditReview,
  resolved: ResolvedAiEditReview,
): ReviewSpan {
  review.anchor ??= createAiEditReviewAnchor(documentText, resolved);
  return resolveAiEditReviewAnchor(documentText, review.anchor)
    ?? resolvedSpan(Text.of(documentText.split('\n')), resolved);
}

function mapReviewAnchor(
  review: StoredAiEditReview,
  span: ReviewSpan,
  transaction: Transaction,
): void {
  const mappedFrom = transaction.changes.mapPos(span.from, 1);
  const mappedTo = span.from === span.to
    ? mappedFrom
    : transaction.changes.mapPos(span.to, -1);
  const documentText = transaction.newDoc.toString();
  review.anchor = createAiEditReviewAnchorFromOffsets(documentText, mappedFrom, mappedTo);
  const mapped = resolveAiEditReview(documentText, review);
  if (mapped) updateReviewFallbackContext(documentText, review, mapped);
}

function mergePendingReviews(
  stored: StoredAiEditReview[],
  incoming: AiEditReviewSpec[],
  currentText: string | null,
): AiEditReviewSpec[] {
  if (currentText === null || stored.length === 0) return [...stored, ...incoming];
  const document = Text.of(currentText.split('\n'));
  const resolved = incoming.map(spec => resolveAiEditReview(currentText, spec));
  if (resolved.some(review => review === null)) return [...stored, ...incoming];
  const reviews = resolved as ResolvedAiEditReview[];
  const changes = reviews.map(review => createRevertChange(document, review))
    .sort((left, right) => left.from - right.from);
  if (changes.some((change, index) => index > 0 && change.from < changes[index - 1].to)) return [...stored, ...incoming];

  // Reconstruct only for comparison. Never write the previous document back.
  let beforeText = currentText;
  for (const change of [...changes].reverse()) {
    beforeText = beforeText.slice(0, change.from) + change.insert + beforeText.slice(change.to);
  }
  const composition = composePendingReviews(stored, beforeText, currentText);
  return composition.status === 'complete' ? composition.reviews : [...stored, ...incoming];
}

interface PendingReviewCompositionResult {
  status: 'complete' | 'incomplete';
  reviews: AiEditReviewSpec[];
}

function composePendingReviews(
  stored: readonly StoredAiEditReview[], beforeText: string, afterText: string,
): PendingReviewCompositionResult {
  beforeText = normalizeReviewText(beforeText);
  afterText = normalizeReviewText(afterText);
  const document = Text.of(beforeText.split('\n'));
  const afterDocument = Text.of(afterText.split('\n'));
  const resolved = resolveStoredReviews(beforeText, stored);
  const resolvedIds = new Set(resolved.map(item => item.review.id));
  const incoming = calculateDocumentDiff('', beforeText, afterText);
  if (incoming.status === 'incomplete') return { status: 'incomplete', reviews: [...stored] };
  if (incoming.status === 'unchanged') return { status: 'complete', reviews: [...stored] };
  const equalLines = new Map<number, number>();
  for (const line of incoming.diff.diffLines) {
    if (line.type === 'equal' && line.oldLineNum !== undefined && line.newLineNum !== undefined) {
      equalLines.set(line.oldLineNum, line.newLineNum);
    }
  }
  const unchanged: StoredAiEditReview[] = [];
  const affected = resolved.filter(item => {
    const previous = item.resolved;
    let start: number;
    let end: number;
    if (previous.kind === 'deleted') {
      const left = previous.insertionAfterLine === 0 ? 0 : equalLines.get(previous.insertionAfterLine);
      const right = previous.insertionAfterLine === document.lines
        ? afterDocument.lines + 1 : equalLines.get(previous.insertionAfterLine + 1);
      if (left === undefined || right !== left + 1) return true;
      start = left + 1;
      end = left;
    } else {
      const mapped = equalLines.get(previous.fromLine);
      if (mapped === undefined) return true;
      for (let line = previous.fromLine; line <= previous.toLine; line++) {
        if (equalLines.get(line) !== mapped + line - previous.fromLine) return true;
      }
      start = mapped;
      end = mapped + previous.toLine - previous.fromLine;
    }
    unchanged.push({
      ...item.review,
      hintedLine: start,
      hintedLineIsExact: true,
      ...(previous.kind === 'deleted' ? { hintedInsertionAfterLine: end } : {}),
      beforeText: start > 1 ? afterDocument.line(start - 1).text : undefined,
      afterText: end < afterDocument.lines ? afterDocument.line(end + 1).text : undefined,
    });
    return false;
  });
  // Keep untouched pending edits anchored. Re-diffing their original text
  // globally can pair a repeated formula with a different occurrence.
  const changes = affected.map(item => createRevertChange(document, item.resolved))
    .sort((left, right) => right.from - left.from);
  let baseline = beforeText;
  let boundary = document.length;
  for (const change of changes) {
    if (change.to > boundary) return { status: 'complete', reviews: [...stored] };
    baseline = baseline.slice(0, change.from) + change.insert + baseline.slice(change.to);
    boundary = change.from;
  }
  const diff = calculateDocumentDiff('', baseline, afterText);
  if (diff.status === 'incomplete') return { status: 'incomplete', reviews: [...stored] };
  return {
    status: 'complete',
    reviews: [
      ...stored.filter(review => !resolvedIds.has(review.id)),
      ...unchanged,
      ...(diff.status === 'complete'
        ? createAiEditReviewSpecs(diff.diff.diffLines, { lineNumbersAreDocumentRelative: true })
        : []),
    ],
  };
}

interface RestoredReviewRepair {
  reviews: StoredAiEditReview[];
  changed: boolean;
  incomplete: boolean;
}

function isEquivalentReview(
  review: StoredAiEditReview,
  specs: readonly AiEditReviewSpec[],
): boolean {
  return specs.length === 1
    && specs[0].kind === review.kind
    && specs[0].originalLines.length === review.originalLines.length
    && specs[0].currentLines.length === review.currentLines.length;
}

interface DecodedStoredReviews {
  version: 1 | 2;
  reviews: StoredAiEditReview[];
}

function decodeStoredReviews(value: unknown): DecodedStoredReviews {
  if (value === null) return { version: 2, reviews: [] };
  if (!value || typeof value !== 'object'
    || !('version' in value) || (value.version !== 1 && value.version !== 2)
    || !('reviews' in value) || !Array.isArray(value.reviews)) {
    throw new Error('Invalid review document');
  }
  const version = value.version;
  const reviews = value.reviews.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid review');
    const record = item as Record<string, unknown>;
    const { kind, path, originalLines, currentLines } = record;
    if ((kind !== 'added' && kind !== 'modified' && kind !== 'deleted')
      || typeof path !== 'string'
      || !Array.isArray(originalLines) || !originalLines.every(line => typeof line === 'string')
      || !Array.isArray(currentLines) || !currentLines.every(line => typeof line === 'string')
      || (kind === 'added' && (originalLines.length !== 0 || currentLines.length === 0))
      || (kind === 'deleted' && (currentLines.length !== 0 || originalLines.length === 0))
      || (kind === 'modified' && (!originalLines.length || !currentLines.length))) {
      throw new Error('Invalid review content');
    }
    const review: StoredAiEditReview = { id: '', path, kind, originalLines, currentLines };
    for (const field of ['beforeText', 'afterText'] as const) {
      if (record[field] === undefined) continue;
      if (typeof record[field] !== 'string') throw new Error('Invalid review context');
      review[field] = record[field];
    }
    for (const field of ['hintedLine', 'hintedInsertionAfterLine'] as const) {
      if (record[field] === undefined) continue;
      if (typeof record[field] !== 'number' || !Number.isSafeInteger(record[field])
        || record[field] < (field === 'hintedLine' ? 1 : 0)) throw new Error('Invalid review position');
      review[field] = record[field];
    }
    if (record.hintedLineIsExact !== undefined) {
      if (typeof record.hintedLineIsExact !== 'boolean') throw new Error('Invalid review coordinate mode');
      review.hintedLineIsExact = record.hintedLineIsExact;
    }
    if (record.anchor !== undefined) review.anchor = decodeStoredAnchor(record.anchor);
    return repairStoredLineEndings(review);
  });
  return { version, reviews };
}

function decodeStoredAnchor(value: unknown): AiEditReviewAnchor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid review anchor');
  }
  const anchor = value as Record<string, unknown>;
  const position = anchor.position;
  const quote = anchor.quote;
  if (!position || typeof position !== 'object' || Array.isArray(position)
    || !quote || typeof quote !== 'object' || Array.isArray(quote)) {
    throw new Error('Invalid review selectors');
  }
  const positionRecord = position as Record<string, unknown>;
  const quoteRecord = quote as Record<string, unknown>;
  if (positionRecord.type !== 'TextPositionSelector'
    || typeof positionRecord.start !== 'number'
    || typeof positionRecord.end !== 'number'
    || !Number.isSafeInteger(positionRecord.start)
    || !Number.isSafeInteger(positionRecord.end)
    || positionRecord.start < 0
    || positionRecord.end < positionRecord.start
    || quoteRecord.type !== 'TextQuoteSelector'
    || typeof quoteRecord.exact !== 'string'
    || typeof quoteRecord.prefix !== 'string'
    || typeof quoteRecord.suffix !== 'string') {
    throw new Error('Invalid review selectors');
  }
  return {
    position: {
      type: 'TextPositionSelector',
      start: positionRecord.start,
      end: positionRecord.end,
    },
    quote: {
      type: 'TextQuoteSelector',
      exact: quoteRecord.exact,
      prefix: quoteRecord.prefix,
      suffix: quoteRecord.suffix,
    },
  };
}

function repairStoredLineEndings(review: StoredAiEditReview): StoredAiEditReview[] {
  if (![...review.originalLines, ...review.currentLines, review.beforeText, review.afterText]
    .some(line => line?.endsWith('\r'))) return [review];
  const strip = (line: string): string => line.replace(/\r$/, '');
  const original = review.originalLines.map(strip).join('\n');
  const current = review.currentLines.map(strip).join('\n');
  const diff = calculateDocumentDiff(review.path, original, current);
  if (diff.status === 'unchanged') return [];
  if (diff.status === 'incomplete') {
    return [{
      ...review,
      originalLines: review.originalLines.map(strip),
      currentLines: review.currentLines.map(strip),
      beforeText: review.beforeText === undefined ? undefined : strip(review.beforeText),
      afterText: review.afterText === undefined ? undefined : strip(review.afterText),
      anchor: undefined,
    }];
  }
  const exact = review.hintedLineIsExact === true || review.hintedInsertionAfterLine !== undefined;
  const offset = (review.hintedLine ?? ((review.hintedInsertionAfterLine ?? 0) + 1)) - 1;
  const lines = diff.diff.diffLines.map(line => ({
    ...line,
    ...(line.oldLineNum === undefined ? {} : { oldLineNum: line.oldLineNum + offset }),
    ...(line.newLineNum === undefined ? {} : { newLineNum: line.newLineNum + offset }),
  }));
  return createAiEditReviewSpecs(lines, { lineNumbersAreDocumentRelative: exact }).map(spec => ({
    ...spec,
    beforeText: spec.beforeText ?? (review.beforeText === undefined ? undefined : strip(review.beforeText)),
    afterText: spec.afterText ?? (review.afterText === undefined ? undefined : strip(review.afterText)),
    path: review.path,
    id: review.id,
  }));
}

function anchorResolvedReviews(
  documentText: string,
  renderedReviews: readonly RenderedAiEditReview[],
): boolean {
  let changed = false;
  for (const { review, resolved } of renderedReviews) {
    if (!review.anchor) {
      review.anchor = createAiEditReviewAnchor(documentText, resolved);
      changed = true;
    }
    if (review.beforeText === undefined && review.afterText === undefined) {
      updateReviewFallbackContext(documentText, review, resolved);
      changed = true;
    }
  }
  return changed;
}

function anchorStoredReviews(
  documentText: string,
  reviews: readonly StoredAiEditReview[],
): boolean {
  return anchorResolvedReviews(documentText, resolveStoredReviews(documentText, reviews));
}

function updateReviewFallbackContext(
  documentText: string,
  review: StoredAiEditReview,
  resolved: ResolvedAiEditReview,
): void {
  const documentLines = documentText.split('\n');
  const startIndex = resolved.kind === 'deleted'
    ? resolved.insertionAfterLine
    : resolved.fromLine - 1;
  const endIndex = resolved.kind === 'deleted'
    ? resolved.insertionAfterLine
    : resolved.toLine;
  review.beforeText = startIndex > 0 ? documentLines[startIndex - 1] : undefined;
  review.afterText = endIndex < documentLines.length ? documentLines[endIndex] : undefined;
  if (resolved.kind === 'deleted') {
    review.hintedInsertionAfterLine = resolved.insertionAfterLine;
  } else {
    review.hintedLine = resolved.fromLine;
    review.hintedLineIsExact = true;
  }
}

function resolveStoredReviews(
  documentText: string,
  reviews: readonly StoredAiEditReview[],
): RenderedAiEditReview[] {
  const occupiedLines = new Set<number>();
  const rendered: RenderedAiEditReview[] = [];

  for (const review of [...reviews].reverse()) {
    const resolved = resolveAiEditReview(documentText, review);
    if (!resolved) continue;
    if (resolved.kind !== 'deleted') {
      const overlaps = Array.from(
        { length: resolved.toLine - resolved.fromLine + 1 },
        (_, index) => resolved.fromLine + index,
      ).some(line => occupiedLines.has(line));
      if (overlaps) continue;
      for (let line = resolved.fromLine; line <= resolved.toLine; line++) {
        occupiedLines.add(line);
      }
    }
    rendered.push({ review, resolved });
  }

  return rendered.sort((left, right) => (
    getReviewDisplayLine(left.resolved) - getReviewDisplayLine(right.resolved)
    || left.review.id.localeCompare(right.review.id)
  ));
}

function getReviewDisplayLine(resolved: ResolvedAiEditReview): number {
  return resolved.kind === 'deleted' ? resolved.insertionAfterLine : resolved.fromLine;
}

function createDecorations(
  document: Text,
  rendering: AiEditReviewRendering,
): DecorationSet {
  const actions = {
    onAccept: rendering.onAccept,
    onRevert: rendering.onRevert,
  };
  const ranges = rendering.reviews.flatMap(
    rendered => createReviewDecorations(document, rendered, actions),
  );
  return Decoration.set(ranges, true);
}

function createReviewDecorations(
  document: Text,
  rendered: RenderedAiEditReview,
  actions: Pick<AiEditReviewRendering, 'onAccept' | 'onRevert'>,
): Array<Range<Decoration>> {
  const { resolved } = rendered;
  const decorations: Array<Range<Decoration>> = [];

  if (resolved.kind !== 'deleted') {
    for (let lineNumber = resolved.fromLine; lineNumber <= resolved.toLine; lineNumber++) {
      if (lineNumber < 1 || lineNumber > document.lines) continue;
      const line = document.line(lineNumber);
      decorations.push(Decoration.line({
        class: `claudian-ai-edit-highlight claudian-ai-edit-highlight--${resolved.kind}`,
        attributes: {
          'data-claudian-ai-edit-kind': resolved.kind,
          'data-claudian-ai-edit-id': rendered.review.id,
          title: getHighlightTitle(resolved.kind),
        },
      }).range(line.from));
    }
  }

  const widgetPosition = getReviewWidgetPosition(document, resolved);
  decorations.push(Decoration.widget({
    widget: new AiEditReviewWidget(rendered, actions),
    aiEditReviewId: rendered.review.id,
    block: resolved.kind !== 'added',
    side: widgetPosition.side,
  }).range(widgetPosition.position));
  return decorations;
}

function getReviewWidgetPosition(
  document: Text,
  resolved: ResolvedAiEditReview,
): { position: number; side: -1 | 1 } {
  if (resolved.kind !== 'deleted') {
    return { position: document.line(resolved.toLine).to, side: 1 };
  }
  if (resolved.insertionAfterLine === 0) {
    return { position: 0, side: -1 };
  }
  return {
    position: document.line(Math.min(resolved.insertionAfterLine, document.lines)).to,
    side: 1,
  };
}

function createRevertChange(
  document: Text,
  resolved: ResolvedAiEditReview,
): { from: number; to: number; insert: string } {
  const originalText = resolved.originalLines.join('\n');
  if (resolved.kind === 'modified') {
    return {
      from: document.line(resolved.fromLine).from,
      to: document.line(resolved.toLine).to,
      insert: originalText,
    };
  }

  if (resolved.kind === 'added') {
    if (resolved.fromLine === 1 && resolved.toLine === document.lines) {
      return { from: 0, to: document.length, insert: '' };
    }
    if (resolved.toLine < document.lines) {
      return {
        from: document.line(resolved.fromLine).from,
        to: document.line(resolved.toLine + 1).from,
        insert: '',
      };
    }
    return {
      from: document.line(resolved.fromLine - 1).to,
      to: document.length,
      insert: '',
    };
  }

  if (document.length === 0) {
    return { from: 0, to: 0, insert: originalText };
  }
  if (resolved.insertionAfterLine === 0) {
    return { from: 0, to: 0, insert: `${originalText}\n` };
  }
  if (resolved.insertionAfterLine < document.lines) {
    const position = document.line(resolved.insertionAfterLine + 1).from;
    return { from: position, to: position, insert: `${originalText}\n` };
  }
  return {
    from: document.length,
    to: document.length,
    insert: `\n${originalText}`,
  };
}

function createActionButton(
  ownerWindow: Window & { createEl: typeof createEl },
  label: string,
  variant: 'accept' | 'revert',
  onClick: () => void,
): HTMLButtonElement {
  const button = ownerWindow.createEl('button', {
    cls: `claudian-ai-edit-review-action claudian-ai-edit-review-action--${variant}`,
    text: variant === 'accept' ? '\u2713' : '\u21b6',
    attr: {
      type: 'button',
      'aria-label': label,
      title: label,
    },
  });
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function getObsidianWindow(document: Document): Window & {
  createDiv: typeof createDiv;
  createEl: typeof createEl;
} {
  return document.win as Window & {
    createDiv: typeof createDiv;
    createEl: typeof createEl;
  };
}

function getHighlightTitle(kind: AiEditHighlightKind): string {
  switch (kind) {
    case 'added':
      return 'AI-added content';
    case 'modified':
      return 'AI-modified content';
    case 'deleted':
      return 'Content deleted by AI';
  }
}

function getKindLabel(kind: AiEditHighlightKind): string {
  switch (kind) {
    case 'added':
      return 'Added';
    case 'modified':
      return 'Modified';
    case 'deleted':
      return 'Deleted';
  }
}
