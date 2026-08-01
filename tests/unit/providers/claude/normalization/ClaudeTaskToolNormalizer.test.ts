import { TOOL_TODO_WRITE } from '@/core/tools/toolNames';
import { ClaudeTaskToolNormalizer } from '@/providers/claude/normalization/ClaudeTaskToolNormalizer';

function todosFrom(result: ReturnType<ClaudeTaskToolNormalizer['normalizeToolUse']>) {
  return result?.input.todos;
}

describe('ClaudeTaskToolNormalizer', () => {
  it('reduces create, update, and delete mutations into TodoWrite snapshots', () => {
    const normalizer = new ClaudeTaskToolNormalizer();

    const firstCreate = normalizer.normalizeToolUse('create-1', 'TaskCreate', {
      subject: 'Inspect issue',
      description: 'Read the issue and comments.',
      activeForm: 'Inspecting issue',
    });
    expect(firstCreate).toMatchObject({
      name: TOOL_TODO_WRITE,
      providerPayload: {
        rawName: 'TaskCreate',
      },
    });
    expect(todosFrom(firstCreate)).toEqual([{
      content: 'Inspect issue',
      activeForm: 'Inspecting issue',
      status: 'pending',
    }]);

    normalizer.normalizeToolResult('create-1', {
      task: { id: '1', subject: 'Inspect issue' },
    });
    normalizer.normalizeToolUse('create-2', 'TaskCreate', {
      subject: 'Implement fix',
      description: 'Normalize Claude task tools.',
    });
    normalizer.normalizeToolResult('create-2', {
      task: { id: '2', subject: 'Implement fix' },
    });

    const inProgress = normalizer.normalizeToolUse('update-1', 'TaskUpdate', {
      taskId: '1',
      status: 'in_progress',
    });
    expect(todosFrom(inProgress)).toEqual([
      {
        id: '1',
        content: 'Inspect issue',
        activeForm: 'Inspecting issue',
        status: 'in_progress',
      },
      {
        id: '2',
        content: 'Implement fix',
        activeForm: 'Implement fix',
        status: 'pending',
      },
    ]);

    normalizer.normalizeToolResult('update-1', {
      success: true,
      taskId: '1',
      updatedFields: ['status'],
      statusChange: { from: 'pending', to: 'in_progress' },
    });
    const deleted = normalizer.normalizeToolUse('delete-2', 'TaskUpdate', {
      taskId: '2',
      status: 'deleted',
    });
    expect(todosFrom(deleted)).toEqual([{
      id: '1',
      content: 'Inspect issue',
      activeForm: 'Inspecting issue',
      status: 'in_progress',
    }]);
  });

  it('does not duplicate a TaskCreate when streamed input is refined', () => {
    const normalizer = new ClaudeTaskToolNormalizer();

    expect(todosFrom(normalizer.normalizeToolUse('create-1', 'TaskCreate', {}))).toEqual([]);
    expect(todosFrom(normalizer.normalizeToolUse('create-1', 'TaskCreate', {
      subject: 'Run tests',
    }))).toEqual([{
      content: 'Run tests',
      activeForm: 'Run tests',
      status: 'pending',
    }]);
    expect(todosFrom(normalizer.normalizeToolUse('create-1', 'TaskCreate', {
      subject: 'Run tests',
      activeForm: 'Running tests',
    }))).toEqual([{
      content: 'Run tests',
      activeForm: 'Running tests',
      status: 'pending',
    }]);

    const boundFromText = normalizer.normalizeToolResult('create-1', undefined, {
      fallbackContent: 'Task #10 created successfully: Run tests',
    });
    expect(todosFrom(boundFromText)).toEqual([{
      id: '10',
      content: 'Run tests',
      activeForm: 'Running tests',
      status: 'pending',
    }]);
  });

  it('rolls back optimistic mutations when the native tool fails', () => {
    const normalizer = new ClaudeTaskToolNormalizer();
    normalizer.normalizeToolUse('create-1', 'TaskCreate', { subject: 'Run tests' });
    normalizer.normalizeToolResult('create-1', { task: { id: '1', subject: 'Run tests' } });

    normalizer.normalizeToolUse('update-1', 'TaskUpdate', {
      taskId: '1',
      status: 'completed',
    });
    const rolledBackUpdate = normalizer.normalizeToolResult('update-1', {
      success: false,
      taskId: '1',
      updatedFields: [],
      error: 'Task update failed',
    });
    expect(todosFrom(rolledBackUpdate)).toEqual([{
      id: '1',
      content: 'Run tests',
      activeForm: 'Run tests',
      status: 'pending',
    }]);

    normalizer.normalizeToolUse('create-2', 'TaskCreate', { subject: 'Ship fix' });
    const rolledBackCreate = normalizer.normalizeToolResult(
      'create-2',
      'Task creation failed',
      { isError: true },
    );
    expect(todosFrom(rolledBackCreate)).toEqual([{
      id: '1',
      content: 'Run tests',
      activeForm: 'Run tests',
      status: 'pending',
    }]);
  });

  it('uses TaskList as an authoritative snapshot and TaskGet as a targeted refresh', () => {
    const normalizer = new ClaudeTaskToolNormalizer();
    normalizer.normalizeToolUse('create-1', 'TaskCreate', {
      subject: 'Old title',
      activeForm: 'Doing old work',
    });
    normalizer.normalizeToolResult('create-1', { task: { id: '1', subject: 'Old title' } });

    normalizer.normalizeToolUse('list-1', 'TaskList', {});
    const listed = normalizer.normalizeToolResult('list-1', {
      tasks: [{
        id: '1',
        subject: 'Listed title',
        status: 'in_progress',
        blockedBy: [],
      }],
    });
    expect(todosFrom(listed)).toEqual([{
      id: '1',
      content: 'Listed title',
      activeForm: 'Doing old work',
      status: 'in_progress',
    }]);

    normalizer.normalizeToolUse('get-1', 'TaskGet', { taskId: '1' });
    const refreshed = normalizer.normalizeToolResult('get-1', {
      task: {
        id: '1',
        subject: 'Refreshed title',
        description: 'Latest task details.',
        status: 'completed',
        blocks: [],
        blockedBy: [],
      },
    });
    expect(todosFrom(refreshed)).toEqual([{
      id: '1',
      content: 'Refreshed title',
      activeForm: 'Doing old work',
      status: 'completed',
    }]);

    normalizer.normalizeToolUse('list-2', 'TaskList', {});
    expect(todosFrom(normalizer.normalizeToolResult('list-2', { tasks: [] }))).toEqual([]);
  });

  it('keeps state instance-local and clears it on reset', () => {
    const first = new ClaudeTaskToolNormalizer();
    const second = new ClaudeTaskToolNormalizer();

    first.normalizeToolUse('create-1', 'TaskCreate', { subject: 'First window' });
    expect(todosFrom(second.normalizeToolUse('list-2', 'TaskList', {}))).toEqual([]);

    first.reset();
    expect(todosFrom(first.normalizeToolUse('list-1', 'TaskList', {}))).toEqual([]);
  });

  it('ignores unrelated Claude tools', () => {
    const normalizer = new ClaudeTaskToolNormalizer();
    expect(normalizer.normalizeToolUse('read-1', 'Read', { file_path: 'a.md' })).toBeNull();
    expect(normalizer.normalizeToolResult('read-1', 'contents')).toBeNull();
  });
});
