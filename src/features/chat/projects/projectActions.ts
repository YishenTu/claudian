import { Notice } from 'obsidian';

import type { ProjectRecord } from '@/core/types';
import type { ChatFeatureHost } from '@/features/chat/ChatFeatureHost';
import { ProjectDocModal } from '@/features/chat/projects/ProjectDocModal';
import { ProjectEditorModal } from '@/features/chat/projects/ProjectEditorModal';
import { t } from '@/i18n/i18n';
import { confirm } from '@/shared/modals/ConfirmModal';

/** What project UI needs from the chat host: modals and the project owner. */
export type ProjectUIHost = Pick<ChatFeatureHost, 'app' | 'projects'>;

/** Runs a project action, reporting any failure once as a notice. */
export function runProjectAction(action: () => unknown, failureMessage: string): void {
  void (async () => {
    try {
      await action();
    } catch {
      new Notice(failureMessage);
    }
  })();
}

export function openProjectDoc(host: ProjectUIHost, project: ProjectRecord): void {
  new ProjectDocModal(host.app, { project, docs: host.projects }).open();
}

export function editProject(host: ProjectUIHost, project: ProjectRecord): void {
  new ProjectEditorModal(host.app, {
    project,
    save: input => host.projects.update(project.id, input),
    openDoc: () => openProjectDoc(host, project),
  }).open();
}

/**
 * Creates a project from the editor. `afterCreate` runs once the project exists, outside the modal,
 * so its failure cannot be mistaken for a failed creation and retried into a duplicate.
 */
export function createProject(
  host: ProjectUIHost,
  afterCreate?: { run: (project: ProjectRecord) => Promise<void>; failureMessage: string },
): void {
  new ProjectEditorModal(host.app, {
    project: null,
    save: async (input) => {
      const project = await host.projects.create(input);
      if (afterCreate) runProjectAction(() => afterCreate.run(project), afterCreate.failureMessage);
    },
  }).open();
}

/** Deletes the project after confirmation; member sessions stay and the doc is kept. */
export async function deleteProject(host: ProjectUIHost, project: ProjectRecord): Promise<void> {
  const confirmed = await confirm(
    host.app,
    t('chat.projects.deleteConfirm', { name: project.name }),
    t('common.delete'),
  );
  if (confirmed) await host.projects.delete(project.id);
}
