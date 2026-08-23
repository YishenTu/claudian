import { type CollabChangedFile } from '@claudian-collab/protocol';
import { setIcon } from 'obsidian';

import { type CollabOperationOptions, type CollabPublicationReview, type CollabPublicationReviewFileRequest, type CollabRequestReview, type CollabResult, type CollabReviewFileContent, type CollabReviewFileRequest, type CollabWorkingTreeReview, type CollabWorkingTreeReviewFileRequest } from '@/core/collab';
import { CollabError } from '@/core/collab/ClaudianCollabError';
import {
  type CollabDiffLayout,
  CollabDiffRenderer,
  type CollabTextDiffInput,
} from '@/features/collab/detail/review/CollabDiffRenderer';
import { t } from '@/i18n/i18n';
import {
  type LatestTaskHandle,
  LatestTaskScope,
} from '@/shared/async/LatestTaskScope';

const MAX_REVIEW_FILE_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_REVIEW_FILE_CACHE_ENTRIES = 32;

export type CollabDisplayReview =
  | CollabPublicationReview
  | CollabRequestReview
  | CollabWorkingTreeReview;

export interface CollabDetailDiffPort {
  clear(): void;
  destroy(): void;
  render(input: CollabTextDiffInput): Promise<void>;
  setLayout(layout: CollabDiffLayout): void;
}

export interface CollabDetailObjectUrlPort {
  create(bytes: Uint8Array, mimeType: string): string;
  revoke(url: string): void;
}

export interface ReviewDiffSessionPort {
  readPublicationReviewFile(
    request: CollabPublicationReviewFileRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabReviewFileContent>>;
  readReviewFile(
    request: CollabReviewFileRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabReviewFileContent>>;
  readWorkingTreeReviewFile(
    request: CollabWorkingTreeReviewFileRequest,
    options?: CollabOperationOptions,
  ): Promise<CollabResult<CollabReviewFileContent>>;
}

export interface ReviewDiffSessionOptions {
  readonly objectUrls: CollabDetailObjectUrlPort;
  readonly onSelectedPath?: (path: string) => void;
  readonly openProjectFile?: (projectId: string, path: string) => Promise<void>;
  readonly port: ReviewDiffSessionPort;
  readonly renderer?: CollabDetailDiffPort;
  readonly rendererFactory?: () => CollabDetailDiffPort;
}

interface CachedReviewFileContent {
  readonly content: CollabReviewFileContent;
  readonly size: number;
}

interface ContinuousLoadJob {
  readonly run: () => Promise<void>;
  readonly task: LatestTaskHandle;
}

export function isPublicationReview(
  review: CollabDisplayReview,
): review is CollabPublicationReview {
  return 'kind' in review && review.kind === 'publication';
}

export function isWorkingTreeReview(
  review: CollabDisplayReview,
): review is CollabWorkingTreeReview {
  return 'kind' in review && review.kind === 'working-tree';
}

export function isRequestReview(
  review: CollabDisplayReview,
): review is CollabRequestReview {
  return !isPublicationReview(review) && !isWorkingTreeReview(review);
}

export function reviewsShareIdentity(
  first: CollabDisplayReview,
  second: CollabDisplayReview,
): boolean {
  if (isWorkingTreeReview(first) || isWorkingTreeReview(second)) {
    return isWorkingTreeReview(first)
      && isWorkingTreeReview(second)
      && first.projectId === second.projectId
      && first.baseOid === second.baseOid
      && first.headOid === second.headOid
      && first.snapshotId === second.snapshotId;
  }
  if (isPublicationReview(first) || isPublicationReview(second)) {
    return isPublicationReview(first)
      && isPublicationReview(second)
      && first.projectId === second.projectId
      && first.operationId === second.operationId
      && first.currentMainOid === second.currentMainOid
      && first.candidateOid === second.candidateOid
      && first.comparisonBaseOid === second.comparisonBaseOid
      && first.comparisonTargetOid === second.comparisonTargetOid;
  }
  return first.projectId === second.projectId
    && first.detail.request.id === second.detail.request.id
    && first.comparisonBaseOid === second.comparisonBaseOid
    && first.comparisonTargetOid === second.comparisonTargetOid
    && first.detail.currentMainOid === second.detail.currentMainOid
    && first.detail.reviewedHeadOid === second.detail.reviewedHeadOid;
}

export class ReviewDiffSession {
  private activeContinuousLoad = false;
  private readonly continuousLoaders = new Map<string, () => void>();
  private readonly continuousObjectUrls = new Map<string, string>();
  private continuousObserver: IntersectionObserver | null = null;
  private continuousPrimaryPath: string | null = null;
  private continuousQueue: ContinuousLoadJob[] = [];
  private readonly continuousRenderers = new Map<string, CollabDetailDiffPort>();
  private readonly continuousSections = new Map<string, HTMLElement>();
  private destroyed = false;
  private layout: CollabDiffLayout = 'unified';
  private objectUrl: string | null = null;
  private readonly objectUrls: CollabDetailObjectUrlPort;
  private readonly onSelectedPath?: (path: string) => void;
  private readonly openProjectFile?: (projectId: string, path: string) => Promise<void>;
  private readonly port: ReviewDiffSessionPort;
  private readonly renderer: CollabDetailDiffPort;
  private readonly rendererFactory: () => CollabDetailDiffPort;
  private review: CollabDisplayReview | null = null;
  private readonly reviewFileCache = new Map<string, CachedReviewFileContent>();
  private reviewFileCacheBytes = 0;
  private scope: 'continuous' | 'file' = 'continuous';
  private scopeButton: HTMLButtonElement | null = null;
  private selectedPath: string | null = null;
  private readonly tasks = new LatestTaskScope();
  private hostEl: HTMLElement | null = null;
  private layoutButton: HTMLButtonElement | null = null;

  constructor(options: ReviewDiffSessionOptions) {
    this.objectUrls = options.objectUrls;
    this.onSelectedPath = options.onSelectedPath;
    this.openProjectFile = options.openProjectFile;
    this.port = options.port;
    this.renderer = options.renderer ?? new CollabDiffRenderer();
    this.rendererFactory = options.rendererFactory ?? (() => new CollabDiffRenderer());
  }

  createControls(host: HTMLElement): HTMLElement {
    const controls = host.createDiv({ cls: 'claudian-collab-review-display-controls' });
    const scope = controls.createEl('button', {
      attr: { 'data-collab-review-scope': this.scope, type: 'button' },
      cls: 'claudian-collab-review-display-toggle',
    });
    this.scopeButton = scope;
    this.syncScopeButton(scope);
    scope.addEventListener('click', () => {
      this.setScope(this.scope === 'file' ? 'continuous' : 'file');
    });
    const layout = controls.createEl('button', {
      attr: { 'data-collab-review-layout': this.layout, type: 'button' },
      cls: 'claudian-collab-review-display-toggle',
    });
    this.layoutButton = layout;
    this.syncLayoutButton(layout);
    layout.addEventListener('click', () => {
      this.setLayout(this.layout === 'unified' ? 'split' : 'unified');
    });
    return controls;
  }

  bind(
    host: HTMLElement,
    review: CollabDisplayReview,
    selectedPath?: string,
  ): void {
    this.assertOpen();
    if (this.review && !reviewsShareIdentity(this.review, review)) {
      this.resetPresentation(true);
      this.clearCache();
    }
    this.hostEl = host;
    this.review = review;
    this.selectedPath = review.files.find(file => file.path === selectedPath)?.path
      ?? review.files[0]?.path
      ?? null;
  }

  show(
    host: HTMLElement,
    review: CollabDisplayReview,
    selectedPath?: string,
  ): void {
    this.bind(host, review, selectedPath);
    this.start();
  }

  start(): void {
    this.assertOpen();
    const review = this.review;
    const host = this.hostEl;
    if (!review || !host) return;
    if (review.files.length === 0) {
      this.resetPresentation(false);
      host.replaceChildren();
      host.createDiv({ text: t('collab.review.noFiles') });
      return;
    }
    if (this.scope === 'continuous') {
      this.startContinuousReview();
    } else {
      const selected = review.files.find(file => file.path === this.selectedPath)
        ?? review.files[0];
      if (selected) void this.loadFile(selected);
    }
  }

  select(path: string): void {
    const review = this.review;
    if (!review?.files.some(file => file.path === path)) return;
    this.selectedPath = path;
    this.onSelectedPath?.(path);
    if (this.scope === 'continuous') {
      this.scrollToContinuousFile(path);
      return;
    }
    const file = review.files.find(candidate => candidate.path === path);
    if (file) void this.loadFile(file);
  }

  clear(): void {
    if (this.destroyed) return;
    this.resetPresentation(false);
    this.clearCache();
    this.review = null;
    this.hostEl = null;
    this.selectedPath = null;
  }

  detach(): void {
    if (this.destroyed) return;
    this.resetPresentation(true);
    this.clearCache();
    this.review = null;
    this.hostEl = null;
    this.selectedPath = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.clear();
    this.destroyed = true;
    this.tasks.close();
    this.renderer.destroy();
  }

  private setScope(scope: 'continuous' | 'file'): void {
    if (this.scope === scope) return;
    this.scope = scope;
    this.syncScopeButton();
    this.start();
  }

  private setLayout(layout: CollabDiffLayout): void {
    if (this.layout === layout) return;
    this.layout = layout;
    this.syncLayoutButton();
    this.renderer.setLayout(layout);
    for (const renderer of this.continuousRenderers.values()) renderer.setLayout(layout);
  }

  private syncScopeButton(button?: HTMLButtonElement): void {
    const target = button ?? this.scopeButton;
    if (!target) return;
    const currentFile = this.scope === 'file';
    target.dataset.collabReviewScope = this.scope;
    target.setAttribute(
      'aria-label',
      currentFile ? t('collab.review.allFiles') : t('collab.review.currentFile'),
    );
    target.removeAttribute('title');
    setIcon(target, currentFile ? 'files' : 'file');
  }

  private syncLayoutButton(button?: HTMLButtonElement): void {
    const target = button ?? this.layoutButton;
    if (!target) return;
    const unified = this.layout === 'unified';
    target.dataset.collabReviewLayout = this.layout;
    target.setAttribute(
      'aria-label',
      unified ? t('collab.review.split') : t('collab.review.unified'),
    );
    target.removeAttribute('title');
    setIcon(target, unified ? 'columns-2' : 'rows-2');
  }

  private async loadFile(file: CollabChangedFile): Promise<void> {
    const review = this.review;
    const host = this.hostEl;
    if (!review || !host) return;
    this.resetPresentation(true);
    const task = this.tasks.start();
    this.review = review;
    this.hostEl = host;
    this.selectedPath = file.path;
    host.replaceChildren();
    host.createDiv({ text: t('collab.review.loadingFile') });
    try {
      const content = await this.readReviewFileContent(review, file, task.signal);
      if (!this.isCurrent(task, review) || content.file.path !== file.path) return;
      host.replaceChildren();
      if (content.kind === 'text') {
        const onOpenFile = this.fileOpenAction(review, content.file);
        await this.renderer.render({
          container: host,
          layout: this.layout,
          newText: content.newText,
          oldText: content.oldText,
          ...(onOpenFile ? { onOpenFile } : {}),
          path: content.file.path,
          ...(content.file.previousPath ? { previousPath: content.file.previousPath } : {}),
        });
        return;
      }
      this.renderer.clear();
      this.objectUrl = this.renderOpaqueFile(
        host,
        content,
        this.fileOpenAction(review, content.file),
      );
    } catch {
      if (!this.isCurrent(task, review)) return;
      this.renderer.clear();
      host.replaceChildren();
      host.createDiv({ cls: 'mod-warning', text: t('collab.review.fileLoadFailed') });
    } finally {
      task.complete();
    }
  }

  private startContinuousReview(): void {
    const review = this.review;
    const host = this.hostEl;
    if (!review || !host) return;
    this.resetPresentation(true);
    const task = this.tasks.start();
    this.review = review;
    this.hostEl = host;
    this.continuousPrimaryPath = this.selectedPath ?? review.files[0]?.path ?? null;
    host.replaceChildren();
    if (typeof IntersectionObserver !== 'undefined') {
      this.continuousObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const path = (entry.target as HTMLElement).dataset.collabReviewFile;
          if (path) this.continuousLoaders.get(path)?.();
        }
      }, { root: host, rootMargin: '600px 0px' });
    }
    for (const file of review.files) {
      const section = host.createDiv({ cls: 'claudian-collab-review-file' });
      section.dataset.collabReviewFile = file.path;
      section.createDiv({
        cls: 'claudian-collab-review-file-placeholder',
        text: t('collab.review.loadingFile'),
      });
      this.continuousSections.set(file.path, section);
      let started = false;
      const start = (): void => {
        if (started || !this.isCurrent(task, review)) return;
        started = true;
        this.continuousObserver?.unobserve(section);
        this.continuousLoaders.delete(file.path);
        this.continuousQueue.push({
          run: () => this.loadContinuousFile(review, file, section, task),
          task,
        });
        this.pumpContinuousQueue();
      };
      this.continuousLoaders.set(file.path, start);
      this.continuousObserver?.observe(section);
    }
    const primaryPath = this.continuousPrimaryPath;
    if (primaryPath) this.continuousLoaders.get(primaryPath)?.();
    if (!this.continuousObserver) {
      for (const file of review.files) this.continuousLoaders.get(file.path)?.();
    }
    if (this.selectedPath) this.scrollToContinuousFile(this.selectedPath);
  }

  private async loadContinuousFile(
    review: CollabDisplayReview,
    file: CollabChangedFile,
    host: HTMLElement,
    task: LatestTaskHandle,
  ): Promise<void> {
    try {
      const content = await this.readReviewFileContent(review, file, task.signal);
      if (!this.isCurrent(task, review) || this.scope !== 'continuous') return;
      if (content.file.path !== file.path) throw viewError('review-file-response-mismatch');
      host.replaceChildren();
      if (content.kind === 'text') {
        const renderer = file.path === this.continuousPrimaryPath
          ? this.renderer
          : this.rendererFactory();
        renderer.setLayout(this.layout);
        this.continuousRenderers.set(file.path, renderer);
        const onOpenFile = this.fileOpenAction(review, content.file);
        await renderer.render({
          container: host,
          layout: this.layout,
          newText: content.newText,
          oldText: content.oldText,
          ...(onOpenFile ? { onOpenFile } : {}),
          path: content.file.path,
          ...(content.file.previousPath ? { previousPath: content.file.previousPath } : {}),
        });
        return;
      }
      if (file.path === this.continuousPrimaryPath) this.renderer.clear();
      const objectUrl = this.renderOpaqueFile(
        host,
        content,
        this.fileOpenAction(review, content.file),
      );
      if (objectUrl) this.continuousObjectUrls.set(file.path, objectUrl);
    } catch {
      if (!this.isCurrent(task, review)) return;
      const renderer = this.continuousRenderers.get(file.path);
      if (file.path === this.continuousPrimaryPath || renderer === this.renderer) {
        this.renderer.clear();
      } else {
        renderer?.destroy();
      }
      this.continuousRenderers.delete(file.path);
      host.replaceChildren();
      host.createDiv({ cls: 'mod-warning', text: t('collab.review.fileLoadFailed') });
    }
  }

  private pumpContinuousQueue(): void {
    if (this.activeContinuousLoad) return;
    const job = this.continuousQueue.shift();
    if (!job) return;
    if (!job.task.isCurrent()) {
      this.pumpContinuousQueue();
      return;
    }
    this.activeContinuousLoad = true;
    void job.run().catch(() => undefined).finally(() => {
      this.activeContinuousLoad = false;
      this.pumpContinuousQueue();
    });
  }

  private scrollToContinuousFile(path: string): void {
    this.continuousLoaders.get(path)?.();
    const section = this.continuousSections.get(path);
    if (!section) return;
    for (const item of this.continuousSections.values()) {
      item.classList.toggle('is-selected', item === section);
    }
    section.scrollIntoView?.({ block: 'start' });
  }

  private resetPresentation(retainPrimaryRenderer: boolean): void {
    this.tasks.cancel();
    this.continuousObserver?.disconnect();
    this.continuousObserver = null;
    for (const renderer of new Set(this.continuousRenderers.values())) {
      if (renderer === this.renderer) {
        if (!retainPrimaryRenderer) renderer.clear();
      }
      else renderer.destroy();
    }
    this.continuousRenderers.clear();
    this.continuousPrimaryPath = null;
    for (const objectUrl of this.continuousObjectUrls.values()) {
      this.objectUrls.revoke(objectUrl);
    }
    this.continuousObjectUrls.clear();
    this.continuousQueue = [];
    this.continuousLoaders.clear();
    this.continuousSections.clear();
    this.revokeObjectUrl();
    if (!retainPrimaryRenderer) this.renderer.clear();
  }

  private async readReviewFileContent(
    review: CollabDisplayReview,
    file: CollabChangedFile,
    signal: AbortSignal,
  ): Promise<CollabReviewFileContent> {
    const identity = isWorkingTreeReview(review)
      ? [review.baseOid, review.headOid, review.snapshotId]
      : [review.comparisonBaseOid, review.comparisonTargetOid];
    const key = [...identity, file.path].join(':');
    const cached = this.reviewFileCache.get(key);
    if (cached) {
      this.reviewFileCache.delete(key);
      this.reviewFileCache.set(key, cached);
      return cached.content;
    }
    const result = isPublicationReview(review)
      ? await this.port.readPublicationReviewFile({
        comparisonBaseOid: review.comparisonBaseOid,
        comparisonTargetOid: review.comparisonTargetOid,
        expectedCandidateOid: review.candidateOid,
        expectedMainOid: review.currentMainOid,
        file,
        operationId: review.operationId,
        projectId: review.projectId,
      }, { signal })
      : isWorkingTreeReview(review)
        ? await this.port.readWorkingTreeReviewFile({
          baseOid: review.baseOid,
          file,
          headOid: review.headOid,
          projectId: review.projectId,
          snapshotId: review.snapshotId,
        }, { signal })
        : await this.port.readReviewFile({
          comparisonBaseOid: review.comparisonBaseOid,
          comparisonTargetOid: review.comparisonTargetOid,
          file,
          projectId: review.projectId,
          requestId: review.detail.request.id,
        }, { signal });
    const content = requireSuccess(result);
    if (signal.aborted) throw new CollabError({ code: 'cancelled' });
    this.storeReviewFileContent(key, content);
    return content;
  }

  private storeReviewFileContent(key: string, content: CollabReviewFileContent): void {
    const size = content.kind === 'text'
      ? ((content.oldText?.length ?? 0) + (content.newText?.length ?? 0)) * 2
      : content.kind === 'binary'
        ? content.preview?.bytes.byteLength ?? 0
        : 0;
    if (size > MAX_REVIEW_FILE_CACHE_BYTES) return;
    const previous = this.reviewFileCache.get(key);
    if (previous) this.reviewFileCacheBytes -= previous.size;
    this.reviewFileCache.delete(key);
    this.reviewFileCache.set(key, { content, size });
    this.reviewFileCacheBytes += size;
    while (
      this.reviewFileCache.size > MAX_REVIEW_FILE_CACHE_ENTRIES
      || this.reviewFileCacheBytes > MAX_REVIEW_FILE_CACHE_BYTES
    ) {
      const oldestKey = this.reviewFileCache.keys().next().value;
      if (!oldestKey) break;
      const oldest = this.reviewFileCache.get(oldestKey);
      this.reviewFileCache.delete(oldestKey);
      this.reviewFileCacheBytes -= oldest?.size ?? 0;
    }
  }

  private clearCache(): void {
    this.reviewFileCache.clear();
    this.reviewFileCacheBytes = 0;
  }

  private fileOpenAction(
    review: CollabDisplayReview,
    file: CollabChangedFile,
  ): (() => void) | undefined {
    if (!isWorkingTreeReview(review) || file.kind === 'deleted' || !this.openProjectFile) {
      return undefined;
    }
    return () => {
      const open = this.openProjectFile;
      if (!open) return;
      void open(review.projectId, file.path).catch(() => undefined);
    };
  }

  private renderOpaqueFile(
    host: HTMLElement,
    content: Exclude<CollabReviewFileContent, { kind: 'text' }>,
    onOpenFile?: () => void,
  ): string | null {
    const title = host.createDiv({ cls: 'claudian-collab-review-file-title' });
    title.createEl('h3', { text: content.file.path });
    if (onOpenFile) {
      const openFile = title.createEl('button', {
        attr: {
          'aria-label': t('collab.review.openFile'),
          'data-collab-review-open-file': '',
          type: 'button',
        },
        cls: 'claudian-collab-review-display-toggle claudian-collab-review-file-open',
      });
      setIcon(openFile, 'external-link');
      openFile.addEventListener('click', onOpenFile);
    }
    host.createDiv({
      text: content.kind === 'large-text'
        ? t('collab.review.largeText')
        : t('collab.review.binary'),
    });
    host.createDiv({
      cls: 'claudian-collab-review-metadata',
      text: t('collab.review.fileSize', {
        newSize: formatBytes(content.file.newBytes),
        oldSize: formatBytes(content.file.oldBytes),
      }),
    });
    if (content.kind === 'binary' && content.preview) {
      const objectUrl = this.objectUrls.create(content.preview.bytes, content.preview.mimeType);
      host.createEl('img', {
        attr: { alt: content.file.path, src: objectUrl },
        cls: 'claudian-collab-review-image',
      });
      return objectUrl;
    }
    return null;
  }

  private revokeObjectUrl(): void {
    if (!this.objectUrl) return;
    this.objectUrls.revoke(this.objectUrl);
    this.objectUrl = null;
  }

  private isCurrent(task: LatestTaskHandle, review: CollabDisplayReview): boolean {
    return !this.destroyed
      && task.isCurrent()
      && this.review !== null
      && reviewsShareIdentity(this.review, review);
  }

  private assertOpen(): void {
    if (this.destroyed) throw new Error('ReviewDiffSession is destroyed');
  }
}

function requireSuccess<T>(result: CollabResult<T>): T {
  if (result.status === 'success') return result.value;
  if ('error' in result) throw result.error;
  throw new CollabError({ code: 'cancelled' });
}

function viewError(reason: string): CollabError {
  return new CollabError({
    code: 'operation-failed',
    recoveryActions: ['retry'],
    safeContext: { reason },
  });
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
