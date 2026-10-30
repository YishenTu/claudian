/** @vitest-environment jsdom */

import { fireEvent, within } from '@testing-library/dom';

import { getToolIcon } from '@/core/tools/toolIcons';
import type { ToolCallInfo } from '@/core/types';
import { renderStoredToolCall } from '@/features/chat/rendering/tools/ToolCallRenderer';
import {
  getToolLabel,
} from '@/features/chat/rendering/tools/toolPresentation';

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

  describe('script tool rendering', () => {
    it.each([
      ['exec', { code: 'return 1;' }, 'Script: return 1;', 'code', 'JavaScript'],
      ['Workflow', { code: 'agent("ping")', language: 'Rhai', title: 'pong' }, 'Workflow: pong', 'workflow', 'Rhai'],
    ])('presents %s with its source language', (name, input, label, icon, language) => {
      expect(getToolLabel(name, input)).toBe(label);
      expect(getToolIcon(name)).toBe(icon);

      const toolEl = renderStoredToolCall(document.createElement('div'), createToolCall({ name, input, status: 'completed', result: 'ok' }));
      fireEvent.click(within(toolEl).getByRole('button', { name: /click to expand/ }));
      expect(Array.from(toolEl.querySelectorAll('.claudian-tool-script-label')).map(el => el.textContent))
        .toEqual([language, 'Output']);
    });
  });
