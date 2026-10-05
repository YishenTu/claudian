/** @jest-environment jsdom */

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

function setup(currentTitle = 'Original title', rename = jest.fn().mockResolvedValue(undefined)) {
  const { container, item } = renderRow(currentTitle);
  const onFinished = jest.fn();
  const inlineRename = new SessionInlineRename();
  inlineRename.begin(item, { currentTitle, rename, onFinished });
  const input = within(item).getByRole('textbox') as HTMLInputElement;
  return { container, item, input, inlineRename, rename, onFinished };
}

describe('SessionInlineRename', () => {
  afterEach(() => {
    document.body.replaceChildren();
    jest.clearAllMocks();
  });

  it('replaces the row title with a focused editor holding the current title', () => {
    const { item, input } = setup('Test Title');

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

  it('reports a failed rename once', async () => {
    const { input, onFinished } = setup('Original title', jest.fn().mockRejectedValue(new Error('disk full')));

    input.value = 'New title';
    input.blur();

    await waitFor(() => expect(Notice).toHaveBeenCalledWith('Failed to rename conversation'));
    expect(Notice).toHaveBeenCalledTimes(1);
    expect(onFinished).not.toHaveBeenCalled();
  });
});
