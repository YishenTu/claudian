/** @vitest-environment jsdom */

import { within } from '@testing-library/dom';
import { setIcon } from 'obsidian';

import { renderTodoWriteContent } from '@/features/chat/rendering/tools/todoContent';

it('renders task progress and replaces old tasks when the snapshot changes or empties', () => {
  const host = document.createElement('div');
  renderTodoWriteContent(host, { todos: [
    { status: 'completed', content: 'Task 1', activeForm: 'Doing Task 1' },
    { status: 'in_progress', content: 'Task 2', activeForm: 'Doing Task 2' },
    { status: 'pending', content: 'Task 3', activeForm: 'Doing Task 3' },
  ] });
  for (const text of ['Task 1', 'Doing Task 2', 'Task 3']) expect(within(host).getByText(text)).toBeDefined();
  expect(within(host).queryByText('Task 2')).toBeNull();
  const icons = vi.mocked(setIcon).mock.calls;
  expect(icons.map(([, name]) => name)).toEqual(['check', 'dot', 'dot']);
  for (const [element] of icons) expect(element.getAttribute('aria-hidden')).toBe('true');

  renderTodoWriteContent(host, { todos: [{ status: 'completed', content: 'New task', activeForm: 'Working' }] });
  expect(host.textContent).toBe('New task');
  renderTodoWriteContent(host, { todos: [] });
  expect(host.textContent).toBe('');
});
