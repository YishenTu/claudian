/**
 * Tests for InstructionRefineService - Refining custom instructions
 */

// eslint-disable-next-line jest/no-mocks-import
import {
  getLastOptions,
  resetMockMessages,
  setMockMessages,
} from '@test/__mocks__/claude-agent-sdk';

// Import after mocks are set up
import { InstructionRefineService } from '@/features/chat/services/InstructionRefineService';

function createMockPlugin(settings = {}) {
  return {
    settings: {
      model: 'sonnet',
      thinkingBudget: 'off',
      systemPrompt: '',
      ...settings,
    },
    app: {
      vault: {
        adapter: {
          basePath: '/test/vault/path',
        },
      },
    },
    getActiveEnvironmentVariables: jest.fn().mockReturnValue(''),
    getResolvedClaudeCliPath: jest.fn().mockReturnValue('/fake/claude'),
  } as any;
}

describe('InstructionRefineService', () => {
  let service: InstructionRefineService;
  let mockPlugin: any;

  beforeEach(() => {
    jest.clearAllMocks();
    resetMockMessages();
    mockPlugin = createMockPlugin();
    service = new InstructionRefineService(mockPlugin);
  });

  describe('refineInstruction', () => {
    it('should use no tools (text-only refinement)', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '<instruction>- Be concise.</instruction>' }],
          },
        },
        { type: 'result' },
      ]);

      const result = await service.refineInstruction('be concise', '');
      expect(result.success).toBe(true);

      const options = getLastOptions();
      expect(options?.tools).toEqual([]);
      expect(options?.permissionMode).toBe('bypassPermissions');
      expect(options?.allowDangerouslySkipPermissions).toBe(true);
    });

    it('should set settingSources to project only when loadUserClaudeSettings is false', async () => {
      mockPlugin.settings.loadUserClaudeSettings = false;
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '<instruction>- Be concise.</instruction>' }],
          },
        },
        { type: 'result' },
      ]);

      await service.refineInstruction('be concise', '');

      const options = getLastOptions();
      expect(options?.settingSources).toEqual(['project']);
    });

    it('should set settingSources to include user when loadUserClaudeSettings is true', async () => {
      mockPlugin.settings.loadUserClaudeSettings = true;
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: '<instruction>- Be concise.</instruction>' }],
          },
        },
        { type: 'result' },
      ]);

      await service.refineInstruction('be concise', '');

      const options = getLastOptions();
      expect(options?.settingSources).toEqual(['user', 'project']);
    });

    it('should include existing instructions and allow markdown blocks', async () => {
      setMockMessages([
        { type: 'system', subtype: 'init', session_id: 'test-session' },
        {
          type: 'assistant',
          message: {
            content: [
              {
                type: 'text',
                text: '<instruction>\n## Coding Style\n\n- Use TypeScript.\n- Prefer small diffs.\n</instruction>',
              },
            ],
          },
        },
        { type: 'result' },
      ]);

      const existing = '## Existing\n\n- Keep it short.';
      const result = await service.refineInstruction('coding style', existing);

      expect(result.success).toBe(true);
      expect(result.refinedInstruction).toBe('## Coding Style\n\n- Use TypeScript.\n- Prefer small diffs.');

      const options = getLastOptions();
      expect(options?.systemPrompt).toContain('EXISTING INSTRUCTIONS');
      expect(options?.systemPrompt).toContain(existing);
      expect(options?.systemPrompt).toContain('Consider how it fits with existing instructions');
      expect(options?.systemPrompt).toContain('Match the format of existing instructions');
    });
  });
});
