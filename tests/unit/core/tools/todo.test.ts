import { extractLastTodosFromMessages, parseTodoInput } from '@/core/tools/todo';
import { TOOL_TODO_WRITE } from '@/core/tools/toolNames';

describe('parseTodoInput', () => {
  it('should parse valid todo items', () => {
    const input = {
      todos: [
        { content: 'Run tests', status: 'pending', activeForm: 'Running tests' },
        { content: 'Fix bug', status: 'in_progress', activeForm: 'Fixing bug' },
        { content: 'Deploy', status: 'completed', activeForm: 'Deploying' },
      ],
    };

    const result = parseTodoInput(input);

    expect(result).toHaveLength(3);
    expect(result![0]).toEqual({ content: 'Run tests', status: 'pending', activeForm: 'Running tests' });
    expect(result![1].status).toBe('in_progress');
    expect(result![2].status).toBe('completed');
  });

  it('should return null when todos key is missing', () => {
    expect(parseTodoInput({})).toBeNull();
  });

  it('should return null when todos is not an array', () => {
    expect(parseTodoInput({ todos: 'not an array' })).toBeNull();
    expect(parseTodoInput({ todos: 42 })).toBeNull();
    expect(parseTodoInput({ todos: null })).toBeNull();
  });

  it('should filter out invalid items', () => {
    const input = {
      todos: [
        { content: 'Valid', status: 'pending', activeForm: 'Working' },
        { content: '', status: 'pending', activeForm: 'Working' }, // empty content
        { content: 'No status', activeForm: 'Working' }, // missing status
        { content: 'Bad status', status: 'unknown', activeForm: 'Working' }, // invalid status
        null,
        42,
        'string',
      ],
    };

    const result = parseTodoInput(input);

    expect(result).toHaveLength(1);
    expect(result![0].content).toBe('Valid');
  });

  it('should return null when all items are invalid', () => {
    const input = {
      todos: [
        { content: '', status: 'pending', activeForm: 'Working' },
        null,
        { status: 'pending' }, // missing content and activeForm
      ],
    };

    expect(parseTodoInput(input)).toBeNull();
  });

  it('should return null for empty todos array', () => {
    expect(parseTodoInput({ todos: [] })).toBeNull();
  });

  it('should reject items with missing activeForm', () => {
    const input = {
      todos: [
        { content: 'Task', status: 'pending' }, // no activeForm
      ],
    };

    expect(parseTodoInput(input)).toBeNull();
  });

  it('should reject items with empty activeForm', () => {
    const input = {
      todos: [
        { content: 'Task', status: 'pending', activeForm: '' },
      ],
    };

    expect(parseTodoInput(input)).toBeNull();
  });

  it('should reject non-object items', () => {
    const input = {
      todos: [undefined, false, 0],
    };

    expect(parseTodoInput(input)).toBeNull();
  });
});

describe('extractLastTodosFromMessages', () => {
  it('should extract todos from the last TodoWrite tool call', () => {
    const messages = [
      {
        role: 'user',
        content: 'Do something',
      },
      {
        role: 'assistant',
        toolCalls: [
          {
            name: TOOL_TODO_WRITE,
            input: {
              todos: [
                { content: 'First', status: 'completed' as const, activeForm: 'First-ing' },
              ],
            },
          },
        ],
      },
      {
        role: 'assistant',
        toolCalls: [
          {
            name: TOOL_TODO_WRITE,
            input: {
              todos: [
                { content: 'Second', status: 'pending' as const, activeForm: 'Second-ing' },
              ],
            },
          },
        ],
      },
    ];

    const result = extractLastTodosFromMessages(messages);

    expect(result).toHaveLength(1);
    expect(result![0].content).toBe('Second');
  });

  it('should return null when no messages exist', () => {
    expect(extractLastTodosFromMessages([])).toBeNull();
  });

  it('should return null when no assistant messages have tool calls', () => {
    const messages = [
      { role: 'user' },
      { role: 'assistant' },
    ];

    expect(extractLastTodosFromMessages(messages)).toBeNull();
  });

  it('should return null when no TodoWrite tool calls exist', () => {
    const messages = [
      {
        role: 'assistant',
        toolCalls: [
          { name: 'Read', input: { file_path: '/test.txt' } },
        ],
      },
    ];

    expect(extractLastTodosFromMessages(messages)).toBeNull();
  });

  it('should skip user messages', () => {
    const messages = [
      {
        role: 'user',
        toolCalls: [
          {
            name: TOOL_TODO_WRITE,
            input: {
              todos: [{ content: 'Should not find', status: 'pending', activeForm: 'Nope' }],
            },
          },
        ],
      },
    ];

    expect(extractLastTodosFromMessages(messages)).toBeNull();
  });

  it('should pick the last TodoWrite within a message with multiple tool calls', () => {
    const messages = [
      {
        role: 'assistant',
        toolCalls: [
          {
            name: TOOL_TODO_WRITE,
            input: {
              todos: [{ content: 'Earlier', status: 'pending' as const, activeForm: 'Earlier-ing' }],
            },
          },
          {
            name: 'Read',
            input: { file_path: '/test.txt' },
          },
          {
            name: TOOL_TODO_WRITE,
            input: {
              todos: [{ content: 'Later', status: 'in_progress' as const, activeForm: 'Later-ing' }],
            },
          },
        ],
      },
    ];

    const result = extractLastTodosFromMessages(messages);

    expect(result).toHaveLength(1);
    expect(result![0].content).toBe('Later');
  });

  it('should return null when TodoWrite has invalid input', () => {
    const messages = [
      {
        role: 'assistant',
        toolCalls: [
          {
            name: TOOL_TODO_WRITE,
            input: { todos: 'not-an-array' },
          },
        ],
      },
    ];

    expect(extractLastTodosFromMessages(messages)).toBeNull();
  });
});
