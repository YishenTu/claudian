import { OctoAgentInstructionRefineService } from '@/providers/octo-agent/auxiliary/OctoAgentInstructionRefineService';
import { runOctoAgentAuxQuery } from '@/providers/octo-agent/runtime/OctoAgentAuxQueryRunner';

import type ClaudianPlugin from '../../../main';

jest.mock('@/providers/octo-agent/runtime/OctoAgentAuxQueryRunner');
const mockedRunQuery = jest.mocked(runOctoAgentAuxQuery);

describe('OctoAgentInstructionRefineService', () => {
  let service: OctoAgentInstructionRefineService;
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
  } as unknown as ClaudianPlugin;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OctoAgentInstructionRefineService(mockPlugin);
  });

  it('returns refined instruction wrapped in tags', async () => {
    mockedRunQuery.mockResolvedValue({
      sessionId: 'session-1',
      text: '<instruction>- Be concise.</instruction>',
    });

    const result = await service.refineInstruction('be concise', '');

    expect(result.success).toBe(true);
    expect(result.refinedInstruction).toBe('- Be concise.');
    expect(mockedRunQuery).toHaveBeenCalledTimes(1);
  });

  it('returns clarification when no tags are present', async () => {
    mockedRunQuery.mockResolvedValue({
      sessionId: 'session-2',
      text: 'What do you mean?',
    });

    const result = await service.refineInstruction('use that thing', '');

    expect(result.success).toBe(true);
    expect(result.clarification).toBe('What do you mean?');
  });

  it('returns an error when the query fails', async () => {
    mockedRunQuery.mockRejectedValue(new Error('connection refused'));

    const result = await service.refineInstruction('be concise', '');

    expect(result.success).toBe(false);
    expect(result.error).toBe('connection refused');
  });

  it('continues a conversation using the same session', async () => {
    mockedRunQuery.mockResolvedValue({
      sessionId: 'session-3',
      text: '<instruction>A</instruction>',
    });

    await service.refineInstruction('a', '');

    mockedRunQuery.mockResolvedValue({
      sessionId: 'session-3',
      text: '<instruction>B</instruction>',
    });

    const result = await service.continueConversation('now b');

    expect(result.success).toBe(true);
    expect(result.refinedInstruction).toBe('B');
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

  it('calls onProgress with the parsed result', async () => {
    mockedRunQuery.mockResolvedValue({
      sessionId: 'session-4',
      text: '<instruction>- Test.</instruction>',
    });

    const onProgress = jest.fn();
    await service.refineInstruction('test', '', onProgress);

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        refinedInstruction: '- Test.',
        success: true,
      }),
    );
  });
});
