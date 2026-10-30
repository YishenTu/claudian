/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { fireEvent, waitFor, within } from '@testing-library/dom';
import { Notice } from 'obsidian';

import { SessionInlineRename } from '@/features/chat/session-manager/SessionInlineRename';

function renderRow(title: string): { container: HTMLElement; item: HTMLElement } {
  const container = document.createElement('div');
  document.body.append(container);
  const item = container.createDiv({ cls: 'claudian-history-item' });
  item.createDiv({ cls: 'claudian-history-item-title', text: title });
  return { container, item };
}

function setup(currentTitle = 'Original title', rename = vi.fn().mockResolvedValue(undefined)) {
  const { container, item } = renderRow(currentTitle);
  const onFinished = vi.fn();
  const inlineRename = new SessionInlineRename();
  inlineRename.begin(item, { currentTitle, rename, onFinished });
  const input = within(item).getByRole('textbox', { name: 'Conversation title' }) as HTMLInputElement;
  return { container, item, input, inlineRename, rename, onFinished };
}

describe('SessionInlineRename', () => {
  afterEach(() => {
    document.body.replaceChildren();
    vi.clearAllMocks();
  });

  it('replaces the row title with a named, focused editor holding the current title', async () => {
    const { item } = renderRow('Test Title');
    new SessionInlineRename().begin(item, {
      currentTitle: 'Test Title', rename: vi.fn(), onFinished: vi.fn(),
    });

    expect((await axe(item, { runOnly: { type: 'rule', values: ['label'] } })).violations).toEqual([]);
    const input = within(item).getByRole('textbox', { name: 'Conversation title' }) as HTMLInputElement;

    expect(item.querySelector('.claudian-history-item-title')).toBeNull();
    expect(input.value).toBe('Test Title');
    expect(input.ownerDocument.activeElement).toBe(input);
  });

  it('persists a changed title on Enter and then finishes once', async () => {
    const { input, rename, onFinished } = setup();

    input.value = '  New title  ';
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(rename).toHaveBeenCalledWith('New title');
  });

  it('does not persist an unchanged inline rename', async () => {
    const { input, rename, onFinished } = setup();

    input.value = '  Original title  ';
    input.blur();

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(rename).not.toHaveBeenCalled();
  });

  it('restores the original title on Escape without persisting the draft', async () => {
    const { input, rename, onFinished } = setup();

    input.value = 'Unsaved title';
    fireEvent.keyDown(input, { key: 'Escape' });

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(input.value).toBe('Original title');
    expect(rename).not.toHaveBeenCalled();
  });

  it('cancels the active inline rename without persisting the draft', async () => {
    const { input, inlineRename, rename, onFinished } = setup();
    input.value = 'Unsaved title';

    expect(inlineRename.cancel()).toBe(true);

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(input.value).toBe('Original title');
    expect(rename).not.toHaveBeenCalled();
    expect(inlineRename.cancel()).toBe(false);
  });

  it('releases an editor that a rerender discards without blur', () => {
    const { container, input, inlineRename, rename, onFinished } = setup();
    input.value = 'Detached draft';

    inlineRename.releaseWithin(container);

    // Still connected, so only the release keeps cancel from restoring the discarded editor.
    expect(inlineRename.cancel()).toBe(false);
    expect(input.value).toBe('Detached draft');
    expect(rename).not.toHaveBeenCalled();
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('keeps an editor outside the rerendered container', () => {
    const { input, inlineRename } = setup();
    const otherContainer = document.body.appendChild(document.createElement('div'));
    input.value = 'Draft';

    inlineRename.releaseWithin(otherContainer);

    expect(inlineRename.cancel()).toBe(true);
    expect(input.value).toBe('Original title');
  });

  it('can cancel the unfocused editor after a failed rename without retrying the failed title', async () => {
    const { input, inlineRename, rename, onFinished } = setup(
      'Original title', vi.fn().mockRejectedValue(new Error('disk full')),
    );
    input.value = 'Failed title';
    input.blur();
    await waitFor(() => expect(Notice).toHaveBeenCalledWith('Failed to rename conversation'));
    expect(onFinished).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);

    expect(inlineRename.cancel()).toBe(true);

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(input.value).toBe('Original title');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(inlineRename.cancel()).toBe(false);
  });

  it('does not cancel or resubmit a rename that is already being saved', async () => {
    let resolveRename!: () => void;
    const rename = vi.fn(() => new Promise<void>(resolve => { resolveRename = resolve; }));
    const { input, inlineRename, onFinished } = setup('Original title', rename);
    input.value = 'Saving title';
    input.blur();
    expect(rename).toHaveBeenCalledTimes(1);

    expect(inlineRename.cancel()).toBe(false);
    expect(input.value).toBe('Saving title');
    expect(onFinished).not.toHaveBeenCalled();

    resolveRename();
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(rename).toHaveBeenCalledTimes(1);
    expect(inlineRename.cancel()).toBe(false);
  });

  it('allows retrying the edited title after a failed rename', async () => {
    const rename = vi.fn()
      .mockRejectedValueOnce(new Error('disk full'))
      .mockResolvedValueOnce(undefined);
    const { input, onFinished } = setup('Original title', rename);
    input.value = 'Failed title';
    input.blur();
    await waitFor(() => expect(Notice).toHaveBeenCalledTimes(1));

    input.focus();
    input.value = 'Retry title';
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
    expect(rename.mock.calls).toEqual([['Failed title'], ['Retry title']]);
    expect(Notice).toHaveBeenCalledTimes(1);
  });

  it('reports a failed rename once', async () => {
    const { input, onFinished } = setup('Original title', vi.fn().mockRejectedValue(new Error('disk full')));

    input.value = 'New title';
    input.blur();

    await waitFor(() => expect(Notice).toHaveBeenCalledWith('Failed to rename conversation'));
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(onFinished).not.toHaveBeenCalled();
  });
});
