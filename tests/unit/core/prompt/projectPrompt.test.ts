import { renderProjectMemberInstructions, renderProjectSideChatInstructions } from '@/core/prompt/projectPrompt';

const DOC_PATH = '.claudian/projects/alpha-beta-1a2b3c4d.md';

// Expected text is the v2 project prompt with name, instructions and doc path substituted.
const MEMBER_TEXT = [
  '## Project',
  '',
  'This session is a member of the Claudian project **Alpha & Beta**. A project is a group of sessions working toward one goal.',
  '',
  '### Project Instructions',
  '',
  'Ship the importer.',
  '',
  'Keep the old format readable.',
  '',
  '### Project Document',
  '',
  '`.claudian/projects/alpha-beta-1a2b3c4d.md` (Vault-relative) is the project\'s shared document. Read it first and use it to guide your work and to assess whether the work meets the intended outcome. Treat the user\'s latest instructions as authoritative.',
  '',
  'Keep it current as the user clarifies their intent: the project\'s goal, expected behavior, scope, constraints, acceptance criteria, and unresolved questions. Keep it concise. Distinguish explicit requirements from assumptions.',
  '',
  'Record decisions with their reasons; mark superseded ones rather than deleting them. Keep a State section on progress toward the goal: what is done and verified, what remains, and any blockers. Keep a Dead ends section listing failed approaches and why. Update State at milestones and before stopping.',
  '',
  'Other sessions in the project read and edit this document too. Re-read it right before editing, and make targeted edits to the part you are changing rather than rewriting the file.',
  '',
  'This document is your working memory. Do not mention, cite, or link it in replies to the user unless they ask about it.',
  '',
  '### Working With Other Sessions',
  '',
  '- When asked to find or check on other sessions in this project, use `claudian_list_destinations` with `project: true`, and `claudian_read_session` to read one.',
  '- When asked to hand off, delegate, or coordinate work, use `claudian_send_message`. Messages must be self-contained; the recipient cannot see this conversation.',
  '- Sessions you start with `claudian_send_message` join this project.',
  ].join('\n');

const SIDE_CHAT_TEXT = [
  '## Project',
  '',
  'This side chat belongs to a session in the Claudian project **Alpha & Beta**. It is a temporary exploration, not a project member.',
  '',
  '### Project Instructions',
  '',
  'None.',
  '',
  '### Project Document',
  '',
  '`.claudian/projects/alpha-beta-1a2b3c4d.md` (Vault-relative) is the project\'s shared memory. Read it when the request needs project context. Do not edit it or claim work in it unless the user asks. Do not mention, cite, or link it in replies to the user unless they ask about it.',
  ].join('\n');

describe('project prompt renderers', () => {
  it('renders the member variant', () => {
    expect(renderProjectMemberInstructions(
      { name: 'Alpha & Beta', instructions: 'Ship the importer.\n\nKeep the old format readable.' },
      DOC_PATH,
    )).toBe(MEMBER_TEXT);
  });

  it('renders the side-chat variant with "None." for blank instructions', () => {
    expect(renderProjectSideChatInstructions({ name: 'Alpha & Beta', instructions: '  \n ' }, DOC_PATH)).toBe(SIDE_CHAT_TEXT);
  });

  it.each([
    ['member', renderProjectMemberInstructions],
    ['side-chat', renderProjectSideChatInstructions],
  ])('substitutes "None." for empty instructions and trims surrounding whitespace in the %s variant', (_label, render) => {
    expect(render({ name: 'Alpha', instructions: '' }, DOC_PATH)).toContain('### Project Instructions\n\nNone.\n\n### Project Document');
    expect(render({ name: 'Alpha', instructions: '\n  Do X.  \n' }, DOC_PATH)).toContain('### Project Instructions\n\nDo X.\n\n### Project Document');
  });
});
