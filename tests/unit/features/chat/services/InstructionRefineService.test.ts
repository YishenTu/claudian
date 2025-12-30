/**
 * Tests for InstructionRefineService - Refining custom instructions
 */

// eslint-disable-next-line jest/no-mocks-import
import {
  getLastOptions,
  resetMockMessages,
  setMockMessages,
} from '@test/__mocks__/claude-agent-sdk';
import * as fs from 'fs';

// Mock fs module
jest.mock('fs');

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
    (service as any).resolvedClaudePath = '/fake/claude';
  });

  describe('refineInstruction', () => {
    it('should use restricted read-only tools', async () => {
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
      expect(options?.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
      expect(options?.permissionMode).toBe('bypassPermissions');
      expect(options?.allowDangerouslySkipPermissions).toBe(true);
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
      expect(options?.systemPrompt).toContain('ready-to-append');
      expect(options?.systemPrompt).toContain('AS-IS');
      expect(options?.systemPrompt).not.toContain('will be prefixed');
    });
  });

  describe('vault restriction hook', () => {
    beforeEach(() => {
      const normalizePath = (p: string) => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pathModule = require('path');
        return pathModule.resolve(p);
      };
      (fs.realpathSync as any) = jest.fn(normalizePath);
      if (fs.realpathSync) {
        (fs.realpathSync as any).native = jest.fn(normalizePath);
      }
    });

    it('should block Glob escaping pattern', async () => {
      const hook = (service as any).createVaultRestrictionHook('/test/vault/path');
      const res = await hook.hooks[0]({
        tool_name: 'Glob',
        tool_input: { pattern: '../**/*.md' },
      });

      expect(res.continue).toBe(false);
      expect(res.hookSpecificOutput.permissionDecisionReason).toContain('outside the vault');
    });
  });
});
