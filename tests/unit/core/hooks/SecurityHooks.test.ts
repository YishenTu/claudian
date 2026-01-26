import {
  type BlocklistContext,
  createBlocklistHook,
  createVaultRestrictionHook,
  type VaultRestrictionContext,
} from '@/core/hooks/SecurityHooks';
import type { PathAccessType } from '@/utils/path';

describe('SecurityHooks', () => {
  describe('createBlocklistHook', () => {
    const createHookInput = (command: string) => ({
      hook_event_name: 'PreToolUse' as const,
      session_id: 'test-session',
      transcript_path: '/tmp/transcript',
      cwd: '/vault',
      tool_name: 'Bash',
      tool_input: { command },
      tool_use_id: 'tool-1',
    });

    it('blocks commands in the blocklist when blocklist is enabled', async () => {
      const context: BlocklistContext = {
        blockedCommands: {
          unix: ['rm -rf', 'chmod 777'],
          windows: [],
        },
        enableBlocklist: true,
      };

      const hook = createBlocklistHook(() => context);

      const result = await hook.hooks[0](
        createHookInput('rm -rf /'),
        'tool-1',
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({
        continue: false,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('Command blocked by blocklist'),
        },
      });
    });

    it('allows commands not in the blocklist', async () => {
      const context: BlocklistContext = {
        blockedCommands: {
          unix: ['rm -rf'],
          windows: [],
        },
        enableBlocklist: true,
      };

      const hook = createBlocklistHook(() => context);

      const result = await hook.hooks[0](
        createHookInput('ls -la'),
        'tool-1',
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({ continue: true });
    });

    it('allows all commands when blocklist is disabled', async () => {
      const context: BlocklistContext = {
        blockedCommands: {
          unix: ['rm -rf'],
          windows: [],
        },
        enableBlocklist: false,
      };

      const hook = createBlocklistHook(() => context);

      const result = await hook.hooks[0](
        createHookInput('rm -rf /'),
        'tool-1',
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({ continue: true });
    });

    it('handles empty command', async () => {
      const context: BlocklistContext = {
        blockedCommands: {
          unix: ['rm -rf'],
          windows: [],
        },
        enableBlocklist: true,
      };

      const hook = createBlocklistHook(() => context);

      const result = await hook.hooks[0](
        createHookInput(''),
        'tool-1',
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({ continue: true });
    });

    it('handles undefined command', async () => {
      const context: BlocklistContext = {
        blockedCommands: {
          unix: ['rm -rf'],
          windows: [],
        },
        enableBlocklist: true,
      };

      const hook = createBlocklistHook(() => context);

      const result = await hook.hooks[0](
        {
          hook_event_name: 'PreToolUse' as const,
          session_id: 'test-session',
          transcript_path: '/tmp/transcript',
          cwd: '/vault',
          tool_name: 'Bash',
          tool_input: {},
          tool_use_id: 'tool-1',
        },
        'tool-1',
        { signal: new AbortController().signal }
      );

      expect(result).toEqual({ continue: true });
    });

    it('matcher is set to Bash tool', () => {
      const hook = createBlocklistHook(() => ({
        blockedCommands: { unix: [], windows: [] },
        enableBlocklist: true,
      }));

      expect(hook.matcher).toBe('Bash');
    });
  });

  describe('createVaultRestrictionHook', () => {
    const createHookInput = (toolName: string, toolInput: Record<string, unknown>) => ({
      hook_event_name: 'PreToolUse' as const,
      session_id: 'test-session',
      transcript_path: '/tmp/transcript',
      cwd: '/vault',
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: 'tool-1',
    });

    describe('Bash commands', () => {
      it('allows Bash commands with paths inside vault', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: (path: string): PathAccessType => {
            if (path.startsWith('/vault')) return 'vault';
            return 'none';
          },
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('Bash', { command: 'cat /vault/file.txt' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({ continue: true });
      });

      it('blocks Bash commands with paths outside vault', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: (): PathAccessType => 'none',
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('Bash', { command: 'cat /etc/passwd' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({
          continue: false,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: expect.stringContaining('outside the vault'),
          },
        });
      });

      it('blocks read from export paths in Bash commands', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: (path: string): PathAccessType => {
            if (path.includes('Desktop')) return 'export';
            return 'none';
          },
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('Bash', { command: 'cat ~/Desktop/file.txt' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({
          continue: false,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: expect.stringContaining('write-only'),
          },
        });
      });
    });

    describe('File tools', () => {
      it('allows Read tool with vault paths', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: (): PathAccessType => 'vault',
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('Read', { file_path: '/vault/notes/test.md' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({ continue: true });
      });

      it('allows Read tool with readwrite paths', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: (): PathAccessType => 'readwrite',
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('Read', { file_path: '/external/project/src/file.ts' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({ continue: true });
      });

      it('allows Read tool with context paths', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: (): PathAccessType => 'context',
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('Read', { file_path: '/context/file.ts' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({ continue: true });
      });

      it('blocks Read tool with export paths (write-only)', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: (): PathAccessType => 'export',
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('Read', { file_path: '~/Desktop/exported.pdf' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({
          continue: false,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: expect.stringContaining('write-only'),
          },
        });
      });

      it('blocks Read tool with blocked paths', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: (): PathAccessType => 'none',
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('Read', { file_path: '/etc/passwd' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({
          continue: false,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: expect.stringContaining('outside the vault'),
          },
        });
      });

      it('allows Write tool with export paths', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: (): PathAccessType => 'export',
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('Write', { file_path: '~/Desktop/output.pdf', content: 'data' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({ continue: true });
      });

      it('allows Edit tool with export paths', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: (): PathAccessType => 'export',
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('Edit', { file_path: '~/Downloads/file.txt', old_string: 'a', new_string: 'b' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({ continue: true });
      });

      it('blocks Glob tool with blocked paths', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: (): PathAccessType => 'none',
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('Glob', { path: '/home/user/secrets', pattern: '*.key' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({
          continue: false,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: expect.stringContaining('outside the vault'),
          },
        });
      });

      it('blocks Grep tool with blocked paths', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: (): PathAccessType => 'none',
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('Grep', { path: '/var/log', pattern: 'password' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({
          continue: false,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: expect.stringContaining('outside the vault'),
          },
        });
      });
    });

    describe('Non-file tools', () => {
      it('allows non-file tools without path checking', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: jest.fn(),
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('WebSearch', { query: 'test query' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({ continue: true });
        expect(context.getPathAccessType).not.toHaveBeenCalled();
      });

      it('allows Task tool without path checking', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: jest.fn(),
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('Task', { prompt: 'analyze codebase', subagent_type: 'Explore' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({ continue: true });
        expect(context.getPathAccessType).not.toHaveBeenCalled();
      });

      it('allows TodoWrite tool without path checking', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: jest.fn(),
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('TodoWrite', { todos: [] }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({ continue: true });
        expect(context.getPathAccessType).not.toHaveBeenCalled();
      });
    });

    describe('Edge cases', () => {
      it('allows file tools without path in input', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: jest.fn(),
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('Read', {}),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({ continue: true });
      });

      it('handles LS tool with path', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: (): PathAccessType => 'vault',
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('LS', { path: '/vault/src' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({ continue: true });
      });

      it('handles NotebookEdit tool', async () => {
        const context: VaultRestrictionContext = {
          getPathAccessType: (): PathAccessType => 'vault',
        };

        const hook = createVaultRestrictionHook(context);

        const result = await hook.hooks[0](
          createHookInput('NotebookEdit', { notebook_path: '/vault/notebook.ipynb', new_source: 'code' }),
          'tool-1',
          { signal: new AbortController().signal }
        );

        expect(result).toEqual({ continue: true });
      });

      it('no matcher set (applies to all tools)', () => {
        const hook = createVaultRestrictionHook({
          getPathAccessType: () => 'vault',
        });

        expect(hook.matcher).toBeUndefined();
      });
    });
  });
});
