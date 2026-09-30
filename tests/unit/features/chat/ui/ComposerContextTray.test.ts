import { createMockEl } from '@test/helpers/MockElement';

import { ComposerContextTray } from '@/features/chat/ui/ComposerContextTray';

jest.mock('obsidian', () => ({
  setIcon: jest.fn(),
}));

describe('ComposerContextTray', () => {
  it('updates the removable styling state when linked content becomes locked', () => {
    const containerEl = createMockEl();
    const tray = new ComposerContextTray(containerEl as unknown as HTMLElement);
    const item = { id: 'linked-content', kind: 'content' as const, label: 'Draft.md' };

    tray.setItems('linked-content', [{ ...item, onRemove: jest.fn() }]);
    expect(containerEl.querySelector('.claudian-context-chip')?.hasClass('claudian-context-chip--removable')).toBe(true);

    tray.setItems('linked-content', [item]);
    expect(containerEl.querySelector('.claudian-context-chip')?.hasClass('claudian-context-chip--removable')).toBe(false);
    tray.destroy();
  });

  it('releases its observer when construction fails after observation starts', () => {
    const containerEl = createMockEl();
    const disconnect = jest.fn();
    const ResizeObserverConstructor = class {
      observe(): void {}
      disconnect(): void {
        disconnect();
      }
    };
    containerEl.ownerDocument.defaultView.ResizeObserver = ResizeObserverConstructor;
    const initializationError = new Error('Context tray render failed');

    expect(() => new ComposerContextTray(
      containerEl as unknown as HTMLElement,
      { onDidChange: () => { throw initializationError; } },
    )).toThrow(initializationError);

    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(containerEl.children).toHaveLength(0);
  });

  it('owns empty-state visibility and renders slots in semantic order', () => {
    const containerEl = createMockEl();
    const tray = new ComposerContextTray(containerEl as unknown as HTMLElement);

    expect(containerEl.hasClass('has-content')).toBe(false);
    expect(containerEl.dataset.contextSlots).toBeUndefined();

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
    tray.setItems('linked-content', [{
      id: 'linked-content',
      kind: 'content',
      label: 'Draft.md',
      icon: 'file-text',
      onRemove: jest.fn(),
    }]);

    expect(containerEl.hasClass('has-content')).toBe(true);
    // Presentations can match on which slots are filled without inspecting chips.
    expect(containerEl.dataset.contextSlots).toBe('linked-content editor-selection images');
    expect(containerEl.querySelectorAll('.claudian-context-chip').map((item: any) => item.dataset.contextSlot)).toEqual([
      'linked-content',
      'editor-selection',
      'images',
    ]);
  });

  it('uses separate keyboard-focusable controls for activation and removal', () => {
    const containerEl = createMockEl();
    const onActivate = jest.fn();
    const onRemove = jest.fn();
    const tray = new ComposerContextTray(containerEl as unknown as HTMLElement);

    tray.setItems('editor-selection', [{
      id: 'editor-selection',
      kind: 'selection',
      label: 'Architecture.md',
      icon: 'file-text',
      ariaLabel: 'notes/Architecture.md',
      onActivate,
      onRemove,
    }]);

    const mainButton = containerEl.querySelector('.claudian-context-chip-main');
    const removeButton = containerEl.querySelector('.claudian-context-chip-remove');

    expect(mainButton?.tagName).toBe('BUTTON');
    expect(removeButton?.tagName).toBe('BUTTON');
    expect(mainButton?.getAttribute('aria-label')).toBe('notes/Architecture.md');

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

    tray.setItems('linked-content', [{
      id: 'note',
      kind: 'content',
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

  it('measures rows from rendered chips only, ignoring chips a presentation hides', () => {
    const containerEl = createMockEl();
    const tray = new ComposerContextTray(containerEl as unknown as HTMLElement);
    tray.setItems('linked-content', [{ id: 'note', kind: 'content', label: 'Note.md', onRemove: jest.fn() }]);
    tray.setItems('images', Array.from({ length: 3 }, (_, index) => ({
      id: `image-${index}`,
      kind: 'image' as const,
      label: `image-${index}.png`,
      onRemove: jest.fn(),
    })));

    // Hidden elements report no offset parent and a zero position.
    const chips = containerEl.querySelectorAll('.claudian-context-chip');
    const layout = (visibleTops: number[]) => [null, ...visibleTops].forEach((offsetTop, index) => {
      Object.defineProperties(chips[index], {
        offsetParent: { configurable: true, value: offsetTop === null ? null : containerEl },
        offsetTop: { configurable: true, value: offsetTop ?? 0 },
        offsetHeight: { configurable: true, value: offsetTop === null ? 0 : 24 },
      });
    });
    const moreButton = containerEl.querySelector('.claudian-context-more');

    layout([8, 8, 8]);
    tray.refreshLayout();
    expect(moreButton?.hasClass('claudian-hidden')).toBe(true);

    layout([8, 8, 46]);
    tray.refreshLayout();
    expect(moreButton?.textContent).toBe('+1 more');
    expect(chips[3].hasClass('claudian-context-chip--overflow-hidden')).toBe(true);
    expect(chips[1].hasClass('claudian-context-chip--overflow-hidden')).toBe(false);
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
    expect(containerEl.dataset.contextSlots).toBeUndefined();
    expect(containerEl.children).toHaveLength(0);
  });
});
