import { renderProjectMemberInstructions } from '@/core/prompt/projectPrompt';

const MEMORY_PATH = '.claudian/projects/alpha-beta/MEMORY.md';

// Expected text is the v2 project prompt with name, instructions and memory path substituted.
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
  '### Project Memory',
  '',
  '`.claudian/projects/alpha-beta/MEMORY.md` (Vault-relative) is the project\'s shared memory file. Read it first and use it to guide your work and to assess whether the work meets the intended outcome. Treat the user\'s latest instructions as authoritative.',
  '',
  'Keep it current as the user clarifies their intent: the project\'s goal, expected behavior, scope, constraints, acceptance criteria, and unresolved questions. Keep it concise. Distinguish explicit requirements from assumptions.',
  '',
  'Record decisions with their reasons; mark superseded ones rather than deleting them. Keep a State section on progress toward the goal: what is done and verified, what remains, and any blockers. Keep a Dead ends section listing failed approaches and why. Update it when something durable changes: a requirement, a decision, a milestone, a dead end, or a handoff. Leave it alone on turns that change none of these.',
  '',
  'Other sessions in the project read and edit this file too. Re-read it right before editing, and make targeted edits to the part you are changing rather than rewriting the file.',
  '',
  'This file is your working memory. Do not mention, cite, or link it in replies to the user unless they ask about it.',
  '',
  '### Working With Other Sessions',
  '',
  '- When asked to find or check on other sessions in this project, use `claudian_list_destinations` with `project: true`, and `claudian_read_session` to read one.',
  '- When asked to hand off, delegate, or coordinate work, use `claudian_send_message`. Messages must be self-contained; the recipient cannot see this conversation.',
  '- Sessions you start with `claudian_send_message` join this project.',
  ].join('\n');

describe('project prompt renderers', () => {
  it('renders the member variant', () => {
    expect(renderProjectMemberInstructions(
      { name: 'Alpha & Beta', instructions: 'Ship the importer.\n\nKeep the old format readable.', memoryPath: MEMORY_PATH },
    )).toBe(MEMBER_TEXT);
  });

  it('substitutes "None." for empty instructions and trims surrounding whitespace', () => {
    const render = renderProjectMemberInstructions;
    expect(render({ name: 'Alpha', instructions: '', memoryPath: MEMORY_PATH })).toContain('### Project Instructions\n\nNone.\n\n### Project Memory');
    expect(render({ name: 'Alpha', instructions: '\n  Do X.  \n', memoryPath: MEMORY_PATH })).toContain('### Project Instructions\n\nDo X.\n\n### Project Memory');
  });
});
