import { Menu, Notice } from 'obsidian';

import type { SessionManagerSort } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { createProject } from '@/features/chat/projects/projectActions';
import {
  createSessionHeaderAction,
  createSessionHeaderMenuAction,
  showMenuAt,
} from '@/features/chat/session-manager/SessionSurfaceShared';
import { t } from '@/i18n/i18n';

type ProjectsHeaderHost = Pick<ChatFeatureHost, 'app' | 'projects' | 'settings' | 'mutateSettings'>;

export function getProjectSort(host: Pick<ChatFeatureHost, 'settings'>): SessionManagerSort {
  return host.settings.projectSort === 'created' ? 'created' : 'last-updated';
}

/** Renders the Projects section header's options (project sort) and New project buttons. */
export function renderProjectsHeaderActions(header: HTMLElement, host: ProjectsHeaderHost): void {
  const actions = header.createDiv({ cls: 'claudian-session-header-actions' });
  createSessionHeaderMenuAction(
    actions,
    'ellipsis',
    t('chat.projects.options'),
    (anchor, event) => showProjectOptionsMenu(host, anchor, event),
  );
  createSessionHeaderAction(actions, 'plus', t('chat.projects.newProjectAction'), () => createProject(host));
}

function showProjectOptionsMenu(host: ProjectsHeaderHost, anchor: HTMLElement, event?: MouseEvent): Menu {
  const menu = new Menu().setUseNativeMenu(false);
  const sort = getProjectSort(host);
  menu.addItem(item => item
    .setTitle(t('chat.projects.sortBy'))
    .setIsLabel(true));
  menu.addItem(item => item
    .setTitle(t('chat.projects.sort.lastActivity'))
    .setChecked(sort === 'last-updated')
    .onClick(() => setProjectSort(host, 'last-updated')));
  menu.addItem(item => item
    .setTitle(t('chat.projects.sort.created'))
    .setChecked(sort === 'created')
    .onClick(() => setProjectSort(host, 'created')));
  showMenuAt(menu, anchor, event);
  return menu;
}

function setProjectSort(host: ProjectsHeaderHost, sort: SessionManagerSort): void {
  void host.mutateSettings((settings) => {
    settings.projectSort = sort;
  })
    .catch(() => new Notice(t('chat.projects.errors.sort')));
}
