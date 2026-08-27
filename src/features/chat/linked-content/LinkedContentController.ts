import type { App } from 'obsidian';
import { Notice, TFile, TFolder } from 'obsidian';

import {
  assertLinkedContentPath,
  normalizeLinkedContentPath,
} from '@/core/path/LinkedContentPath';
import type { ComposerContextTray } from '@/features/chat/ui/ComposerContextTray';

import { LinkedContentChip } from './LinkedContentChip';
import { LinkedContentPickerSource } from './LinkedContentPickerSource';
import {
  deriveLinkedContentPresentation,
  type LinkedContentPresentation,
} from './LinkedContentPresentation';
import { LinkedContentSelector } from './LinkedContentSelector';

export type LinkedContentMode = 'auto-draft' | 'explicit-draft' | 'submitting' | 'locked';

export interface LinkedContentSnapshot {
  readonly mode: LinkedContentMode;
  readonly path: string | null;
}

type ExcludedTagState = 'excluded' | 'not-excluded' | 'unknown';

export interface LinkedContentSubmissionToken {
  readonly path?: string;
}

export type LinkedContentPathEvent =
  | {
    readonly kind: 'rename';
    readonly oldPath: string;
    readonly newPath: string;
    readonly includeDescendants: boolean;
  }
  | {
    readonly kind: 'delete';
    readonly path: string;
    readonly includeDescendants: boolean;
  };

export interface LinkedContentSubmissionSettlement {
  readonly linkedContentPath?: string;
  readonly queuedEvents: readonly LinkedContentPathEvent[];
}

export interface LinkedContentControllerOptions {
  readonly app: App;
  readonly getExcludedTags: () => readonly string[];
  readonly getCachedVaultFiles: () => readonly TFile[];
  readonly getCachedVaultFolders: () => readonly { readonly name: string; readonly path: string }[];
}

interface DraftCheckpoint {
  readonly mode: 'auto-draft' | 'explicit-draft';
  readonly path: string | null;
}

interface ActiveSubmission {
  readonly token: LinkedContentSubmissionToken;
  readonly checkpoint: DraftCheckpoint;
  readonly queuedEvents: LinkedContentPathEvent[];
}

function isSameOrDescendant(path: string, parentPath: string, includeDescendants: boolean): boolean {
  return path === parentPath
    || (includeDescendants && path.startsWith(`${parentPath}/`));
}

function rewritePath(
  path: string,
  oldPath: string,
  newPath: string,
  includeDescendants: boolean,
): string | null {
  if (path === oldPath) return newPath;
  if (includeDescendants && path.startsWith(`${oldPath}/`)) {
    return `${newPath}${path.slice(oldPath.length)}`;
  }
  return null;
}

export class LinkedContentController {
  private readonly app: App;
  private readonly options: LinkedContentControllerOptions;
  private readonly pickerSource: LinkedContentPickerSource;
  private mode: LinkedContentMode = 'auto-draft';
  private path: string | null = null;
  private activeSubmission: ActiveSubmission | null = null;
  private selector: LinkedContentSelector | null = null;
  private chip: LinkedContentChip | null = null;
  private destroyed = false;

  constructor(options: LinkedContentControllerOptions) {
    this.options = options;
    this.app = options.app;
    this.pickerSource = new LinkedContentPickerSource({
      getCachedVaultFiles: options.getCachedVaultFiles,
      getCachedVaultFolders: options.getCachedVaultFolders,
    });
  }

  getSnapshot(): LinkedContentSnapshot {
    return {
      mode: this.mode,
      path: this.path,
    };
  }

  resetAutoDraft(): void {
    this.assertLive();
    this.activeSubmission = null;
    this.mode = 'auto-draft';
    this.path = this.eligibleActiveFilePath(this.app.workspace.getActiveFile());
    this.publish();
  }

  selectExplicit(path: string | null): void {
    this.assertLive();
    if (this.mode === 'submitting') {
      throw new Error('Linked content cannot be changed while submitting');
    }
    if (this.mode === 'locked') {
      throw new Error('Linked content is locked for this Conversation');
    }
    this.mode = 'explicit-draft';
    this.path = path === null ? null : assertLinkedContentPath(path);
    this.publish();
  }

  handleActiveFileChanged(file: TFile | null, isActiveOwner: boolean): void {
    if (this.destroyed || !isActiveOwner || this.mode !== 'auto-draft') return;
    this.reconcileAutoDraftPath(file);
  }

  handleActiveFileMetadataChanged(file: TFile | null): void {
    if (this.destroyed || this.mode !== 'auto-draft') return;
    const activeFile = this.app.workspace.getActiveFile();
    if (file !== null && activeFile?.path !== file.path) return;
    this.reconcileAutoDraftPath(activeFile);
  }

  lock(path: string | undefined): void {
    this.assertLive();
    this.activeSubmission = null;
    this.mode = 'locked';
    this.path = path === undefined ? null : assertLinkedContentPath(path);
    this.publish();
  }

  beginSubmission(): LinkedContentSubmissionToken {
    this.assertLive();
    if (this.mode !== 'auto-draft' && this.mode !== 'explicit-draft') {
      throw new Error('Linked content submission requires an editable draft');
    }
    const checkpoint: DraftCheckpoint = { mode: this.mode, path: this.path };
    const token = Object.freeze(
      this.path === null ? {} : { path: this.path },
    ) as LinkedContentSubmissionToken;
    this.activeSubmission = { token, checkpoint, queuedEvents: [] };
    this.mode = 'submitting';
    this.publish();
    return token;
  }

  commitSubmission(token: LinkedContentSubmissionToken): LinkedContentSubmissionSettlement {
    this.assertLive();
    const submission = this.requireSubmission(token);
    this.mode = 'locked';
    this.path = token.path ?? null;
    for (const event of submission.queuedEvents) this.applyPathEvent(event);
    this.activeSubmission = null;
    this.publish();
    return {
      ...(this.path === null ? {} : { linkedContentPath: this.path }),
      queuedEvents: [...submission.queuedEvents],
    };
  }

  rollbackSubmission(token: LinkedContentSubmissionToken): void {
    this.assertLive();
    const submission = this.requireSubmission(token);
    this.mode = submission.checkpoint.mode;
    this.path = submission.checkpoint.path;
    for (const event of submission.queuedEvents) this.applyPathEvent(event);
    this.activeSubmission = null;
    this.publish();
  }

  handleRenamed(
    oldPath: string,
    newPath: string,
    includeDescendants = false,
  ): void {
    if (this.destroyed) return;
    const event: LinkedContentPathEvent = {
      kind: 'rename',
      oldPath: assertLinkedContentPath(oldPath),
      newPath: assertLinkedContentPath(newPath),
      includeDescendants,
    };
    if (this.activeSubmission) {
      this.activeSubmission.queuedEvents.push(event);
      return;
    }
    if (this.applyPathEvent(event)) this.publish();
  }

  handleDeleted(path: string, includeDescendants = false): void {
    if (this.destroyed) return;
    const event: LinkedContentPathEvent = {
      kind: 'delete',
      path: assertLinkedContentPath(path),
      includeDescendants,
    };
    if (this.activeSubmission) {
      this.activeSubmission.queuedEvents.push(event);
      return;
    }
    if (this.applyPathEvent(event)) this.publish();
  }

  handleCreated(path: string): void {
    if (this.destroyed || this.path === null) return;
    const normalizedPath = assertLinkedContentPath(path);
    if (normalizedPath === this.path) this.publish();
  }

  mountWelcome(welcomeEl: HTMLElement): void {
    this.assertLive();
    this.selector?.destroy();
    const mountEl = welcomeEl.querySelector<HTMLElement>('.claudian-welcome-linked-content');
    if (!mountEl) {
      throw new Error('Welcome content does not expose a Linked content mount');
    }
    this.selector = new LinkedContentSelector(mountEl, {
      listItems: () => this.pickerSource.list(),
      onSelect: path => this.selectExplicit(path),
    });
    this.renderSelector();
  }

  unmountWelcome(): void {
    this.selector?.destroy();
    this.selector = null;
  }

  mountContextTray(contextTray: ComposerContextTray): void {
    this.assertLive();
    this.chip?.destroy();
    this.chip = new LinkedContentChip(contextTray, () => {
      void this.activateCurrentContent();
    }, () => {
      this.selectExplicit(null);
    });
    this.renderChip();
  }

  unmountContextTray(): void {
    this.chip?.destroy();
    this.chip = null;
  }

  async activateCurrentContent(): Promise<void> {
    if (this.destroyed || !this.path) return;
    const content = deriveLinkedContentPresentation(this.app, this.path);
    if (content.missing || !content.target) {
      new Notice(`Linked content is missing: ${this.path}`);
      return;
    }
    if (content.target instanceof TFile) {
      try {
        await this.app.workspace.getLeaf().openFile(content.target);
      } catch (error) {
        new Notice(
          `Failed to open Linked content: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return;
    }
    if (content.target instanceof TFolder) await this.revealFolder(content.target);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.activeSubmission = null;
    this.unmountWelcome();
    this.unmountContextTray();
  }

  private requireSubmission(token: LinkedContentSubmissionToken): ActiveSubmission {
    if (!this.activeSubmission || this.activeSubmission.token !== token) {
      throw new Error('Stale Linked content submission');
    }
    return this.activeSubmission;
  }

  private applyPathEvent(event: LinkedContentPathEvent): boolean {
    if (this.path === null) return false;
    if (event.kind === 'rename') {
      const renamed = rewritePath(
        this.path,
        event.oldPath,
        event.newPath,
        event.includeDescendants,
      );
      if (!renamed) return false;
      this.path = assertLinkedContentPath(renamed);
      return true;
    }
    if (!isSameOrDescendant(this.path, event.path, event.includeDescendants)) return false;
    if (this.mode === 'locked') return true;
    this.mode = 'explicit-draft';
    this.path = null;
    return true;
  }

  private reconcileAutoDraftPath(file: TFile | null): void {
    const nextPath = this.eligibleActiveFilePath(file);
    if (nextPath === this.path) return;
    this.path = nextPath;
    this.publish();
  }

  private eligibleActiveFilePath(file: TFile | null): string | null {
    if (
      !file
      || file.extension.toLocaleLowerCase() !== 'md'
      || this.getExcludedTagState(file) !== 'not-excluded'
    ) {
      return null;
    }
    return normalizeLinkedContentPath(file.path);
  }

  private getExcludedTagState(file: TFile): ExcludedTagState {
    const excludedTags = this.options.getExcludedTags();
    if (excludedTags.length === 0) return 'not-excluded';
    const cache = this.app.metadataCache.getFileCache(file);
    if (!cache) return 'unknown';
    const fileTags: string[] = [];
    const frontmatterTags: unknown = cache.frontmatter?.tags;
    if (Array.isArray(frontmatterTags)) {
      fileTags.push(...frontmatterTags.filter(
        (tag): tag is string => typeof tag === 'string',
      ));
    } else if (typeof frontmatterTags === 'string') {
      fileTags.push(frontmatterTags);
    }
    if (cache.tags) fileTags.push(...cache.tags.map(tag => tag.tag));
    const normalizedExcluded = new Set(excludedTags.map(tag => tag.replace(/^#/, '')));
    return fileTags.some(tag => normalizedExcluded.has(tag.replace(/^#/, '')))
      ? 'excluded'
      : 'not-excluded';
  }

  private publish(): void {
    const snapshot = this.getSnapshot();
    const presentation = this.derivePresentation(snapshot.path);
    this.renderSelector(snapshot, presentation);
    this.renderChip(presentation);
  }

  private renderSelector(
    snapshot = this.getSnapshot(),
    presentation = this.derivePresentation(snapshot.path),
  ): void {
    this.selector?.render({
      mode: snapshot.mode,
      path: snapshot.path,
      label: presentation?.missing
        ? `${presentation.label} · Missing content`
        : presentation?.label ?? null,
    });
  }

  private renderChip(presentation = this.derivePresentation(this.path)): void {
    const removable = this.mode === 'auto-draft' || this.mode === 'explicit-draft';
    this.chip?.render(presentation, removable);
  }

  private derivePresentation(path: string | null): LinkedContentPresentation | null {
    return path ? deriveLinkedContentPresentation(this.app, path) : null;
  }

  private async revealFolder(folder: TFolder): Promise<void> {
    type FileExplorerView = {
      revealInFolder?: (target: TFolder) => Promise<void> | void;
      revealFile?: (target: TFolder) => Promise<void> | void;
    };
    type FileExplorerLeaf = {
      view?: FileExplorerView;
      setViewState?: (state: { type: string; active: boolean }) => Promise<void>;
    };
    const workspace = this.app.workspace;
    let leaf = workspace.getLeavesOfType('file-explorer')[0] as FileExplorerLeaf | undefined;
    if (!leaf) {
      leaf = (workspace.getLeftLeaf(false) ?? workspace.getLeaf('tab')) as unknown as FileExplorerLeaf;
      await leaf.setViewState?.({ type: 'file-explorer', active: true });
    }
    await workspace.revealLeaf(leaf as never);
    const reveal = leaf.view?.revealInFolder ?? leaf.view?.revealFile;
    await reveal?.call(leaf.view, folder);
  }

  private assertLive(): void {
    if (this.destroyed) throw new Error('Linked content controller is destroyed');
  }
}
