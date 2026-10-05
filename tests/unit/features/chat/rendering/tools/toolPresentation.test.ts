import { createMockEl } from '@test/helpers/MockElement';

import { getToolIcon } from '@/core/tools/toolIcons';
import type { ToolCallInfo } from '@/core/types';
import { renderStoredToolCall } from '@/features/chat/rendering/tools/ToolCallRenderer';
import {
  getToolLabel,
  getToolName,
  getToolSummary,
} from '@/features/chat/rendering/tools/toolPresentation';

jest.mock('obsidian', () => ({
  Platform: { resourcePathPrefix: 'app://local/' },
  setIcon: jest.fn(),
}));

// Helper to create a basic tool call
function createToolCall(overrides: Partial<ToolCallInfo> = {}): ToolCallInfo {
  return {
    id: 'tool-123',
    name: 'Read',
    input: { file_path: '/test/file.md' },
    status: 'running',
    ...overrides,
  };
}

describe('toolPresentation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getToolLabel', () => {
    it('should label Read tool with shortened path', () => {
      expect(getToolLabel('Read', { file_path: '/a/b/c/d/e.ts' })).toBe('Read: .../d/e.ts');
    });

    it('should label Read with fallback for missing path', () => {
      expect(getToolLabel('Read', {})).toBe('Read: file');
    });

    it('should label Write tool with path', () => {
      expect(getToolLabel('Write', { file_path: 'short.ts' })).toBe('Write: short.ts');
    });

    it('should label Edit tool with path', () => {
      expect(getToolLabel('Edit', { file_path: 'file.ts' })).toBe('Edit: file.ts');
    });

    it('should label Bash tool and truncate long commands', () => {
      const shortCmd = 'npm test';
      expect(getToolLabel('Bash', { command: shortCmd })).toBe('Bash: npm test');

      const longCmd = 'a'.repeat(50);
      expect(getToolLabel('Bash', { command: longCmd })).toBe(`Bash: ${'a'.repeat(40)}...`);
    });

    it('should label Bash with fallback for missing command', () => {
      expect(getToolLabel('Bash', {})).toBe('Bash: command');
    });

    it('should label Glob tool', () => {
      expect(getToolLabel('Glob', { pattern: '**/*.ts' })).toBe('Glob: **/*.ts');
    });

    it('should label Glob with fallback', () => {
      expect(getToolLabel('Glob', {})).toBe('Glob: files');
    });

    it('should label Grep tool', () => {
      expect(getToolLabel('Grep', { pattern: 'TODO' })).toBe('Grep: TODO');
    });

    it('should label WebSearch and truncate long queries', () => {
      expect(getToolLabel('WebSearch', { query: 'short' })).toBe('WebSearch: short');

      const longQuery = 'q'.repeat(50);
      expect(getToolLabel('WebSearch', { query: longQuery })).toBe(`WebSearch: ${'q'.repeat(40)}...`);
    });

    it('should label WebSearch open_page actions with the URL', () => {
      expect(getToolLabel('WebSearch', {
        actionType: 'open_page',
        url: 'https://example.com/docs',
      })).toBe('WebSearch: Open https://example.com/docs');
    });

    it('should label WebFetch and truncate long URLs', () => {
      expect(getToolLabel('WebFetch', { url: 'https://x.com' })).toBe('WebFetch: https://x.com');

      const longUrl = 'https://' + 'x'.repeat(50);
      expect(getToolLabel('WebFetch', { url: longUrl })).toBe(`WebFetch: ${longUrl.substring(0, 40)}...`);
    });

    it('should label LS tool with path', () => {
      expect(getToolLabel('LS', { path: '/src' })).toBe('LS: /src');
    });

    it('should label LS with fallback', () => {
      expect(getToolLabel('LS', {})).toBe('LS: .');
    });

    it('should label TodoWrite with completion count', () => {
      const todos = [
        { status: 'completed' },
        { status: 'completed' },
        { status: 'pending' },
      ];
      expect(getToolLabel('TodoWrite', { todos })).toBe('Tasks (2/3)');
    });

    it('should label TodoWrite without array', () => {
      expect(getToolLabel('TodoWrite', {})).toBe('Tasks');
    });

    it('should label Skill tool', () => {
      expect(getToolLabel('Skill', { skill: 'commit' })).toBe('Skill: commit');
    });

    it('should label Skill with fallback', () => {
      expect(getToolLabel('Skill', {})).toBe('Skill: skill');
    });

    it('should label ToolSearch with tool names', () => {
      expect(getToolLabel('ToolSearch', { query: 'select:Read,Glob' })).toBe('ToolSearch: Read, Glob');
    });

    it('should label ToolSearch with fallback for missing query', () => {
      expect(getToolLabel('ToolSearch', {})).toBe('ToolSearch: tools');
    });

    it('should return raw name for unknown tools', () => {
      expect(getToolLabel('CustomTool', {})).toBe('CustomTool');
    });
  });

  describe('getToolName', () => {
    it('should return tool name for standard tools', () => {
      expect(getToolName('Read', {})).toBe('Read');
      expect(getToolName('Write', {})).toBe('Write');
      expect(getToolName('Bash', {})).toBe('Bash');
      expect(getToolName('Glob', {})).toBe('Glob');
    });

    it('should return Tasks with count for TodoWrite', () => {
      const todos = [
        { status: 'completed' },
        { status: 'completed' },
        { status: 'pending' },
      ];
      expect(getToolName('TodoWrite', { todos })).toBe('Tasks 2/3');
      expect(getToolName('TodoWrite', {})).toBe('Tasks');
    });

    it('should return plan mode labels', () => {
      expect(getToolName('EnterPlanMode', {})).toBe('Entering plan mode');
      expect(getToolName('ExitPlanMode', {})).toBe('Plan complete');
    });
  });

  describe('getToolSummary', () => {
    it('should return filename-only for file tools', () => {
      expect(getToolSummary('Read', { file_path: '/a/b/c/file.ts' })).toBe('file.ts');
      expect(getToolSummary('Write', { file_path: '/src/index.ts' })).toBe('index.ts');
      expect(getToolSummary('Edit', { file_path: 'simple.md' })).toBe('simple.md');
    });

    it('should return empty for file tools with no path', () => {
      expect(getToolSummary('Read', {})).toBe('');
    });

    it('should return command for Bash', () => {
      expect(getToolSummary('Bash', { command: 'npm test' })).toBe('npm test');
    });

    it('should truncate long Bash commands', () => {
      const longCmd = 'a'.repeat(70);
      expect(getToolSummary('Bash', { command: longCmd })).toBe('a'.repeat(60) + '...');
    });

    it('should return pattern for Glob/Grep', () => {
      expect(getToolSummary('Glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
      expect(getToolSummary('Grep', { pattern: 'TODO' })).toBe('TODO');
    });

    it('should return query for WebSearch', () => {
      expect(getToolSummary('WebSearch', { query: 'test query' })).toBe('test query');
    });

    it('should summarize WebSearch find_in_page actions', () => {
      expect(getToolSummary('WebSearch', {
        actionType: 'find_in_page',
        url: 'https://example.com/docs',
        pattern: 'tools',
      })).toBe('Find "tools" in https://example.com/docs');
    });

    it('should return url for WebFetch', () => {
      expect(getToolSummary('WebFetch', { url: 'https://x.com' })).toBe('https://x.com');
    });

    it('should return filename for LS', () => {
      expect(getToolSummary('LS', { path: '/src/components' })).toBe('components');
    });

    it('should return skill name for Skill', () => {
      expect(getToolSummary('Skill', { skill: 'commit' })).toBe('commit');
    });

    it('should return empty for TodoWrite', () => {
      const todos = [
        { status: 'completed', activeForm: 'Done' },
        { status: 'in_progress', activeForm: 'Working on it' },
      ];
      expect(getToolSummary('TodoWrite', { todos })).toBe('');
      expect(getToolSummary('TodoWrite', {})).toBe('');
    });

    it('should return empty for AskUserQuestion', () => {
      expect(getToolSummary('AskUserQuestion', { questions: [{ question: 'Q1' }] })).toBe('');
      expect(getToolSummary('AskUserQuestion', { questions: [{ question: 'Q1' }, { question: 'Q2' }] })).toBe('');
    });

    it('should return parsed tool names for ToolSearch', () => {
      expect(getToolSummary('ToolSearch', { query: 'select:Read,Glob' })).toBe('Read, Glob');
      expect(getToolSummary('ToolSearch', { query: 'select:Bash' })).toBe('Bash');
    });

    it('should return empty for ToolSearch with missing query', () => {
      expect(getToolSummary('ToolSearch', {})).toBe('');
    });

    it('should return empty for unknown tools', () => {
      expect(getToolSummary('CustomTool', {})).toBe('');
    });
  });

  describe('getToolSummary - Codex native tools', () => {
    it('returns file count for apply_patch with changes array', () => {
      expect(getToolSummary('apply_patch', {
        changes: [{ path: 'src/a.ts', kind: 'update' }, { path: 'src/b.ts', kind: 'add' }],
      })).toBe('2 files');
    });

    it('returns single filename for apply_patch with one change', () => {
      expect(getToolSummary('apply_patch', {
        changes: [{ path: 'src/main.ts', kind: 'update' }],
      })).toBe('main.ts');
    });

    it('extracts files from patch text markers', () => {
      expect(getToolSummary('apply_patch', {
        patch: '*** Update File: src/main.ts\n--- src/main.ts\n+++ src/main.ts\n@@ ...',
      })).toBe('main.ts');
    });

    it('returns "patch" for apply_patch with unrecognized patch text', () => {
      expect(getToolSummary('apply_patch', { patch: 'diff output here' })).toBe('patch');
    });

    it('returns empty for apply_patch with no input', () => {
      expect(getToolSummary('apply_patch', {})).toBe('');
    });

    it('returns session id for write_stdin', () => {
      expect(getToolSummary('write_stdin', { session_id: 'sess_1', chars: 'y\n' })).toBe('#sess_1 y\\n');
    });

    it('returns chars preview for write_stdin without session', () => {
      expect(getToolSummary('write_stdin', { chars: 'y\n' })).toBe('y\\n');
    });

    it('returns empty for write_stdin with no input', () => {
      expect(getToolSummary('write_stdin', {})).toBe('');
    });

    it('returns message preview for spawn_agent', () => {
      expect(getToolSummary('spawn_agent', { message: 'Update imports' })).toBe('Update imports');
    });

    it('truncates long spawn_agent messages', () => {
      const longMsg = 'a'.repeat(60);
      expect(getToolSummary('spawn_agent', { message: longMsg })).toBe('a'.repeat(50) + '...');
    });

    it('returns agent count and timeout for wait', () => {
      expect(getToolSummary('wait', { ids: ['a1'], timeout_ms: 30000 })).toBe('1 agent, 30s');
    });

    it('returns message preview for send_input', () => {
      expect(getToolSummary('send_input', { message: 'Also update exports.' })).toBe('Also update exports.');
    });

    it('returns empty for resume_agent and close_agent', () => {
      expect(getToolSummary('resume_agent', {})).toBe('');
      expect(getToolSummary('close_agent', {})).toBe('');
    });
  });

  describe('getToolLabel - Codex native tools', () => {
    it('labels apply_patch with summary', () => {
      expect(getToolLabel('apply_patch', {
        changes: [{ path: 'src/foo.ts', kind: 'update' }],
      })).toBe('apply_patch: foo.ts');
    });

    it('labels apply_patch without changes', () => {
      expect(getToolLabel('apply_patch', {})).toBe('apply_patch');
    });

    it('labels write_stdin with summary', () => {
      expect(getToolLabel('write_stdin', { session_id: 's1' })).toBe('write_stdin: #s1');
    });

    it('labels write_stdin without input', () => {
      expect(getToolLabel('write_stdin', {})).toBe('write_stdin');
    });

    it('labels spawn_agent with message', () => {
      expect(getToolLabel('spawn_agent', { message: 'Fix bug' })).toBe('spawn_agent: Fix bug');
    });

    it('labels wait with count', () => {
      expect(getToolLabel('wait', { ids: ['a1', 'a2'], timeout_ms: 5000 })).toBe('wait: 2 agents, 5s');
    });

    it('returns raw name for lifecycle tools with no summary', () => {
      expect(getToolLabel('close_agent', {})).toBe('close_agent');
    });
  });


  describe('script tool rendering', () => {
    it.each([
      ['exec', { code: 'return 1;' }, 'Script: return 1;', 'code', 'JavaScript'],
      ['Workflow', { code: 'agent("ping")', language: 'Rhai', title: 'pong' }, 'Workflow: pong', 'workflow', 'Rhai'],
    ])('presents %s with its source language', (name, input, label, icon, language) => {
      expect(getToolLabel(name, input)).toBe(label);
      expect(getToolIcon(name)).toBe(icon);

      const toolEl = renderStoredToolCall(createMockEl(), createToolCall({ name, input, status: 'completed', result: 'ok' }));
      (toolEl.querySelector('.claudian-tool-header') as HTMLElement).click();
      expect(Array.from(toolEl.querySelectorAll('.claudian-tool-script-label')).map(el => el.textContent))
        .toEqual([language, 'Output']);
    });
  });

});
