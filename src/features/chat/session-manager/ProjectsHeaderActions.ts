import { Menu, Notice } from 'obsidian';

import type { SessionManagerSort } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { createProject } from '@/features/chat/projects/projectActions';
import { createSessionHeaderAction, showMenuAt } from '@/features/chat/session-manager/SessionSurfaceShared';
import { t } from '@/i18n/i18n';

type ProjectsHeaderHost = Pick<ChatFeatureHost, 'app' | 'projects' | 'settings' | 'mutateSettings'>;

export function getProjectSort(host: Pick<ChatFeatureHost, 'settings'>): SessionManagerSort {
  return host.settings.projectSort === 'created' ? 'created' : 'last-updated';
}

/** Adds the Projects header's options and New project buttons to a rendered list, in either presentation. */
export function buildProjectsHeaderActions(container: HTMLElement, host: ProjectsHeaderHost): void {
  const header = container.querySelector<HTMLElement>('.claudian-session-projects-header');
  if (!header) return;
  const actions = header.createDiv({ cls: 'claudian-session-header-actions' });
  const optionsButton = createSessionHeaderAction(
    actions,
    'ellipsis',
    t('chat.projects.options'),
    event => showProjectOptionsMenu(host, optionsButton, event),
  );
  createSessionHeaderAction(actions, 'plus', t('chat.projects.newProjectAction'), () => createProject(host));
}

function showProjectOptionsMenu(host: ProjectsHeaderHost, anchor: HTMLElement, event?: MouseEvent): void {
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
}

function setProjectSort(host: ProjectsHeaderHost, sort: SessionManagerSort): void {
  void host.mutateSettings((settings) => {
    settings.projectSort = sort;
  })
    .catch(() => new Notice(t('chat.projects.errors.sort')));
}
