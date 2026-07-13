import { createMockEl } from '@test/helpers/mockElement';

import { ComposerContextTray } from '@/features/chat/ui/ComposerContextTray';

jest.mock('obsidian', () => ({
  setIcon: jest.fn(),
}));

describe('ComposerContextTray', () => {
  it('owns empty-state visibility and renders slots in semantic order', () => {
    const containerEl = createMockEl();
    const tray = new ComposerContextTray(containerEl as unknown as HTMLElement);

    expect(containerEl.hasClass('has-content')).toBe(false);

    tray.setItems('images', [{
      id: 'image-1',
      kind: 'image',
      label: 'Image',
      onRemove: jest.fn(),
    }]);
    tray.setItems('editor-selection', [{
      id: 'editor-selection',
      kind: 'selection',
      label: '3 lines · Draft.md',
      icon: 'text-select',
      onRemove: jest.fn(),
    }]);
    tray.setItems('current-note', [{
      id: 'current-note',
      kind: 'note',
      label: 'Draft.md',
      icon: 'file-text',
      onRemove: jest.fn(),
    }]);

    expect(containerEl.hasClass('has-content')).toBe(true);
    expect(containerEl.querySelectorAll('.claudian-context-chip').map((item: any) => item.dataset.contextSlot)).toEqual([
      'current-note',
      'editor-selection',
      'images',
    ]);
  });

  it('uses separate keyboard-focusable controls for activation and removal', () => {
    const containerEl = createMockEl();
    const onActivate = jest.fn();
    const onRemove = jest.fn();
    const tray = new ComposerContextTray(containerEl as unknown as HTMLElement);

    tray.setItems('current-note', [{
      id: 'current-note',
      kind: 'note',
      label: 'Architecture.md',
      icon: 'file-text',
      title: 'notes/Architecture.md',
      onActivate,
      onRemove,
    }]);

    const mainButton = containerEl.querySelector('.claudian-context-chip-main');
    const removeButton = containerEl.querySelector('.claudian-context-chip-remove');

    expect(mainButton?.tagName).toBe('BUTTON');
    expect(removeButton?.tagName).toBe('BUTTON');
    expect(mainButton?.getAttribute('title')).toBe('notes/Architecture.md');

    mainButton?.click();
    removeButton?.click();

    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('collapses content after the first visual row and exposes the hidden count', () => {
    const containerEl = createMockEl();
    const tray = new ComposerContextTray(containerEl as unknown as HTMLElement);

    tray.setItems('images', Array.from({ length: 4 }, (_, index) => ({
      id: `image-${index}`,
      kind: 'image' as const,
      label: `image-${index}.png`,
      onRemove: jest.fn(),
    })));

    const chips = containerEl.querySelectorAll('.claudian-context-chip');
    [0, 0, 38, 76].forEach((offsetTop, index) => {
      Object.defineProperty(chips[index], 'offsetTop', { configurable: true, value: offsetTop });
    });

    tray.refreshLayout();

    expect(chips[2].hasClass('claudian-context-chip--overflow-hidden')).toBe(true);
    expect(chips[3].hasClass('claudian-context-chip--overflow-hidden')).toBe(true);
    const moreButton = containerEl.querySelector('.claudian-context-more');
    expect(moreButton?.textContent).toBe('+2 more');

    moreButton?.click();

    expect(containerEl.hasClass('claudian-context-row--expanded')).toBe(true);
    expect(chips.every((chip: any) => !chip.hasClass('claudian-context-chip--overflow-hidden'))).toBe(true);
    expect(moreButton?.textContent).toBe('Show less');
  });

  it('does not collapse vertically centered items that share one flex row', () => {
    const containerEl = createMockEl();
    const tray = new ComposerContextTray(containerEl as unknown as HTMLElement);

    tray.setItems('current-note', [{
      id: 'note',
      kind: 'note',
      label: 'Note.md',
      onRemove: jest.fn(),
    }]);
    tray.setItems('editor-selection', [{
      id: 'selection',
      kind: 'selection',
      label: '1 line selected',
      onRemove: jest.fn(),
    }]);
    tray.setItems('images', [{
      id: 'image',
      kind: 'image',
      label: 'Image',
      onRemove: jest.fn(),
    }]);

    const chips = containerEl.querySelectorAll('.claudian-context-chip');
    [[4, 24], [0, 32], [4, 24]].forEach(([offsetTop, offsetHeight], index) => {
      Object.defineProperties(chips[index], {
        offsetTop: { configurable: true, value: offsetTop },
        offsetHeight: { configurable: true, value: offsetHeight },
      });
    });

    tray.refreshLayout();

    expect(containerEl.querySelector('.claudian-context-more')?.hasClass('claudian-hidden')).toBe(true);
  });

  it('removes the tray when the final owner clears its items', () => {
    const containerEl = createMockEl();
    const tray = new ComposerContextTray(containerEl as unknown as HTMLElement);

    tray.setItems('canvas-selection', [{
      id: 'canvas-selection',
      kind: 'selection',
      label: '2 nodes · Board.canvas',
      onRemove: jest.fn(),
    }]);
    tray.clearItems('canvas-selection');

    expect(containerEl.hasClass('has-content')).toBe(false);
    expect(containerEl.children).toHaveLength(0);
  });
});
