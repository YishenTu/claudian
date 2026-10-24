import {
  normalizeOpencodeToolInput,
  normalizeOpencodeToolName,
  normalizeOpencodeToolResultDetails,
} from '@/providers/opencode/normalization/opencodeToolNormalization';

describe('normalizeOpencodeToolInput', () => {
  it.each([{ name: 'probe-skill' }, { id: 'probe-skill' }])(
    'preserves native skill identity for the Skill renderer: %j',
    input => {
      expect(normalizeOpencodeToolInput('skill', input)).toEqual({ skill: 'probe-skill' });
    },
  );

  it('maps websearch payloads to the WebSearch renderer shape', () => {
    expect(normalizeOpencodeToolInput('websearch', {
      action: {
        queries: [
          'obsidian plugin API',
          'obsidian docs',
          'obsidian plugin API',
        ],
      },
    })).toEqual({
      actionType: 'search',
      query: 'obsidian plugin API',
      queries: [
        'obsidian plugin API',
        'obsidian docs',
      ],
    });
  });

  it('maps question payloads to the AskUserQuestion renderer shape', () => {
    expect(normalizeOpencodeToolInput('question', {
      questions: [{
        header: 'Tests',
        id: 'tests',
        multiple: true,
        options: [
          { description: 'Update the related tests', label: 'Yes' },
          { description: 'Skip test edits', label: 'No' },
        ],
        question: 'Update tests too?',
      }],
    })).toEqual({
      questions: [{
        header: 'Tests',
        id: 'tests',
        multiSelect: true,
        options: [
          { description: 'Update the related tests', label: 'Yes' },
          { description: 'Skip test edits', label: 'No' },
        ],
        question: 'Update tests too?',
      }],
    });
  });

  it('maps todowrite statuses into the TodoWrite renderer shape', () => {
    expect(normalizeOpencodeToolInput('todowrite', {
      todos: [
        { content: 'Ship feature', status: 'in_progress' },
        { content: 'Drop stale task', status: 'cancelled' },
      ],
    })).toEqual({
      todos: [
        { activeForm: 'Ship feature', content: 'Ship feature', status: 'in_progress' },
        { activeForm: 'Drop stale task', content: 'Drop stale task', status: 'completed' },
      ],
    });
  });
});

/** Live and history paths both pass the normalized input with the native output. */
function resolveDetails(rawName: string, rawInput: Record<string, unknown>, rawOutput: unknown) {
  return normalizeOpencodeToolResultDetails(rawName, normalizeOpencodeToolInput(rawName, rawInput), rawOutput);
}

const ANSWERED = 'User has answered your questions.';

describe('normalizeOpencodeToolResultDetails', () => {
  it.each([
    { rawName: 'bash', rawInput: { command: 'pwd' }, expectedInput: { command: 'pwd' }, expectedName: 'Bash' },
    { rawName: 'read', rawInput: { filePath: 'notes/today.md' }, expectedInput: { file_path: 'notes/today.md' }, expectedName: 'Read' },
    { rawName: 'webfetch', rawInput: { url: 'https://example.com/docs' }, expectedInput: { url: 'https://example.com/docs' }, expectedName: 'WebFetch' },
  ])('maps native $rawName to its shared renderer name and input', ({ rawName, rawInput, expectedInput, expectedName }) => {
    expect(normalizeOpencodeToolName(rawName)).toBe(expectedName);
    expect(normalizeOpencodeToolInput(rawName, rawInput)).toEqual(expectedInput);
  });

  it('presents read results as plain text', () => {
    expect(resolveDetails('read', { filePath: '/vault/notes/today.md' }, { output: 'read ok' }))
      .toEqual({ resultFormat: 'plain' });
  });

  it('attaches structured answers for question tool results', () => {
    expect(resolveDetails('question', {
      questions: [{
        header: 'Deploy',
        id: 'deploy',
        options: [
          { description: 'Ship the change', label: 'Yes' },
          { description: 'Hold the deploy', label: 'No' },
        ],
        question: 'Deploy now?',
      }],
    }, { metadata: { answers: [['Yes']] }, output: ANSWERED })).toEqual({
      resolvedAnswers: {
        deploy: 'Yes',
        'Deploy now?': 'Yes',
      },
    });
  });

  it('keeps own text and id __proto__ aliases for positional question answers', () => {
    const textDetails = resolveDetails('question', {
      questions: [{
        header: 'Color',
        id: 'color',
        options: [
          { description: 'Blue option', label: 'Blue' },
          { description: 'Red option', label: 'Red' },
        ],
        question: '__proto__',
      }],
    }, { metadata: { answers: [['Blue', 'Red']] }, output: ANSWERED }) as { resolvedAnswers: object };
    expect(Object.hasOwn(textDetails.resolvedAnswers, '__proto__')).toBe(true);
    expect(JSON.stringify(textDetails.resolvedAnswers)).toBe('{"__proto__":["Blue","Red"],"color":["Blue","Red"]}');

    const idDetails = resolveDetails('question', {
      questions: [{
        header: 'Extras',
        id: '__proto__',
        options: [{ description: 'Extra option', label: 'Extra' }],
        question: 'Extras',
      }],
    }, { metadata: { answers: [['Extra']] }, output: ANSWERED }) as { resolvedAnswers: object };
    expect(Object.hasOwn(idDetails.resolvedAnswers, '__proto__')).toBe(true);
    expect(JSON.stringify(idDetails.resolvedAnswers)).toBe('{"Extras":"Extra","__proto__":"Extra"}');
  });

  it('skips malformed, empty and missing positional answer entries', () => {
    expect(resolveDetails('question', {
      questions: [
        { header: 'First', id: 'first', options: [], question: 'First?' },
        { header: 'Second', id: 'second', options: [], question: 'Second?' },
        { header: 'Third', id: 'third', options: [], question: 'Third?' },
      ],
    }, { metadata: { answers: [[null], '  ', ['Blue']] }, output: ANSWERED })).toEqual({
      resolvedAnswers: {
        third: 'Blue',
        'Third?': 'Blue',
      },
    });
  });

  it('normalizes websearch calls to the shared WebSearch renderer contract', () => {
    expect(normalizeOpencodeToolName('websearch')).toBe('WebSearch');
    expect(normalizeOpencodeToolInput('websearch', {
      action: { pattern: 'tools', url: 'https://example.com/docs' },
    })).toEqual({
      actionType: 'find_in_page',
      pattern: 'tools',
      url: 'https://example.com/docs',
    });
  });
});

describe('normalizeOpencodeToolName', () => {
  it.each([
    ['constructor', 'constructor'],
    ['__proto__', '__proto__'],
    ['toString', 'toString'],
    [' Constructor ', 'Constructor'],
  ])('keeps unknown tool name %j as its trimmed literal string %j', (rawName, expected) => {
    expect(typeof normalizeOpencodeToolName(rawName)).toBe('string');
    expect(normalizeOpencodeToolName(rawName)).toBe(expected);
  });

  it.each([
    ['READ', 'Read'],
  ])('retains registered alias %s mapping to %s', (rawName, expected) => {
    expect(normalizeOpencodeToolName(rawName)).toBe(expected);
  });
});

describe('OpenCode v2 tools', () => {
  it('normalizes the native shell tool to Bash', () => {
    expect(normalizeOpencodeToolName('shell')).toBe('Bash');
  });

  it('maps native paths and subagent fields', () => {
    expect(normalizeOpencodeToolInput('read', { path: '/vault/note.md', offset: 2 }))
      .toEqual({ file_path: '/vault/note.md', offset: 2 });
    expect(normalizeOpencodeToolName('subagent')).toBe('Agent');
    expect(normalizeOpencodeToolInput('subagent', {
      agent: 'explore', prompt: 'Find tests', sessionID: 'ses_child', background: true,
    })).toEqual({
      subagent_type: 'explore', prompt: 'Find tests', task_id: 'ses_child', run_in_background: true,
    });
  });
});
