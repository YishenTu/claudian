import { createMockEl, type MockElement } from '@test/helpers/mockElement';

import { FileDragDropManager } from '@/features/chat/ui/FileDragDropManager';

function createContainerWithInputWrapper(): { container: MockElement; inputWrapper: MockElement } {
  const container = createMockEl();
  const inputWrapper = container.createDiv({ cls: 'claudian-input-wrapper' });
  return { container, inputWrapper };
}

function createDataTransfer(options: {
  types?: string[];
  markdownData?: string;
  plainTextData?: string;
} = {}): DataTransfer {
  const { types = [], markdownData = '', plainTextData = '' } = options;
  return {
    types,
    getData: (format: string) => {
      if (format === 'text/obsidian-markdown') return markdownData;
      if (format === 'text/plain') return plainTextData;
      return '';
    },
  } as unknown as DataTransfer;
}

function createDragEvent(type: string, dataTransfer: DataTransfer) {
  return {
    type,
    dataTransfer,
    clientX: 10,
    clientY: 10,
    preventDefault: jest.fn(),
    stopPropagation: jest.fn(),
  };
}

describe('FileDragDropManager', () => {
  let app: any;
  let container: MockElement;
  let inputWrapper: MockElement;
  let manager: FileDragDropManager;
  let droppedPaths: string[];

  beforeAll(() => {
    if (typeof globalThis.document === 'undefined') {
      (globalThis as any).document = {};
    }
    (globalThis.document as any).createElementNS = jest.fn(() => {
      const el = createMockEl('svg');
      el.setAttribute = jest.fn();
      return el;
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();

    const els = createContainerWithInputWrapper();
    container = els.container;
    inputWrapper = els.inputWrapper;
    droppedPaths = [];

    app = {
      vault: {
        getAbstractFileByPath: jest.fn((path: string) => {
          if (path === 'notes/a.md') return { path, basename: 'a' };
          if (path === 'notes/b.md') return { path, basename: 'b' };
          return null;
        }),
        getRoot: jest.fn(() => ({
          children: [{ path: 'notes/fallback.md', basename: 'fallback' }],
        })),
      },
      metadataCache: {
        getFirstLinkpathDest: jest.fn((path: string) => {
          if (path === 'alias-a') return { path: 'notes/a.md', basename: 'a' };
          return null;
        }),
      },
      dragManager: {
        draggable: null as any,
      },
    };

    manager = new FileDragDropManager(app, container as any, {
      onFilesDropped: (filePaths) => {
        droppedPaths = filePaths;
      },
    });
  });

  it('initializes overlay and event listeners', () => {
    expect(container.querySelector('.claudian-file-drop-overlay')).not.toBeNull();
    expect(inputWrapper.getEventListenerCount('dragenter')).toBe(1);
    expect(inputWrapper.getEventListenerCount('dragover')).toBe(1);
    expect(inputWrapper.getEventListenerCount('dragleave')).toBe(1);
    expect(inputWrapper.getEventListenerCount('drop')).toBe(1);
  });

  it('ignores non-obsidian drags to avoid conflicts with image drag-drop', () => {
    const overlay = container.querySelector('.claudian-file-drop-overlay') as MockElement;
    const event = createDragEvent('dragenter', createDataTransfer({ types: ['Files'] }));

    inputWrapper.dispatchEvent(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(overlay.hasClass('visible')).toBe(false);
  });

  it('shows overlay for obsidian markdown drags', () => {
    const overlay = container.querySelector('.claudian-file-drop-overlay') as MockElement;
    const event = createDragEvent('dragenter', createDataTransfer({ types: ['text/obsidian-markdown'] }));

    inputWrapper.dispatchEvent(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(overlay.hasClass('visible')).toBe(true);
  });

  it('shows overlay for obsidian plain-text drags without Files type', () => {
    const overlay = container.querySelector('.claudian-file-drop-overlay') as MockElement;
    const event = createDragEvent('dragenter', createDataTransfer({ types: ['text/plain'] }));

    inputWrapper.dispatchEvent(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    expect(overlay.hasClass('visible')).toBe(true);
  });

  it('extracts dropped files from markdown payload and deduplicates paths', () => {
    const event = createDragEvent(
      'drop',
      createDataTransfer({
        types: ['text/obsidian-markdown'],
        markdownData: 'markdown: [[notes/a.md]]\n[[notes/a.md]]\n[[notes/b.md]]',
      })
    );

    inputWrapper.dispatchEvent(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(droppedPaths).toEqual(['notes/a.md', 'notes/b.md']);
  });

  it('resolves linkpath aliases from metadata cache', () => {
    const event = createDragEvent(
      'drop',
      createDataTransfer({
        types: ['text/obsidian-markdown'],
        markdownData: 'markdown: [[alias-a]]',
      })
    );

    inputWrapper.dispatchEvent(event);

    expect(droppedPaths).toEqual(['notes/a.md']);
  });

  it('extracts dropped files from plain text payload lines', () => {
    const event = createDragEvent(
      'drop',
      createDataTransfer({
        types: ['text/plain'],
        plainTextData: 'notes/a.md\nnotes/b.md',
      })
    );

    inputWrapper.dispatchEvent(event);

    expect(droppedPaths).toEqual(['notes/a.md', 'notes/b.md']);
  });

  it('extracts dropped files from markdown link payload', () => {
    const event = createDragEvent(
      'drop',
      createDataTransfer({
        types: ['text/plain'],
        plainTextData: '[A](notes/a.md)\n[B](notes/b.md)',
      })
    );

    inputWrapper.dispatchEvent(event);

    expect(droppedPaths).toEqual(['notes/a.md', 'notes/b.md']);
  });

  it('handles drop when drop event type is Files but payload still has vault paths', () => {
    const dragEnterEvent = createDragEvent('dragenter', createDataTransfer({ types: ['text/obsidian-markdown'] }));
    inputWrapper.dispatchEvent(dragEnterEvent);

    const dropEvent = createDragEvent(
      'drop',
      createDataTransfer({
        types: ['Files'],
        markdownData: 'markdown: [[notes/a.md]]',
      })
    );

    inputWrapper.dispatchEvent(dropEvent);

    expect(droppedPaths).toEqual(['notes/a.md']);
  });

  it('uses dragManager.draggable to extract a single file on drop', () => {
    app.dragManager.draggable = { type: 'file', file: { path: 'notes/a.md' } };

    const event = createDragEvent('drop', createDataTransfer({ types: ['text/plain'], plainTextData: '' }));
    inputWrapper.dispatchEvent(event);

    expect(droppedPaths).toEqual(['notes/a.md']);
  });

  it('uses dragManager.draggable to extract multiple files on drop', () => {
    app.dragManager.draggable = {
      type: 'files',
      files: [{ path: 'notes/a.md' }, { path: 'notes/b.md' }],
    };

    const event = createDragEvent('drop', createDataTransfer({ types: ['text/plain'], plainTextData: '' }));
    inputWrapper.dispatchEvent(event);

    expect(droppedPaths).toEqual(['notes/a.md', 'notes/b.md']);
  });

  it('shows overlay when dragManager.draggable is a file (no dataTransfer types needed)', () => {
    app.dragManager.draggable = { type: 'file', file: { path: 'notes/a.md' } };
    const overlay = container.querySelector('.claudian-file-drop-overlay') as MockElement;

    const event = createDragEvent('dragenter', createDataTransfer({ types: [] }));
    inputWrapper.dispatchEvent(event);

    expect(overlay.hasClass('visible')).toBe(true);
  });

  it('dragManager takes priority over dataTransfer payload when both are present', () => {
    app.dragManager.draggable = { type: 'file', file: { path: 'notes/a.md' } };

    const event = createDragEvent(
      'drop',
      createDataTransfer({
        types: ['text/obsidian-markdown'],
        markdownData: 'markdown: [[notes/b.md]]',
      })
    );
    inputWrapper.dispatchEvent(event);

    // dragManager path wins; dataTransfer fallback is not reached
    expect(droppedPaths).toEqual(['notes/a.md']);
  });

  it('removes listeners on destroy', () => {
    manager.destroy();

    expect(inputWrapper.getEventListenerCount('dragenter')).toBe(0);
    expect(inputWrapper.getEventListenerCount('dragover')).toBe(0);
    expect(inputWrapper.getEventListenerCount('dragleave')).toBe(0);
    expect(inputWrapper.getEventListenerCount('drop')).toBe(0);
  });
});
