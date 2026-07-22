import {
  createOpencodeToolStreamAdapter,
  normalizeOpencodeToolInput,
  resolveOpencodeRawToolName,
} from '../../../../src/providers/opencode/normalization/opencodeToolNormalization';

describe('normalizeOpencodeToolInput', () => {
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

describe('createOpencodeToolStreamAdapter', () => {
  it('refines a generic kind fallback to unknown late titles without extra output-only uses', () => {
    const adapter = createOpencodeToolStreamAdapter();

    expect(adapter.normalizeToolCall({
      kind: 'other',
      rawInput: { command: 'pwd' },
      title: '',
      toolCallId: 'tool-future',
    }, [{
      id: 'tool-future',
      input: {},
      name: 'tool',
      type: 'tool_use',
    }])).toEqual([{
      id: 'tool-future',
      input: { command: 'pwd' },
      name: 'tool',
      type: 'tool_use',
    }]);

    expect(adapter.normalizeToolCallUpdate({
      title: 'future_tool',
      toolCallId: 'tool-future',
    }, [])).toEqual([{
      id: 'tool-future',
      input: { command: 'pwd' },
      name: 'future_tool',
      type: 'tool_use',
    }]);
    expect(adapter.normalizeToolCallUpdate({
      rawOutput: { output: 'done' },
      toolCallId: 'tool-future',
    }, [])).toEqual([]);
  });

  it.each([
    {
      displayTitle: 'Run terminal command',
      expectedInput: { command: 'pwd' },
      expectedName: 'Bash',
      kind: 'execute' as const,
      rawInput: { command: 'pwd' },
    },
    {
      displayTitle: 'notes/today.md',
      expectedInput: { file_path: 'notes/today.md' },
      expectedName: 'Read',
      kind: 'read' as const,
      rawInput: { filePath: 'notes/today.md' },
    },
    {
      displayTitle: 'Fetching documentation',
      expectedInput: { url: 'https://example.com/docs' },
      expectedName: 'WebFetch',
      kind: 'fetch' as const,
      rawInput: { url: 'https://example.com/docs' },
    },
  ])('keeps authoritative $kind normalization across a late display title', ({
    displayTitle,
    expectedInput,
    expectedName,
    kind,
    rawInput,
  }) => {
    const adapter = createOpencodeToolStreamAdapter();
    expect(adapter.normalizeToolCall({
      kind,
      rawInput,
      title: '',
      toolCallId: `tool-${kind}`,
    }, [{
      id: `tool-${kind}`,
      input: {},
      name: 'tool',
      type: 'tool_use',
    }])).toEqual([{
      id: `tool-${kind}`,
      input: expectedInput,
      name: expectedName,
      type: 'tool_use',
    }]);

    expect(adapter.normalizeToolCallUpdate({
      title: displayTitle,
      toolCallId: `tool-${kind}`,
    }, [])).toEqual([]);
  });

  it('keeps the original tool identity when completion updates replace title with a filepath', () => {
    const adapter = createOpencodeToolStreamAdapter();

    expect(adapter.normalizeToolCall({
      rawInput: {},
      title: 'read',
      toolCallId: 'tool-1',
    }, [{
      id: 'tool-1',
      input: {},
      name: 'read',
      type: 'tool_use',
    }])).toEqual([{
      id: 'tool-1',
      input: {},
      name: 'Read',
      type: 'tool_use',
    }]);

    expect(adapter.normalizeToolCallUpdate({
      kind: 'read',
      rawInput: {
        filePath: '/vault/notes/today.md',
      },
      status: 'completed',
      title: 'notes/today.md',
      toolCallId: 'tool-1',
    }, [{
      content: 'read ok',
      id: 'tool-1',
      isError: false,
      type: 'tool_result',
    }])).toEqual([
      {
        id: 'tool-1',
        input: { file_path: '/vault/notes/today.md' },
        name: 'Read',
        type: 'tool_use',
      },
      {
        content: 'read ok',
        id: 'tool-1',
        isError: false,
        type: 'tool_result',
      },
    ]);
  });

  it('attaches structured answers for question tool results', () => {
    const adapter = createOpencodeToolStreamAdapter();

    adapter.normalizeToolCall({
      rawInput: {
        questions: [{
          header: 'Deploy',
          id: 'deploy',
          options: [
            { description: 'Ship the change', label: 'Yes' },
            { description: 'Hold the deploy', label: 'No' },
          ],
          question: 'Deploy now?',
        }],
      },
      title: 'question',
      toolCallId: 'tool-2',
    }, [{
      id: 'tool-2',
      input: {},
      name: 'question',
      type: 'tool_use',
    }]);

    expect(adapter.normalizeToolCallUpdate({
      rawOutput: {
        metadata: {
          answers: [['Yes']],
        },
        output: 'User has answered your questions.',
      },
      status: 'completed',
      title: 'Asked 1 question',
      toolCallId: 'tool-2',
    }, [{
      content: 'User has answered your questions.',
      id: 'tool-2',
      isError: false,
      type: 'tool_result',
    }])).toEqual([{
      content: 'User has answered your questions.',
      id: 'tool-2',
      isError: false,
      toolUseResult: {
        answers: {
          deploy: 'Yes',
          'Deploy now?': 'Yes',
        },
      },
      type: 'tool_result',
    }]);
  });

  it('normalizes websearch tool calls to the shared WebSearch renderer contract', () => {
    const adapter = createOpencodeToolStreamAdapter();

    expect(adapter.normalizeToolCall({
      rawInput: {
        action: {
          pattern: 'tools',
          url: 'https://example.com/docs',
        },
      },
      title: 'websearch',
      toolCallId: 'tool-3',
    }, [{
      id: 'tool-3',
      input: {},
      name: 'websearch',
      type: 'tool_use',
    }])).toEqual([{
      id: 'tool-3',
      input: {
        actionType: 'find_in_page',
        pattern: 'tools',
        url: 'https://example.com/docs',
      },
      name: 'WebSearch',
      type: 'tool_use',
    }]);
  });
});

describe('resolveOpencodeRawToolName', () => {
  it('tracks fallback and multiple late-title updates explicitly', () => {
    const fallback = resolveOpencodeRawToolName(undefined, { kind: 'other' });
    expect(fallback).toEqual({ provenance: 'fallback', rawName: 'tool' });

    const firstTitle = resolveOpencodeRawToolName(fallback, { title: 'future_tool' });
    expect(firstTitle).toEqual({ provenance: 'title', rawName: 'future_tool' });
    expect(resolveOpencodeRawToolName(firstTitle, {})).toEqual(firstTitle);
    expect(resolveOpencodeRawToolName(firstTitle, { title: 'future_tool_v2' })).toEqual({
      provenance: 'title',
      rawName: 'future_tool_v2',
    });
  });

  it.each([
    ['execute', 'bash'],
    ['read', 'read'],
    ['fetch', 'webfetch'],
  ] as const)('marks the %s kind mapping authoritative', (kind, rawName) => {
    const knownKind = resolveOpencodeRawToolName(undefined, { kind });
    expect(knownKind).toEqual({ provenance: 'mapped-kind', rawName });
    expect(resolveOpencodeRawToolName(knownKind, { title: 'Human presentation label' }))
      .toEqual(knownKind);
    expect(resolveOpencodeRawToolName(knownKind, { title: 'question' })).toEqual({
      provenance: 'title',
      rawName: 'question',
    });
  });

  it('keeps authoritative known names when later titles are presentation labels', () => {
    const known = resolveOpencodeRawToolName(undefined, { title: 'read' });
    expect(resolveOpencodeRawToolName(known, { title: 'notes/today.md' })).toEqual(known);

    expect(resolveOpencodeRawToolName(known, { title: 'bash' })).toEqual({
      provenance: 'title',
      rawName: 'bash',
    });
  });
});
