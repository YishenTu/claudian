import { Menu, Notice, setIcon } from 'obsidian';

import type { ConversationMeta, ProjectRecord } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { resolveLiveProject } from '@/features/chat/execution/projectInstructions';
import {
  createProject,
  deleteProject,
  editProject,
  openProjectMemory,
} from '@/features/chat/projects/projectActions';
import type { SessionListSectionKind } from '@/features/chat/session-manager/SessionListOrganizer';
import type { SessionMultiSelection } from '@/features/chat/session-manager/SessionMultiSelection';
import {
  canShowAttention,
  type HistoryConversationStatus,
  isCompletedReview,
  type SessionStatusDisplay,
} from '@/features/chat/session-manager/SessionStatusPresentation';
import type { TabAttention } from '@/features/chat/state/types';
import { t } from '@/i18n/i18n';
import { confirmDelete } from '@/shared/modals/ConfirmModal';

/** Runs a session action, reporting any failure once as a notice. */
export function runSessionAction(
  action: () => unknown,
  failureMessage: string,
): void {
  void (async () => {
    try {
      await action();
    } catch {
      new Notice(failureMessage);
    }
  })();
}

/**
 * Surface flags and callbacks that decide which session actions are offered. `active` manages
 * live sessions (pin/archive), `archived` manages archived ones (restore/delete), and no mode
 * keeps the compact history's rename/delete.
 */
export interface SessionActionOptions {
  sessionActionMode?: 'active' | 'archived';
  showOpenStateActions?: boolean;
  showInlinePinAction?: boolean;
  onSelectConversation: (id: string) => Promise<void>;
  onOpenConversationInNewTab?: (id: string, activate?: boolean) => Promise<void>;
  onAssignConversationToDevice?: (id: string) => Promise<void>;
  onSetLinkedContentPinned?: (contentPath: string, isPinned: boolean) => Promise<void>;
  /** Starts a draft that joins the project when it becomes a session. */
  onStartProjectConversation?: (projectId: string) => Promise<void>;
  onRerender: () => void;
}

export type SessionRowActionKind =
  | 'open-in-new-tab'
  | 'open-in-background-tab'
  | 'switch-to-open'
  | 'assign-device'
  | 'pin'
  | 'unpin'
  | 'mark-unread'
  | 'mark-read'
  | 'rename'
  | 'copy-session-id'
  | 'move-to-project'
  | 'remove-from-project'
  | 'archive'
  | 'restore'
  | 'delete';

export interface SessionRowAction {
  kind: SessionRowActionKind;
  /** Offered but unavailable, such as archiving a running session. */
  disabled: boolean;
}

/** Inline buttons sit on the row; the menu is its context menu. */
export type SessionRowActionSurface = 'inline' | 'menu';

export interface SessionRowActionInput {
  conversation: ConversationMeta;
  status: Pick<HistoryConversationStatus, 'openState' | 'isRunning'>;
  /** Attention the row presents; null when its surface hides attention. */
  attention: TabAttention | null;
  /** The surface presents attention, so the user can change its unread state. */
  tracksAttention?: boolean;
  /** The session's live project; a stale `projectId` resolves to none. */
  project?: ProjectRecord | null;
}

/** A rendered row; its surface decides where the rename editor appears. */
export interface SessionRow extends SessionRowActionInput {
  beginRename: () => void;
}

const ROW_ACTION_TITLES: Readonly<Record<Exclude<SessionRowActionKind, ProjectRowActionKind>, string>> = {
  'open-in-new-tab': 'Open in new tab',
  'open-in-background-tab': 'Open in background tab',
  'switch-to-open': 'Switch to open session',
  'assign-device': 'Assign to this device',
  pin: 'Pin',
  unpin: 'Unpin',
  'mark-unread': 'Mark as unread',
  'mark-read': 'Mark as read',
  rename: 'Rename',
  'copy-session-id': 'Copy session ID',
  archive: 'Archive',
  restore: 'Restore',
  delete: 'Delete',
};

const INLINE_BUTTONS: Readonly<Partial<Record<SessionRowActionKind, { cls: string; icon: string }>>> = {
  'open-in-new-tab': { cls: 'claudian-open-new-tab-btn', icon: 'square-plus' },
  'assign-device': { cls: 'claudian-assign-device-btn', icon: 'monitor-down' },
  pin: { cls: 'claudian-pin-btn', icon: 'pin' },
  unpin: { cls: 'claudian-pin-btn', icon: 'pin-off' },
  rename: { cls: '', icon: 'pencil' },
  archive: { cls: 'claudian-archive-btn', icon: 'archive' },
  restore: { cls: 'claudian-restore-btn', icon: 'undo-2' },
  delete: { cls: 'claudian-delete-btn', icon: 'trash-2' },
};

type ProjectRowActionKind = 'move-to-project' | 'remove-from-project';
type SynchronousRowActionKind = 'rename' | 'mark-unread' | 'mark-read' | 'move-to-project';

function rowActionTitle(kind: SessionRowActionKind): string {
  if (kind === 'move-to-project') return t('chat.projects.menu.moveTo');
  if (kind === 'remove-from-project') return t('chat.projects.menu.removeFrom');
  return ROW_ACTION_TITLES[kind];
}

function rowActionFailure(kind: Exclude<SessionRowActionKind, SynchronousRowActionKind>): string {
  return kind === 'remove-from-project' ? t('chat.projects.errors.remove') : ROW_ACTION_FAILURES[kind];
}

const ROW_ACTION_FAILURES: Readonly<Record<Exclude<SessionRowActionKind, SynchronousRowActionKind | ProjectRowActionKind>, string>> = {
  'open-in-new-tab': 'Failed to load conversation',
  'open-in-background-tab': 'Failed to load conversation',
  'switch-to-open': 'Failed to load conversation',
  'copy-session-id': 'Failed to copy session ID',
  'assign-device': 'Failed to assign session to this device',
  pin: 'Failed to pin session',
  unpin: 'Failed to unpin session',
  archive: 'Failed to archive session',
  restore: 'Failed to restore session',
  delete: 'Failed to delete conversation',
};

function action(kind: SessionRowActionKind, disabled = false): SessionRowAction {
  return { kind, disabled };
}

/** Only the unread dot or no badge can be toggled; every other badge keeps its own state. */
function readStateAction(input: SessionRowActionInput): SessionRowAction | null {
  if (!input.tracksAttention) return null;
  if (isCompletedReview(input.attention ?? undefined)) return action('mark-read');
  if (input.attention === null && !input.status.isRunning) return action('mark-unread');
  return null;
}

/** The single policy for which actions a session row offers on each surface. */
export function resolveRowActions(
  surface: SessionRowActionSurface,
  input: SessionRowActionInput,
  options: SessionActionOptions,
): SessionRowAction[] {
  const { conversation, status } = input;
  const mode = options.sessionActionMode;
  const pinAction = action(conversation.isPinned === true ? 'unpin' : 'pin');
  // A running session cannot be archived; bulk actions skip it instead.
  const archiveAction = action('archive', status.isRunning);
  const actions: SessionRowAction[] = [];

  if (surface === 'inline') {
    if (status.openState === 'closed' && options.onOpenConversationInNewTab) {
      actions.push(action('open-in-new-tab'));
    }
    if (conversation.isLegacySession && options.onAssignConversationToDevice) {
      actions.push(action('assign-device'));
    }
    if (mode === 'active') {
      // Rows waiting on the user or showing an error present only their badge.
      if (input.attention === null || isCompletedReview(input.attention)) {
        if (options.showInlinePinAction !== false) actions.push(pinAction);
        actions.push(archiveAction);
      }
    } else if (mode === 'archived') {
      actions.push(action('restore'), action('delete'));
    } else {
      actions.push(action('rename'), action('delete'));
    }
    return actions;
  }

  if (options.showOpenStateActions !== false && status.openState !== 'current') {
    if (status.openState === 'closed' && options.onOpenConversationInNewTab) {
      actions.push(action('open-in-new-tab'), action('open-in-background-tab'));
    } else if (status.openState === 'open') {
      actions.push(action('switch-to-open'));
    }
  }
  if (mode === 'archived') {
    actions.push(action('restore'), action('delete'));
    return actions;
  }
  if (mode === 'active') {
    actions.push(pinAction);
    const readAction = readStateAction(input);
    if (readAction) actions.push(readAction);
  }
  // The ID lets the user point an agent's claudian_send_message at this session.
  actions.push(action('rename'), action('copy-session-id'));
  if (mode === 'active') {
    actions.push(action('move-to-project'));
    if (input.project) actions.push(action('remove-from-project'));
  }
  actions.push(mode === 'active' ? archiveAction : action('delete'));
  return actions;
}

/** Multi-selection exists only where a bulk action can act on it. */
export function canMultiSelect(options: SessionActionOptions): boolean {
  return options.sessionActionMode === 'archived' || options.sessionActionMode === 'active';
}

/** A session group: a Linked content section, a project section, or a recency divider's sessions. */
export interface SessionGroupActionTarget {
  conversations: readonly ConversationMeta[];
  linkedContent?: {
    path: string;
    kind: SessionListSectionKind;
    isPinned: boolean;
  };
  project?: ProjectRecord;
}

export interface SessionActionsDeps {
  plugin: Pick<ChatFeatureHost, 'app' | 'getConversationList' | 'conversationLifecycle' | 'sessionRuntimes' | 'projects'>;
  selection: SessionMultiSelection;
}

/** Opens a follow-up menu at the pointer, or under the activated menu item for keyboard use. */
/** A keyboard-chosen item's target is the closing menu, so the follow-up opens under the row it acts on. */
function showFollowUpMenu(menu: Menu, event: MouseEvent | KeyboardEvent | undefined, anchorEl: HTMLElement): void {
  if (event && 'clientX' in event) {
    menu.showAtMouseEvent(event);
    return;
  }
  const rect = anchorEl.getBoundingClientRect();
  menu.showAtPosition({ x: rect.left, y: rect.bottom });
}

function sessionCount(count: number): string {
  return `${count} ${count === 1 ? 'session' : 'sessions'}`;
}

/** Offers and runs session actions for rows, multi-selections, and groups. */
export class SessionActions {
  constructor(private readonly deps: SessionActionsDeps) {}

  renderRowButtons(
    actionsEl: HTMLElement,
    row: SessionRow,
    options: SessionActionOptions,
  ): void {
    for (const rowAction of resolveRowActions('inline', row, options)) {
      const presentation = INLINE_BUTTONS[rowAction.kind];
      if (!presentation) continue;
      const button = actionsEl.createEl('button', {
        cls: ['claudian-action-btn', presentation.cls].filter(Boolean).join(' '),
        attr: { type: 'button' },
      });
      setIcon(button, presentation.icon);
      button.setAttribute(
        'aria-label',
        rowAction.kind === 'archive' && rowAction.disabled
          ? 'Cannot archive a running session'
          : rowActionTitle(rowAction.kind),
      );
      if (rowAction.disabled) {
        button.setAttribute('disabled', '');
        continue;
      }
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        this.#runRowAction(rowAction.kind, row, options);
      });
    }
  }

  /** `anchorEl` is the row the menu opened on; follow-up menus open beside it. */
  rowMenu(row: SessionRow, options: SessionActionOptions & SessionStatusDisplay, anchorEl: HTMLElement): Menu {
    const menu = new Menu().setUseNativeMenu(false);
    const tracksAttention = canShowAttention(options);
    const project = this.#liveProject(row.conversation);
    for (const rowAction of resolveRowActions('menu', { ...row, tracksAttention, project }, options)) {
      menu.addItem((menuItem) => {
        menuItem.setTitle(rowActionTitle(rowAction.kind));
        if (rowAction.disabled) {
          menuItem.setDisabled(true);
          return;
        }
        if (rowAction.kind === 'move-to-project') {
          menuItem.onClick((event) => {
            this.#showProjectPicker([row.conversation.id], project?.id ?? null, event, anchorEl);
          });
          return;
        }
        menuItem.onClick(() => {
          this.#runRowAction(rowAction.kind, row, options);
        });
      });
    }
    return menu;
  }

  /** Bulk actions for the selected sessions of the current scope; running sessions are skipped. */
  selectionMenu(
    options: SessionActionOptions,
    isRunning: (conversation: ConversationMeta) => boolean,
    anchorEl: HTMLElement,
  ): Menu {
    const { selection } = this.deps;
    const lifecycle = this.deps.plugin.conversationLifecycle;
    const isArchivedView = options.sessionActionMode === 'archived';
    const selected = this.deps.plugin.getConversationList()
      .filter(conversation => (
        selection.has(conversation.id)
        && (conversation.isArchived === true) === isArchivedView
      ));
    const menu = new Menu().setUseNativeMenu(false);

    if (isArchivedView) {
      const ids = selected.map(conversation => conversation.id);
      menu.addItem(menuItem => menuItem
        .setTitle(`Restore ${sessionCount(ids.length)}`)
        .onClick(() => {
          selection.clear();
          runSessionAction(() => lifecycle.restore(ids), 'Failed to restore sessions');
        }));
      menu.addItem(menuItem => menuItem
        .setTitle(`Delete ${sessionCount(ids.length)}`)
        .onClick(() => {
          selection.clear();
          runSessionAction(
            () => this.deleteSessions(ids, { confirm: true, rerender: options.onRerender }),
            'Failed to delete sessions',
          );
        }));
      return menu;
    }

    if (options.sessionActionMode === 'active') {
      const unpinnedIds = selected
        .filter(conversation => !conversation.isPinned)
        .map(conversation => conversation.id);
      const isPinning = unpinnedIds.length > 0;
      const pinIds = isPinning ? unpinnedIds : selected.map(conversation => conversation.id);
      menu.addItem(menuItem => menuItem
        .setTitle(`${isPinning ? 'Pin' : 'Unpin'} ${sessionCount(pinIds.length)}`)
        .onClick(() => {
          selection.clear();
          runSessionAction(
            () => lifecycle.setPinned(pinIds, isPinning),
            isPinning ? 'Failed to pin sessions' : 'Failed to unpin sessions',
          );
        }));
    }

    if (options.sessionActionMode === 'active') {
      const ids = selected.map(conversation => conversation.id);
      const sharedProjectId = this.#sharedProjectId(selected);
      menu.addItem(menuItem => menuItem
        .setTitle(t('chat.projects.menu.moveSelectionTo', { count: ids.length }))
        .onClick((event) => {
          this.#showProjectPicker(ids, sharedProjectId, event, anchorEl);
        }));
      const memberIds = selected
        .filter(conversation => this.#liveProject(conversation) !== null)
        .map(conversation => conversation.id);
      if (memberIds.length > 0) {
        menu.addItem(menuItem => menuItem
          .setTitle(t('chat.projects.menu.removeSelectionFrom', { count: memberIds.length }))
          .onClick(() => {
            selection.clear();
            runSessionAction(
              () => this.deps.plugin.projects.setConversationsProject(memberIds, null),
              t('chat.projects.errors.remove'),
            );
          }));
      }
    }

    const archivableIds = selected
      .filter(conversation => !isRunning(conversation))
      .map(conversation => conversation.id);
    menu.addItem((menuItem) => {
      menuItem
        .setTitle(`Archive ${sessionCount(archivableIds.length)}`)
        .setDisabled(archivableIds.length === 0);
      if (archivableIds.length > 0 && options.sessionActionMode === 'active') {
        menuItem.onClick(() => {
          selection.clear();
          runSessionAction(
            () => lifecycle.archive(archivableIds),
            'Failed to archive sessions',
          );
        });
      }
    });
    return menu;
  }

  /**
   * Builds the group's action menu on demand, or returns null when the group offers none.
   * Linked content may be pinned; active projects are managed from their section; active groups
   * archive their idle sessions; archived groups restore or permanently delete every session.
   */
  groupMenu(
    target: SessionGroupActionTarget,
    options: SessionActionOptions,
    isRunning: (conversation: ConversationMeta) => boolean,
  ): (() => Menu) | null {
    const { conversations, linkedContent, project } = target;
    const { onSetLinkedContentPinned } = options;
    const lifecycle = this.deps.plugin.conversationLifecycle;
    const isArchivedView = options.sessionActionMode === 'archived';
    const canTogglePin = !!(
      linkedContent
      && onSetLinkedContentPinned
      && !isArchivedView
      && (linkedContent.kind === 'content' || linkedContent.kind === 'missing' || linkedContent.isPinned)
    );
    const canArchive = options.sessionActionMode === 'active';
    const managedProject = project && !isArchivedView ? project : null;
    if (!canTogglePin && !canArchive && !isArchivedView && !managedProject) return null;

    return () => {
      const menu = new Menu().setUseNativeMenu(false);
      if (managedProject) this.#addProjectActions(menu, managedProject, options);
      if (canTogglePin && linkedContent && onSetLinkedContentPinned) {
        const { path, isPinned } = linkedContent;
        menu.addItem(menuItem => menuItem
          .setTitle(isPinned ? 'Unpin Linked content' : 'Pin Linked content')
          .onClick(() => {
            runSessionAction(
              () => onSetLinkedContentPinned(path, !isPinned),
              isPinned ? 'Failed to unpin Linked content' : 'Failed to pin Linked content',
            );
          }));
      }
      if (canArchive) {
        if (canTogglePin || managedProject) menu.addSeparator();
        const archivableIds = conversations
          .filter(conversation => !isRunning(conversation))
          .map(conversation => conversation.id);
        const failureMessage = linkedContent
          ? 'Failed to archive Linked content sessions'
          : 'Failed to archive sessions';
        menu.addItem((menuItem) => {
          menuItem
            .setTitle(project ? t('chat.projects.menu.archiveIdle') : 'Archive all sessions')
            .setDisabled(archivableIds.length === 0);
          if (archivableIds.length > 0) {
            menuItem.onClick(() => {
              runSessionAction(() => lifecycle.archive(archivableIds), failureMessage);
            });
          }
        });
      }
      if (isArchivedView) {
        this.#addRestoreAndDeleteAll(menu, conversations, options);
      }
      if (managedProject) {
        menu.addSeparator();
        menu.addItem(menuItem => menuItem
          .setTitle(t('chat.projects.menu.delete'))
          .setWarning(true)
          .onClick(() => {
            runSessionAction(
              () => deleteProject(this.deps.plugin, managedProject),
              t('chat.projects.errors.delete'),
            );
          }));
      }
      return menu;
    };
  }

  #addProjectActions(menu: Menu, project: ProjectRecord, options: SessionActionOptions): void {
    const { plugin } = this.deps;
    const { onStartProjectConversation } = options;
    if (onStartProjectConversation) {
      menu.addItem(menuItem => menuItem
        .setTitle(t('chat.projects.menu.newSession'))
        .onClick(() => {
          runSessionAction(() => onStartProjectConversation(project.id), t('chat.projects.errors.start'));
        }));
    }
    menu.addItem(menuItem => menuItem
      .setTitle(t('chat.projects.menu.edit'))
      .onClick(() => editProject(plugin, project)));
    menu.addItem(menuItem => menuItem
      .setTitle(t('chat.projects.menu.openMemory'))
      .onClick(() => openProjectMemory(plugin, project)));
    menu.addItem(menuItem => menuItem
      .setTitle(project.isPinned ? t('chat.projects.menu.unpin') : t('chat.projects.menu.pin'))
      .onClick(() => {
        runSessionAction(
          () => plugin.projects.setPinned(project.id, !project.isPinned),
          t('chat.projects.errors.pin'),
        );
      }));
  }

  /** Projects to move the sessions into, plus creating one for them. */
  #showProjectPicker(
    conversationIds: readonly string[],
    currentProjectId: string | null,
    event: MouseEvent | KeyboardEvent | undefined,
    anchorEl: HTMLElement,
  ): void {
    const { plugin, selection } = this.deps;
    const moveFailure = t('chat.projects.errors.move');
    const projects = [...plugin.projects.list()].sort((left, right) => (
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base', numeric: true })
    ));
    const menu = new Menu().setUseNativeMenu(false);
    for (const project of projects) {
      menu.addItem((menuItem) => {
        menuItem.setTitle(project.name);
        if (project.id === currentProjectId) menuItem.setChecked(true);
        menuItem.onClick(() => {
          selection.clear();
          runSessionAction(
            () => plugin.projects.setConversationsProject(conversationIds, project.id),
            moveFailure,
          );
        });
      });
    }
    if (projects.length > 0) menu.addSeparator();
    menu.addItem(menuItem => menuItem
      .setTitle(t('chat.projects.menu.newProject'))
      .onClick(() => {
        selection.clear();
        createProject(plugin, {
          run: project => plugin.projects.setConversationsProject(conversationIds, project.id),
          failureMessage: moveFailure,
        });
      }));
    showFollowUpMenu(menu, event, anchorEl);
  }

  #liveProject(conversation: ConversationMeta): ProjectRecord | null {
    // A session outside any project never needs the project owner.
    return conversation.projectId ? resolveLiveProject(this.deps.plugin.projects, conversation.projectId) : null;
  }

  /** The live project every given session belongs to, if they share one. */
  #sharedProjectId(conversations: readonly ConversationMeta[]): string | null {
    const projectIds = new Set(conversations.map(conversation => this.#liveProject(conversation)?.id ?? null));
    return projectIds.size === 1 ? [...projectIds][0] : null;
  }

  /**
   * Deletes sessions, after one confirmation when requested. The conversation lifecycle owns the
   * running guard.
   */
  async deleteSessions(
    conversationIds: readonly string[],
    options: { confirm: boolean; rerender: () => void },
  ): Promise<void> {
    const { plugin } = this.deps;
    if (!options.confirm) {
      await plugin.conversationLifecycle.delete(conversationIds);
      options.rerender();
      return;
    }

    const count = conversationIds.length;
    const confirmed = await confirmDelete(
      plugin.app,
      `Permanently delete ${sessionCount(count)}?`,
    );
    if (!confirmed) return;

    try {
      await plugin.conversationLifecycle.delete(conversationIds);
    } finally {
      options.rerender();
    }
  }

  #addRestoreAndDeleteAll(
    menu: Menu,
    conversations: readonly ConversationMeta[],
    options: SessionActionOptions,
  ): void {
    const ids = conversations.map(conversation => conversation.id);
    const lifecycle = this.deps.plugin.conversationLifecycle;
    menu.addItem(menuItem => menuItem
      .setTitle('Restore all sessions')
      .setDisabled(ids.length === 0)
      .onClick(() => {
        runSessionAction(() => lifecycle.restore(ids), 'Failed to restore sessions');
      }));
    menu.addItem(menuItem => menuItem
      .setTitle('Delete all sessions')
      .setDisabled(ids.length === 0)
      .onClick(() => {
        runSessionAction(
          () => this.deleteSessions(ids, { confirm: true, rerender: options.onRerender }),
          'Failed to delete sessions',
        );
      }));
  }

  #runRowAction(kind: SessionRowActionKind, row: SessionRow, options: SessionActionOptions): void {
    const { id } = row.conversation;
    if (kind === 'rename') {
      row.beginRename();
      return;
    }
    if (kind === 'mark-unread') {
      // Attention lives on the session, which a session not loaded since startup does not have yet.
      this.deps.plugin.sessionRuntimes.ensure({
        conversationId: id, providerId: row.conversation.providerId, draftModel: null,
      }).attention.markReviewRequired('completed');
      return;
    }
    if (kind === 'mark-read') {
      this.deps.plugin.sessionRuntimes.get(id)?.attention.acknowledgeReview();
      return;
    }
    if (kind === 'move-to-project') return;
    const failureMessage = rowActionFailure(kind);
    runSessionAction((): Promise<void> | undefined => {
      switch (kind) {
        case 'open-in-new-tab':
          return options.onOpenConversationInNewTab?.(id, true);
        case 'open-in-background-tab':
          return options.onOpenConversationInNewTab?.(id, false);
        case 'switch-to-open':
          return options.onSelectConversation(id);
        case 'assign-device':
          return options.onAssignConversationToDevice?.(id);
        case 'copy-session-id':
          return navigator.clipboard.writeText(id).then(() => { new Notice('Session ID copied'); });
        case 'pin':
        case 'unpin':
          return this.deps.plugin.conversationLifecycle.setPinned([id], kind === 'pin');
        case 'archive':
        case 'restore':
          return this.deps.plugin.conversationLifecycle.setArchived(id, kind === 'archive');
        case 'delete':
          return this.deleteSessions([id], { confirm: false, rerender: options.onRerender });
        case 'remove-from-project':
          return this.deps.plugin.projects.setConversationsProject([id], null);
      }
    }, failureMessage);
  }
}
