import { createMockEl } from '@test/helpers/MockElement';
import { setIcon } from 'obsidian';

import type { ToolCallInfo } from '@/core/types';
import {
  renderStoredToolCall,
  renderToolCall,
  updateToolCallResult,
} from '@/features/chat/rendering/tools/ToolCallRenderer';

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

describe('applyPatchContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('apply_patch expanded rendering', () => {
    it('renders parsed patch diffs from tool input', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'apply_patch',
        status: 'completed',
        input: {
          patch: [
            '*** Begin Patch',
            '*** Update File: src/main.ts',
            '@@',
            "-import { Plugin } from 'obsidian';",
            "+import { Plugin, Notice } from 'obsidian';",
            '*** End Patch',
          ].join('\n'),
        },
        result: 'Applied patch',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const header = toolEl.querySelector('.claudian-tool-header');
      const content = toolEl.querySelector('.claudian-tool-content');
      expect(toolEl.hasClass('expanded')).toBe(false);
      expect(content?.hasClass('claudian-hidden')).toBe(true);
      expect(header?.getAttribute('aria-expanded')).toBe('false');

      (header as HTMLElement).click();
      const headers = Array.from(toolEl.querySelectorAll('.claudian-tool-patch-header')).map(el => el.textContent);
      const statusEl = toolEl.querySelector('.claudian-tool-status');
      const diffTexts = Array.from(toolEl.querySelectorAll('.claudian-diff-text')).map(el => el.textContent);

      expect(headers).toHaveLength(0);
      expect(statusEl?.hasClass('claudian-write-edit-stats')).toBe(true);
      expect(statusEl?.querySelector('.added')?.textContent).toBe('+1');
      expect(statusEl?.querySelector('.removed')?.textContent).toBe('-1');
      expect(statusEl?.getAttribute('aria-label')).toBe('Changes: +1 -1');
      expect(setIcon).not.toHaveBeenCalledWith(expect.anything(), 'check');
      expect(diffTexts).toContain("import { Plugin } from 'obsidian';");
      expect(diffTexts).toContain("import { Plugin, Notice } from 'obsidian';");
    });

    it('renders stored apply_patch expanded when requested', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'apply_patch',
        status: 'completed',
        input: {
          patch: [
            '*** Begin Patch',
            '*** Update File: src/main.ts',
            '@@',
            '-old',
            '+new',
            '*** End Patch',
          ].join('\n'),
        },
        result: 'Applied patch',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall, { initiallyExpanded: true });
      const header = toolEl.querySelector('.claudian-tool-header');
      const content = toolEl.querySelector('.claudian-tool-content');

      expect(toolEl.hasClass('expanded')).toBe(true);
      expect(content?.hasClass('claudian-hidden')).toBe(false);
      expect(header?.getAttribute('aria-expanded')).toBe('true');
    });

    it('renders fileChange patchUpdated diffs from changes input', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'apply_patch',
        status: 'completed',
        input: {
          changes: [
            {
              path: 'src/main.ts',
              kind: 'update',
              diff: '@@ -1 +1 @@\n-old value\n+new value',
            },
          ],
        },
        result: 'Applied patch',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      (toolEl.querySelector('.claudian-tool-header') as HTMLElement).click();
      const headers = Array.from(toolEl.querySelectorAll('.claudian-tool-patch-header')).map(el => el.textContent);
      const statusEl = toolEl.querySelector('.claudian-tool-status');
      const diffTexts = Array.from(toolEl.querySelectorAll('.claudian-diff-text')).map(el => el.textContent);

      expect(headers).toHaveLength(0);
      expect(statusEl?.hasClass('claudian-write-edit-stats')).toBe(true);
      expect(statusEl?.querySelector('.added')?.textContent).toBe('+1');
      expect(statusEl?.querySelector('.removed')?.textContent).toBe('-1');
      expect(setIcon).not.toHaveBeenCalledWith(expect.anything(), 'check');
      expect(diffTexts).toContain('old value');
      expect(diffTexts).toContain('new value');
    });

    it('aggregates apply_patch header stats across changed files', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'apply_patch',
        status: 'completed',
        input: {
          changes: [
            {
              path: 'src/main.ts',
              kind: 'update',
              diff: '@@ -1 +1 @@\n-old value\n+new value',
            },
            {
              path: 'src/extra.ts',
              kind: 'update',
              diff: '@@ -1 +1,2 @@\n-old extra\n+new extra\n+another extra',
            },
          ],
        },
        result: 'Applied patch',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const statusEl = toolEl.querySelector('.claudian-tool-status');

      expect(statusEl?.querySelector('.added')?.textContent).toBe('+3');
      expect(statusEl?.querySelector('.removed')?.textContent).toBe('-2');
      expect(statusEl?.getAttribute('aria-label')).toBe('Changes: +3 -2');
    });

    it('keeps the error status icon for failed apply_patch calls', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'apply_patch',
        status: 'error',
        input: {
          changes: [
            {
              path: 'src/main.ts',
              kind: 'update',
              diff: '@@ -1 +1 @@\n-old value\n+new value',
            },
          ],
        },
        result: 'Error: patch failed',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      const statusEl = toolEl.querySelector('.claudian-tool-status');

      expect(statusEl?.hasClass('status-error')).toBe(true);
      expect(statusEl?.hasClass('claudian-write-edit-stats')).toBe(false);
      expect(setIcon).toHaveBeenCalledWith(expect.anything(), 'x');
    });

    it('updates the header stats when apply_patch diffs arrive during streaming', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        id: 'patch-1',
        name: 'apply_patch',
        status: 'running',
        input: {},
      });


      const toolEl = renderToolCall(parentEl, toolCall);
      jest.clearAllMocks();

      toolCall.status = 'completed';
      toolCall.result = 'Applied patch';
      toolCall.input = {
        changes: [
          {
            path: 'src/main.ts',
            kind: 'update',
            diff: '@@ -1 +1 @@\n-old value\n+new value',
          },
        ],
      };

      updateToolCallResult(toolEl, toolCall);
      (toolEl.querySelector('.claudian-tool-header') as HTMLElement).click();

      const statusEl = toolEl.querySelector('.claudian-tool-status');
      const diffTexts = Array.from(toolEl.querySelectorAll('.claudian-diff-text')).map(el => el.textContent);

      expect(statusEl?.hasClass('claudian-write-edit-stats')).toBe(true);
      expect(statusEl?.querySelector('.added')?.textContent).toBe('+1');
      expect(statusEl?.querySelector('.removed')?.textContent).toBe('-1');
      expect(setIcon).not.toHaveBeenCalledWith(expect.anything(), 'check');
      expect(diffTexts).toContain('old value');
      expect(diffTexts).toContain('new value');
    });

    it('falls back to file changes when patch text is unavailable', () => {
      const parentEl = createMockEl();
      const toolCall = createToolCall({
        name: 'apply_patch',
        status: 'completed',
        input: {
          changes: [{ path: 'src/main.ts', kind: 'update' }],
        },
        result: 'Applied patch',
      });

      const toolEl = renderStoredToolCall(parentEl, toolCall);
      (toolEl.querySelector('.claudian-tool-header') as HTMLElement).click();
      const lines = Array.from(toolEl.querySelectorAll('.claudian-tool-line')).map(el => el.textContent);

      expect(lines).toContain('src/main.ts');
      expect(lines).not.toContain('update: src/main.ts');
    });
  });

});
