import type { ProjectRecord } from '@/core/types/project';

type ProjectPromptRecord = Pick<ProjectRecord, 'name' | 'instructions'>;

function formatInstructions(instructions: string): string {
  return instructions.trim() || 'None.';
}

/** Session instructions for a project member; appended after Custom Instructions. */
export function renderProjectMemberInstructions(record: ProjectPromptRecord, docPath: string): string {
  return `## Project

This session is a member of the Claudian project **${record.name}**. A project is a group of sessions working toward one goal.

### Project Instructions

${formatInstructions(record.instructions)}

### Project Document

\`${docPath}\` (Vault-relative) is the project's shared document. Read it first and use it to guide your work and to assess whether the work meets the intended outcome. Treat the user's latest instructions as authoritative.

Keep it current as the user clarifies their intent: the project's goal, expected behavior, scope, constraints, acceptance criteria, and unresolved questions. Keep it concise. Distinguish explicit requirements from assumptions.

Record decisions with their reasons; mark superseded ones rather than deleting them. Keep a State section on progress toward the goal: what is done and verified, what remains, and any blockers. Keep a Dead ends section listing failed approaches and why. Update State at milestones and before stopping.

Other sessions in the project read and edit this document too. Re-read it right before editing, and make targeted edits to the part you are changing rather than rewriting the file.

This document is your working memory. Do not mention, cite, or link it in replies to the user unless they ask about it.

### Working With Other Sessions

- When asked to find or check on other sessions in this project, use \`claudian_list_destinations\` with \`project: true\`, and \`claudian_read_session\` to read one.
- When asked to hand off, delegate, or coordinate work, use \`claudian_send_message\`. Messages must be self-contained; the recipient cannot see this conversation.
- Sessions you start with \`claudian_send_message\` join this project.`;
}

/** Session instructions for a side chat whose parent is a project member; frozen at side-chat start. */
export function renderProjectSideChatInstructions(record: ProjectPromptRecord, docPath: string): string {
  return `## Project

This side chat belongs to a session in the Claudian project **${record.name}**. It is a temporary exploration, not a project member.

### Project Instructions

${formatInstructions(record.instructions)}

### Project Document

\`${docPath}\` (Vault-relative) is the project's shared memory. Read it when the request needs project context. Do not edit it or claim work in it unless the user asks. Do not mention, cite, or link it in replies to the user unless they ask about it.`;
}
