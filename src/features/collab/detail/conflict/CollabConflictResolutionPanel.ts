import { type CollabOperationId } from '@claudian-collab/protocol';

import { type CollabConflictEntry, type CollabConflictFileContent, type CollabConflictFileRequest, type CollabConflictSession, type CollabFeaturePort, type CollabResult } from '@/core/collab';
import {
  CollabDiffRenderer,
  type CollabTextDiffInput,
} from '@/features/collab/detail/review/CollabDiffRenderer';
import { t } from '@/i18n/i18n';
import {
  type LatestTaskHandle,
  LatestTaskScope,
} from '@/shared/async/LatestTaskScope';

export type CollabConflictLocation = 'my-changes' | 'request';

export type CollabConflictResolutionPort = Pick<
  CollabFeaturePort,
  | 'readConflict'
  | 'readConflictFile'
>;

export interface CollabConflictDiffPort {
  clear(): void;
  destroy(): void;
  render(input: CollabTextDiffInput): Promise<unknown>;
}

export interface CollabConflictResolutionPanelOptions {
  readonly comparisonDiffFactory?: () => CollabConflictDiffPort;
  readonly location: CollabConflictLocation;
}

function appendText(
  parent: HTMLElement,
  tag: keyof HTMLElementTagNameMap,
  text: string,
  className?: string,
): HTMLElement {
  const element = createEl(tag);
  element.textContent = text;
  if (className) element.className = className;
  parent.append(element);
  return element;
}

function appendButton(
  parent: HTMLElement,
  text: string,
  action: string,
): HTMLButtonElement {
  const button = createEl('button');
  button.type = 'button';
  button.textContent = text;
  button.dataset.conflictAction = action;
  parent.append(button);
  return button;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function kindLabel(kind: CollabConflictEntry['kind']): string {
  switch (kind) {
    case 'text': return t('collab.conflict.kind.text');
    case 'binary': return t('collab.conflict.kind.binary');
    case 'delete-modify': return t('collab.conflict.kind.deleteModify');
    case 'rename-delete': return t('collab.conflict.kind.renameDelete');
    case 'directory-file': return t('collab.conflict.kind.directoryFile');
    case 'portability': return t('collab.conflict.kind.portability');
  }
}

function isSuccess<T>(result: CollabResult<T>): result is { status: 'success'; value: T } {
  return result.status === 'success';
}

export class CollabConflictResolutionPanel {
  private readonly comparisonDiffFactory: () => CollabConflictDiffPort;
  private readonly comparisonDiffs = new Map<string, CollabConflictDiffPort>();
  private readonly contents = new Map<string, CollabConflictFileContent>();
  private destroyed = false;
  private readonly fileSections = new Map<string, HTMLElement>();
  private readonly location: CollabConflictLocation;
  private operationId: CollabOperationId | null = null;
  private readonly readTasks = new LatestTaskScope();
  private session: CollabConflictSession | null = null;

  constructor(
    private readonly rootEl: HTMLElement,
    private readonly port: CollabConflictResolutionPort,
    options: CollabConflictResolutionPanelOptions,
  ) {
    this.comparisonDiffFactory = options.comparisonDiffFactory
      ?? (() => new CollabDiffRenderer());
    this.location = options.location;
  }

  async open(operationId: CollabOperationId): Promise<void> {
    if (this.destroyed) return;
    const task = this.readTasks.start();
    this.destroyFileResources();
    this.operationId = operationId;
    this.session = null;
    this.contents.clear();
    this.fileSections.clear();
    this.renderMessage(t('collab.conflict.loading'));
    try {
      const result = await this.port.readConflict(operationId, { signal: task.signal });
      if (!this.isCurrent(task, operationId)) return;
      if (!isSuccess(result) || result.value.descriptor.operationId !== operationId) {
        this.renderMessage(t('collab.conflict.loadFailed'), true, true);
        return;
      }
      this.session = result.value;
      this.renderShell();
      await this.loadFiles(task, operationId);
    } catch {
      if (this.isCurrent(task, operationId)) {
        this.renderMessage(t('collab.conflict.loadFailed'), true, true);
      }
    } finally {
      task.complete();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.readTasks.close();
    this.destroyFileResources();
    this.rootEl.replaceChildren();
  }

  private renderShell(): void {
    const session = this.session;
    if (!session) return;
    this.destroyFileResources();
    this.fileSections.clear();
    this.rootEl.replaceChildren();
    this.rootEl.classList.add('claudian-collab-conflict');
    this.rootEl.dataset.conflictLocation = this.location;

    const header = createEl('header');
    header.className = 'claudian-collab-conflict-header';
    appendText(
      header,
      'h2',
      this.location === 'request'
        ? t('collab.conflict.requestTitle')
        : t('collab.conflict.myChangesTitle'),
    );
    appendText(header, 'div', t('collab.conflict.fileCount', {
      count: session.descriptor.conflicts.length,
    }), 'claudian-collab-conflict-progress');
    this.rootEl.append(header);
    appendText(
      this.rootEl,
      'p',
      t('collab.conflict.editAndPublish'),
      'claudian-collab-conflict-guidance',
    );

    const content = createEl('main');
    content.className = 'claudian-collab-conflict-content';
    content.dataset.conflictContent = 'true';
    for (const conflict of session.descriptor.conflicts) {
      const section = createEl('section');
      section.className = 'claudian-collab-conflict-section';
      section.dataset.conflictPath = conflict.path;
      appendText(section, 'div', t('collab.conflict.loadingFile'));
      content.append(section);
      this.fileSections.set(conflict.path, section);
    }
    this.rootEl.append(content);
  }

  private async loadFiles(
    task: LatestTaskHandle,
    expectedOperationId: CollabOperationId,
  ): Promise<void> {
    const operationId = this.operationId;
    const session = this.session;
    if (!operationId || !session) return;
    for (const conflict of session.descriptor.conflicts) {
      if (!this.isCurrent(task, expectedOperationId)) break;
      try {
        const request: CollabConflictFileRequest = { operationId, path: conflict.path };
        const result = await this.port.readConflictFile(request, { signal: task.signal });
        if (!this.isCurrent(task, expectedOperationId)) break;
        if (
          !isSuccess(result)
          || result.value.path !== conflict.path
          || result.value.kind !== conflict.kind
        ) {
          this.renderFileError(conflict.path);
          continue;
        }
        this.contents.set(conflict.path, result.value);
        this.renderConflictFile(conflict.path);
      } catch {
        if (this.isCurrent(task, expectedOperationId)) {
          this.renderFileError(conflict.path);
        }
      }
    }
  }

  private renderConflictFile(path: string): void {
    const content = this.contents.get(path);
    const host = this.fileSections.get(path);
    if (!content || !host) return;
    this.destroyPathResources(path);
    host.replaceChildren();
    appendText(host, 'h3', content.path);
    appendText(host, 'div', kindLabel(content.kind), 'claudian-collab-conflict-kind');

    if (content.kind === 'directory-file' || content.kind === 'portability') {
      const blocking = appendText(
        host,
        'div',
        t('collab.conflict.blocking'),
        'claudian-collab-conflict-blocking mod-warning',
      );
      blocking.setAttribute('role', 'alert');
      return;
    }
    if (content.kind === 'text') {
      this.renderTextConflict(host, content);
      return;
    }
    if (
      content.kind === 'binary'
      || content.kind === 'delete-modify'
      || content.kind === 'rename-delete'
    ) {
      this.renderOpaqueConflict(host, content);
    }
  }

  private renderTextConflict(
    host: HTMLElement,
    content: Extract<CollabConflictFileContent, { kind: 'text' }>,
  ): void {
    const labels = createDiv();
    labels.className = 'claudian-collab-conflict-diff-labels';
    appendText(labels, 'span', t('collab.conflict.accepted'));
    appendText(labels, 'span', t('collab.conflict.mine'));
    host.append(labels);
    const diffHost = createDiv();
    diffHost.className = 'claudian-collab-conflict-diff';
    const renderer = this.comparisonDiffFactory();
    const rendererKey = this.rendererKey(content.path);
    this.comparisonDiffs.set(rendererKey, renderer);
    void renderer.render({
      container: diffHost,
      layout: 'split',
      newText: content.personal.text ?? '',
      oldText: content.accepted.text ?? '',
      path: content.path,
    }).catch(() => {
      if (this.comparisonDiffs.get(rendererKey) !== renderer) return;
      diffHost.replaceChildren();
      appendText(diffHost, 'div', t('collab.conflict.fileLoadFailed'), 'mod-warning');
    });
    host.append(diffHost);
  }

  private renderOpaqueConflict(
    host: HTMLElement,
    content: Exclude<
      CollabConflictFileContent,
      { kind: 'directory-file' | 'portability' | 'text' }
    >,
  ): void {
    const versions = createDiv();
    versions.className = 'claudian-collab-conflict-versions';
    this.renderOpaqueVersion(versions, t('collab.conflict.accepted'), content.accepted);
    this.renderOpaqueVersion(versions, t('collab.conflict.mine'), content.personal);
    host.append(versions);
  }

  private renderOpaqueVersion(
    parent: HTMLElement,
    label: string,
    version: { bytes: number; exists: boolean; path: string },
  ): void {
    const section = createEl('section');
    section.className = 'claudian-collab-conflict-version';
    appendText(section, 'h4', label);
    appendText(section, 'div', version.exists
      ? t('collab.conflict.sideSummary', {
        path: version.path,
        size: formatBytes(version.bytes),
      })
      : t('collab.conflict.deleted'));
    parent.append(section);
  }

  private renderFileError(path: string): void {
    const host = this.fileSections.get(path);
    if (!host) return;
    this.destroyPathResources(path);
    host.replaceChildren();
    appendText(host, 'h3', path);
    const error = appendText(host, 'div', t('collab.conflict.fileLoadFailed'), 'mod-warning');
    error.setAttribute('role', 'alert');
  }

  private renderMessage(message: string, warning = false, retry = false): void {
    this.destroyFileResources();
    this.fileSections.clear();
    this.rootEl.replaceChildren();
    const status = appendText(
      this.rootEl,
      'div',
      message,
      warning ? 'claudian-collab-conflict-message mod-warning' : 'claudian-collab-conflict-message',
    );
    status.setAttribute('role', warning ? 'alert' : 'status');
    if (retry && this.operationId) {
      const reload = appendButton(this.rootEl, t('collab.conflict.reload'), 'reload');
      reload.addEventListener('click', () => void this.open(this.operationId!));
    }
  }

  private isCurrent(task: LatestTaskHandle, operationId: CollabOperationId): boolean {
    return !this.destroyed
      && task.isCurrent()
      && !task.signal.aborted
      && this.operationId === operationId;
  }

  private rendererKey(path: string): string {
    return `${path}\u0000`;
  }

  private destroyPathResources(path: string): void {
    const prefix = `${path}\u0000`;
    for (const [key, renderer] of this.comparisonDiffs) {
      if (!key.startsWith(prefix)) continue;
      renderer.destroy();
      this.comparisonDiffs.delete(key);
    }
  }

  private destroyFileResources(): void {
    for (const renderer of this.comparisonDiffs.values()) renderer.destroy();
    this.comparisonDiffs.clear();
  }
}
