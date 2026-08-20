import {
  buildContinuationCapsule,
  latestChangedPaths,
  selectRelevantExternalRoots,
} from '@/features/chat/tabs/ContinuationCapsule';

describe('ContinuationCapsule', () => {
  it('keeps latest narrative and safe changed paths within a bounded deterministic capsule', () => {
    const capsule = buildContinuationCapsule({
      messages: [
        { id: 'u1', role: 'user', content: 'Initial goal', timestamp: 1 },
        { id: 'a1', role: 'assistant', content: 'Old progress', timestamp: 2 },
        { id: 'u2', role: 'user', content: 'Finish the focused task', timestamp: 3, linkedContentPath: 'notes/brief.md' },
        { id: 'a2', role: 'assistant', content: 'Latest progress', timestamp: 4, toolCalls: [{ id: 't', name: 'Write', input: { secret: 'never copy' }, result: 'never copy', status: 'completed', diffData: { filePath: 'src/changed.ts', diffLines: [], stats: { added: 1, removed: 0 } } }] },
      ],
      todos: [{ content: 'Verify change', status: 'in_progress', activeForm: 'Verifying' }],
      maxChars: 500,
    });

    expect(capsule).toContain('Finish the focused task');
    expect(capsule).toContain('Latest progress');
    expect(capsule).toContain('src/changed.ts');
    expect(capsule).toContain('notes/brief.md');
    expect(capsule).not.toContain('never copy');
    expect(capsule.length).toBeLessThanOrEqual(500);
  });

  it('treats any nonempty non-approval user text as substantive', () => {
    const capsule = buildContinuationCapsule({ messages: [
      { id: 'u1', role: 'user', content: 'Fix bug', timestamp: 1 },
      { id: 'a', role: 'assistant', content: 'Plan is ready.', timestamp: 2 },
      { id: 'u2', role: 'user', content: 'a', timestamp: 3 },
    ] });

    expect(capsule).toContain('## Current goal\nFix bug');
    expect(capsule).toContain('## Latest instruction\na');
  });

  it('skips empty assistant entries and uses nonempty canonical narrative content', () => {
    const capsule = buildContinuationCapsule({ messages: [
      { id: 'u', role: 'user', content: 'Fix it', timestamp: 1 },
      { id: 'a1', role: 'assistant', content: 'Rendered fallback', timestamp: 2, executionInput: { schemaVersion: 1, canonicalText: 'Canonical state' } },
      { id: 'a2', role: 'assistant', content: '   ', timestamp: 3 },
    ] });

    expect(capsule).toContain('## Current state\nCanonical state');
    expect(capsule).not.toContain('Rendered fallback');
  });

  it('collects changed paths recursively and terminates on tool-call cycles', () => {
    const parent: any = { id: 'parent', name: 'Agent', input: {}, status: 'completed' };
    const nested: any = {
      id: 'nested',
      name: 'Edit',
      input: {},
      status: 'completed',
      diffData: { filePath: 'src/nested.ts', diffLines: [], stats: { added: 1, removed: 0 } },
    };
    parent.subagent = { id: 'sub', description: '', isExpanded: false, status: 'completed', toolCalls: [nested] };
    nested.subagent = { id: 'cycle', description: '', isExpanded: false, status: 'completed', toolCalls: [parent] };

    expect(latestChangedPaths([
      { id: 'a', role: 'assistant', content: 'Done', timestamp: 1, toolCalls: [parent] },
    ])).toEqual(['src/nested.ts']);
  });

  it('selects roots from structured absolute evidence, including a Bash command, without serializing input', () => {
    const cyclicInput: any = { command: 'cd "/Repo With Space" && npm test', secret: 'do-not-serialize' };
    cyclicInput.self = cyclicInput;
    const messages: any = [{
      id: 'a', role: 'assistant', content: 'Done', timestamp: 1,
      toolCalls: [{
        id: 'agent', name: 'Agent', input: {}, status: 'completed',
        subagent: {
          id: 'sub', description: '', isExpanded: false, status: 'completed',
          toolCalls: [{
            id: 'bash', name: 'Bash', input: cyclicInput, status: 'completed',
            diffData: { filePath: 'src/file.ts', diffLines: [], stats: { added: 1, removed: 0 } },
          }],
        },
      }],
    }];

    expect(selectRelevantExternalRoots(['/Repo With Space/', '/other'], messages)).toEqual(['/Repo With Space/']);
    expect(buildContinuationCapsule({ messages })).not.toContain('do-not-serialize');
  });

  it('keeps POSIX case sensitivity and rejects sibling-prefix and relative-only guesses', () => {
    const absoluteLowercase: any = [{ id: 'a', role: 'assistant', content: '', timestamp: 1, toolCalls: [{ id: 'x', name: 'Write', input: { path: '/repo/file.ts' }, status: 'completed' }] }];
    const sibling: any = [{ id: 'a', role: 'assistant', content: '', timestamp: 1, toolCalls: [{ id: 'x', name: 'Write', input: { path: '/repo-other/file.ts' }, status: 'completed' }] }];
    const relativeOnly: any = [{ id: 'a', role: 'assistant', content: '', timestamp: 1, toolCalls: [{ id: 'x', name: 'Write', input: {}, status: 'completed', diffData: { filePath: 'src/file.ts', diffLines: [], stats: { added: 1, removed: 0 } } }] }];

    expect(selectRelevantExternalRoots(['/Repo'], absoluteLowercase)).toEqual([]);
    expect(selectRelevantExternalRoots(['/repo'], sibling)).toEqual([]);
    expect(selectRelevantExternalRoots(['/repo'], relativeOnly)).toEqual([]);
  });

  it('matches Windows drive paths case-insensitively across separators and trailing slashes', () => {
    const messages: any = [{
      id: 'a', role: 'assistant', content: '', timestamp: 1,
      toolCalls: [{ id: 'x', name: 'Bash', input: { command: 'git -C C:\\Work\\Repo status' }, status: 'completed' }],
    }];

    expect(selectRelevantExternalRoots(['c:/work/repo/', 'C:/work/repository'], messages))
      .toEqual(['c:/work/repo/']);
  });
});
