/**
 * Jest mock for @openai/codex-sdk.
 *
 * The unit tests need a configurable SDK surface because Jest maps every
 * `@openai/codex-sdk` import to this file. Export the mock fns so tests can
 * control thread creation and streamed events explicitly.
 */

export const mockRunStreamed = jest.fn();
export const mockRun = jest.fn();
export const mockStartThread = jest.fn();
export const mockResumeThread = jest.fn();
export const mockCodexConstructor = jest.fn();

function defaultStreamedResult() {
  return {
    events: (async function* () {
      yield { type: 'thread.started', thread_id: 'mock-thread-id' };
      yield { type: 'turn.started' };
      yield { type: 'turn.completed', usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 } };
    })(),
  };
}

export function resetCodexSdkMocks(): void {
  mockCodexConstructor.mockReset();
  mockRunStreamed.mockReset();
  mockRun.mockReset();
  mockStartThread.mockReset();
  mockResumeThread.mockReset();

  mockRunStreamed.mockResolvedValue(defaultStreamedResult());
  mockRun.mockResolvedValue({
    items: [],
    finalResponse: '',
    usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
  });
  mockStartThread.mockImplementation((_options?: any) => new Thread());
  mockResumeThread.mockImplementation((_id: string, _options?: any) => new Thread());
}

export class Codex {
  constructor(options?: any) {
    mockCodexConstructor(options);
  }

  startThread(options?: any) {
    return mockStartThread(options);
  }

  resumeThread(id: string, options?: any) {
    return mockResumeThread(id, options);
  }
}

export class Thread {
  private _id: string | null = 'mock-thread-id';

  get id() {
    return this._id;
  }

  async runStreamed(input: any, turnOptions?: any) {
    return mockRunStreamed(input, turnOptions);
  }

  async run(input: any, turnOptions?: any) {
    return mockRun(input, turnOptions);
  }
}

resetCodexSdkMocks();

// Type stubs (values don't matter for type-only imports)
export type ThreadEvent = any;
export type ThreadOptions = any;
export type ModelReasoningEffort = string;
export type ThreadItem = any;
export type Usage = any;
export type Input = any;
export type UserInput = any;
export type TurnOptions = any;
export type StreamedTurn = any;
export type Turn = any;
export type CodexOptions = any;
export type SandboxMode = string;
export type ApprovalMode = string;
export type WebSearchMode = string;
