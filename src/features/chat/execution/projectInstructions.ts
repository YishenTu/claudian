import { renderProjectMemberInstructions, renderProjectSideChatInstructions } from '@/core/prompt/projectPrompt';
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

/** Member instructions for the conversation's live project, resolved for each turn; otherwise none. */
export function resolveSessionInstructions(
  projects: ProjectLookup,
  conversation: Pick<Conversation, 'projectId'> | null | undefined,
): string | undefined {
  const project = resolveLiveProject(projects, conversation?.projectId);
  return project ? renderProjectMemberInstructions(project, project.docPath) : undefined;
}

/** Side-chat instructions for the parent's live project, rendered once when the side chat starts. */
export function resolveSideChatInstructions(projects: ProjectLookup, projectId: string | undefined): string | undefined {
  const project = resolveLiveProject(projects, projectId);
  return project ? renderProjectSideChatInstructions(project, project.docPath) : undefined;
}
