import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { createProject } from '@/features/chat/projects/projectActions';
import { createSessionHeaderAction } from '@/features/chat/session-manager/SessionSurfaceShared';
import { t } from '@/i18n/i18n';

/** Renders the Projects section header's New project button. */
export function renderProjectsHeaderActions(header: HTMLElement, host: Pick<ChatFeatureHost, 'app' | 'projects'>): void {
  const actions = header.createDiv({ cls: 'claudian-session-header-actions' });
  createSessionHeaderAction(actions, 'plus', t('chat.projects.newProjectAction'), () => createProject(host));
}
