import { OctoAgentInlineEditService } from '@/providers/octo-agent/auxiliary/OctoAgentInlineEditService';
import { runOctoAgentAuxQuery } from '@/providers/octo-agent/runtime/OctoAgentAuxQueryRunner';

jest.mock('@/providers/octo-agent/runtime/OctoAgentAuxQueryRunner');
const mockedRunQuery = jest.mocked(runOctoAgentAuxQuery);

describe('OctoAgentInlineEditService', () => {
  let service: OctoAgentInlineEditService;
  const mockPlugin = {
    settings: {
      providerConfigs: {
        'octo-agent': {
          accessKey: '',
          autoStartServer: false,
          cliPath: 'octo',
          enabled: true,
          environmentVariables: '',
          host: '127.0.0.1',
          port: 8088,
        },
      },
    },
  } as unknown as { settings: Record<string, unknown> };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OctoAgentInlineEditService(mockPlugin as any);
  });

  it('returns parsed replacement from a selection request', async () => {
    mockedRunQuery.mockResolvedValue({
      sessionId: 'session-1',
      text: '<replacement>fixed text</replacement>',
    });

    const result = await service.editText({
      instruction: 'fix grammar',
      mode: 'selection',
      notePath: 'notes/file.md',
      selectedText: 'some text',
    });

    expect(result.success).toBe(true);
    expect(result.editedText).toBe('fixed text');
    expect(mockedRunQuery).toHaveBeenCalledTimes(1);
  });

  it('returns clarification when no tags are present', async () => {
    mockedRunQuery.mockResolvedValue({
      sessionId: 'session-2',
      text: 'Could you clarify?',
    });

    const result = await service.editText({
      instruction: 'improve',
      mode: 'cursor',
      notePath: 'notes/file.md',
      cursorContext: {
        afterCursor: 'after',
        beforeCursor: 'before',
        column: 0,
        isInbetween: false,
        line: 0,
      },
    });

    expect(result.success).toBe(true);
    expect(result.clarification).toBe('Could you clarify?');
  });

  it('returns an error when the query fails', async () => {
    mockedRunQuery.mockRejectedValue(new Error('connection refused'));

    const result = await service.editText({
      instruction: 'fix',
      mode: 'selection',
      notePath: 'notes/file.md',
      selectedText: 'text',
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('connection refused');
  });

  it('continues a conversation using the same session', async () => {
    mockedRunQuery.mockResolvedValue({
      sessionId: 'session-3',
      text: '<replacement>A</replacement>',
    });

    await service.editText({
      instruction: 'capitalize',
      mode: 'selection',
      notePath: 'notes/file.md',
      selectedText: 'a',
    });

    mockedRunQuery.mockResolvedValue({
      sessionId: 'session-3',
      text: '<replacement>B</replacement>',
    });

    const result = await service.continueConversation('now b');

    expect(result.success).toBe(true);
    expect(result.editedText).toBe('B');
    expect(mockedRunQuery).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ resumeSessionId: 'session-3' }),
      expect.any(String),
    );
  });

  it('rejects continueConversation without an active session', async () => {
    const result = await service.continueConversation('hello');
    expect(result.success).toBe(false);
    expect(result.error).toBe('No active conversation to continue');
  });
});
