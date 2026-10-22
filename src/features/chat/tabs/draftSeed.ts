import type { ProjectReader } from '@/core/types';
import type { ChatSessionRuntime } from '@/features/chat/sessions/ChatSessionRuntime';
import type { DraftSeed } from '@/features/chat/tabs/types';

/** The raw project a session belongs to, or its blank draft is seeded with. */
export function sessionProjectId(runtime: ChatSessionRuntime): string | undefined {
  return runtime.model.conversationController.project.projectId;
}

/**
 * What New starts from the session the user is in: a draft in that session's live project, or a draft with no
 * project. Explicit seeds (a project row's New, Linked content) do not pass through here.
 */
export function inheritedDraftSeed(
  projects: Pick<ProjectReader, 'get'>,
  source: { readonly session: { readonly runtime: ChatSessionRuntime } } | null | undefined,
): DraftSeed {
  const project = source ? projects.get(sessionProjectId(source.session.runtime)) : null;
  return project ? { projectId: project.id } : {};
}
