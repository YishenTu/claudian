import { renderProjectMemberInstructions } from '@/core/prompt/projectPrompt';
import type { Conversation, ProjectReader, ProjectRecord } from '@/core/types';

type ProjectLookup = Pick<ProjectReader, 'get'>;

/** The live project a raw id names; a missing or deleted project is no project. */
export function resolveLiveProject(projects: ProjectLookup, projectId: string | undefined): ProjectRecord | null {
  return projectId ? projects.get(projectId) : null;
}

/** The project id a new conversation may copy: only one that still resolves to a live project. */
export function resolveLiveProjectId(projects: ProjectLookup, projectId: string | undefined): string | undefined {
  return resolveLiveProject(projects, projectId)?.id;
}

/**
 * Member instructions for the conversation's live project; otherwise none. Main turns resolve them each
 * turn; a side chat renders its parent's once at start, since its ephemeral session cannot change prompt.
 */
export function resolveSessionInstructions(
  projects: ProjectLookup,
  conversation: Pick<Conversation, 'projectId'> | null | undefined,
): string | undefined {
  const project = resolveLiveProject(projects, conversation?.projectId);
  return project ? renderProjectMemberInstructions(project, project.memoryPath) : undefined;
}
