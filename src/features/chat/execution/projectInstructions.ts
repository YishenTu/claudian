import { renderProjectMemberInstructions } from '@/core/prompt/projectPrompt';
import type { Conversation, ProjectReader } from '@/core/types';

export interface ResolvedProjectInstructions {
  readonly projectId: string;
  readonly instructions: string;
}

/**
 * Member instructions for the conversation's live project; otherwise none. Main turns resolve them each
 * turn; a side chat renders its parent's once at start, since its ephemeral session cannot change prompt.
 */
export function resolveSessionInstructions(
  projects: Pick<ProjectReader, 'get'>,
  conversation: Pick<Conversation, 'projectId'> | null | undefined,
): ResolvedProjectInstructions | undefined {
  const project = projects.get(conversation?.projectId);
  return project ? { projectId: project.id, instructions: renderProjectMemberInstructions(project) } : undefined;
}
