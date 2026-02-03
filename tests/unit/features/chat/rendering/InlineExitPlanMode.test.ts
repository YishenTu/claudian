import { createMockEl } from '@test/helpers/mockElement';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { InlineExitPlanMode } from '@/features/chat/rendering/InlineExitPlanMode';

beforeAll(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  (globalThis as any).document = { activeElement: null };
});

function fireKeyDown(root: any, key: string): void {
  root.dispatchEvent({
    type: 'keydown',
    key,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
  });
}

function findRoot(container: any): any {
  return container.querySelector('.claudian-plan-approval-inline');
}

function findItems(root: any): any[] {
  return root.querySelectorAll('claudian-ask-item');
}

describe('InlineExitPlanMode', () => {
  it('resolves with approve-new-session and includes plan content when readable', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-'));
    const planFilePath = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(planFilePath, 'Step 1\nStep 2\n', 'utf8');

    const container = createMockEl();
    const resolve = jest.fn();
    const renderContent = jest.fn().mockResolvedValue(undefined);

    const widget = new InlineExitPlanMode(
      container,
      {
        planFilePath,
        allowedPrompts: [{ tool: 'Bash', prompt: 'Run bash commands' }],
      },
      resolve,
      undefined,
      renderContent,
    );

    widget.render();

    const root = findRoot(container);
    expect(root).toBeTruthy();
    expect(root.getEventListenerCount('keydown')).toBe(1);
    expect(container.querySelector('.claudian-plan-permissions-list')).toBeTruthy();
    expect(renderContent).toHaveBeenCalled();

    fireKeyDown(root, 'Enter');

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({
      type: 'approve-new-session',
      planContent: 'Implement this plan:\n\nStep 1\nStep 2',
    });
    expect(root.getEventListenerCount('keydown')).toBe(0);
  });

  it('shows a read error when plan file cannot be read', () => {
    const container = createMockEl();
    const resolve = jest.fn();

    const widget = new InlineExitPlanMode(
      container,
      { planFilePath: '/path/does/not/exist.md' },
      resolve,
    );

    widget.render();

    const root = findRoot(container);
    expect(root).toBeTruthy();
    expect(container.querySelector('.claudian-plan-read-error')).toBeTruthy();

    fireKeyDown(root, 'Enter');
    expect(resolve).toHaveBeenCalledWith({
      type: 'approve-new-session',
      planContent: 'Implement the approved plan.',
    });
  });

  it('supports keyboard navigation for approve/current-session', () => {
    const container = createMockEl();
    const resolve = jest.fn();

    const widget = new InlineExitPlanMode(container, {}, resolve);
    widget.render();

    const root = findRoot(container);
    expect(root).toBeTruthy();

    fireKeyDown(root, 'ArrowDown');
    fireKeyDown(root, 'Enter');

    expect(resolve).toHaveBeenCalledWith({ type: 'approve' });
  });

  it('supports feedback flow and Escape when input is focused', () => {
    const container = createMockEl();
    const resolve = jest.fn();

    const widget = new InlineExitPlanMode(container, {}, resolve);
    widget.render();

    const root = findRoot(container);
    expect(root).toBeTruthy();

    fireKeyDown(root, 'ArrowDown');
    fireKeyDown(root, 'ArrowDown');
    fireKeyDown(root, 'Enter');

    const items = findItems(root);
    const feedbackRow = items[2];
    const feedbackInput = feedbackRow.querySelector('claudian-ask-custom-text');

    expect(resolve).not.toHaveBeenCalled();

    feedbackInput.dispatchEvent('focus');

    fireKeyDown(root, 'Escape');
    expect(resolve).not.toHaveBeenCalled();

    feedbackInput.value = 'Please revise the plan';
    feedbackInput.dispatchEvent('focus');

    fireKeyDown(root, 'Enter');
    expect(resolve).toHaveBeenCalledWith({ type: 'feedback', text: 'Please revise the plan' });
  });

  it('resolves null on abort and does not resolve twice', () => {
    const container = createMockEl();
    const resolve = jest.fn();
    const controller = new AbortController();

    const widget = new InlineExitPlanMode(container, {}, resolve, controller.signal);
    widget.render();

    controller.abort();

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(null);

    widget.destroy();
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
