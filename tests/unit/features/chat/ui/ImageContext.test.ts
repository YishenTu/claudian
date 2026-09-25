import { createMockEl } from '@test/helpers/MockElement';
import { testDate } from '@test/helpers/testClock';
import { Notice } from 'obsidian';

import type { ImageAttachment } from '@/core/types';
import { ImageContextManager } from '@/features/chat/ui/ImageContext';

jest.mock('obsidian', () => ({
  Notice: jest.fn(),
}));

// Mock document.createElementNS for SVG elements created in setupDragAndDrop
const mockSvgElement = () => {
  const el = createMockEl('svg');
  el.appendChild = jest.fn();
  return el;
};

beforeAll(() => {
  if (typeof globalThis.document === 'undefined') {
    (globalThis as any).document = {};
  }
  (globalThis.document as any).createElementNS = jest.fn(() => mockSvgElement());
});

function createMockCallbacks() {
  return {
    onUserImagesChanged: jest.fn(),
  };
}

function createContainerWithInputWrapper(): { container: any; inputWrapper: any } {
  const container = createMockEl();
  const inputWrapper = container.createDiv({ cls: 'claudian-input-wrapper' });
  return { container, inputWrapper };
}

function createMockTextArea(): any {
  const el = createMockEl('textarea');
  el.value = '';
  return el;
}

function createImageAttachment(overrides: Partial<ImageAttachment> = {}): ImageAttachment {
  return {
    id: 'img-test-1',
    name: 'test.png',
    mediaType: 'image/png',
    data: 'dGVzdA==',
    size: 1024,
    source: 'paste',
    ...overrides,
  };
}

describe('ImageContextManager', () => {
  let container: any;
  let inputEl: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;
  let manager: ImageContextManager;

  beforeEach(() => {
    jest.clearAllMocks();
    const { container: c } = createContainerWithInputWrapper();
    container = c;
    inputEl = createMockTextArea();
    callbacks = createMockCallbacks();
    manager = new ImageContextManager(container, inputEl, callbacks);
  });

  describe('initial state', () => {
    it('should start with no images', () => {
      expect(manager.hasImages()).toBe(false);
      expect(manager.getAttachedImages()).toEqual([]);
    });
  });


  describe('clearImages', () => {
    it('should remove all images', () => {
      manager.setImages([
        createImageAttachment({ id: 'img-1' }),
        createImageAttachment({ id: 'img-2' }),
      ]);
      expect(manager.hasImages()).toBe(true);

      expect(container.querySelector('.claudian-context-row').hasClass('has-content')).toBe(true);
      manager.clearImages();
      expect(manager.hasImages()).toBe(false);
      expect(manager.getAttachedImages()).toEqual([]);
      expect(container.querySelector('.claudian-context-row').hasClass('has-content')).toBe(false);
    });
  });

  describe('setImages', () => {
    it('should replace existing images', () => {
      manager.setImages([createImageAttachment({ id: 'old' })]);

      const newImages = [
        createImageAttachment({ id: 'new-1', name: 'new1.png' }),
        createImageAttachment({ id: 'new-2', name: 'new2.jpg' }),
      ];
      manager.setImages(newImages);

      const result = manager.getAttachedImages();
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('new-1');
      expect(result[1].id).toBe('new-2');
    });

    it('should handle empty array', () => {
      manager.setImages([createImageAttachment()]);
      manager.setImages([]);

      expect(manager.hasImages()).toBe(false);
      expect(manager.getAttachedImages()).toEqual([]);
    });

    it('should deduplicate by id (last wins)', () => {
      const images = [
        createImageAttachment({ id: 'same', name: 'first.png' }),
        createImageAttachment({ id: 'same', name: 'second.png' }),
      ];
      manager.setImages(images);

      const result = manager.getAttachedImages();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('second.png');
    });
  });

  describe('constructor with previewContainerEl', () => {

    it('should preserve existing preview container content', () => {
      const previewContainer = createMockEl();
      const existingContent = previewContainer.createDiv({ cls: 'existing-preview-content' });

      const { container: c } = createContainerWithInputWrapper();
      const input = createMockTextArea();
      const cb = createMockCallbacks();

      new ImageContextManager(c, input, cb, previewContainer);
      expect(previewContainer.children).toContain(existingContent);
      expect(previewContainer.querySelector('.claudian-context-row')).not.toBeNull();
    });
  });
});

// Test private helper methods via their observable effects.
// We access privates through any cast, matching the project's pattern.
describe('ImageContextManager - Private Helpers', () => {
  let manager: any;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    jest.clearAllMocks();
    const { container } = createContainerWithInputWrapper();
    const inputEl = createMockTextArea();
    callbacks = createMockCallbacks();
    manager = new ImageContextManager(container, inputEl, callbacks);
  });

  describe('getMediaType', () => {
    it('should return correct media type for .jpg', () => {
      expect(manager['getMediaType']('photo.jpg')).toBe('image/jpeg');
    });

    it('should return correct media type for .jpeg', () => {
      expect(manager['getMediaType']('photo.jpeg')).toBe('image/jpeg');
    });

    it('should return correct media type for .png', () => {
      expect(manager['getMediaType']('image.png')).toBe('image/png');
    });

    it('should return correct media type for .gif', () => {
      expect(manager['getMediaType']('animation.gif')).toBe('image/gif');
    });

    it('should return correct media type for .webp', () => {
      expect(manager['getMediaType']('photo.webp')).toBe('image/webp');
    });

    it('should return null for unsupported extension', () => {
      expect(manager['getMediaType']('document.pdf')).toBeNull();
    });

    it('should return null for no extension', () => {
      expect(manager['getMediaType']('noextension')).toBeNull();
    });

    it('should handle uppercase extensions', () => {
      expect(manager['getMediaType']('PHOTO.JPG')).toBe('image/jpeg');
    });

    it('should handle mixed case extensions', () => {
      expect(manager['getMediaType']('image.Png')).toBe('image/png');
    });
  });

  describe('isImageFile', () => {
    it('should return true for valid image file', () => {
      const file = { type: 'image/png', name: 'test.png' } as File;
      expect(manager['isImageFile'](file)).toBe(true);
    });

    it('should return false for non-image file', () => {
      const file = { type: 'application/pdf', name: 'doc.pdf' } as File;
      expect(manager['isImageFile'](file)).toBe(false);
    });

    it('should return false for image type but unsupported extension', () => {
      const file = { type: 'image/bmp', name: 'test.bmp' } as File;
      expect(manager['isImageFile'](file)).toBe(false);
    });
  });

  describe('notifyImageError', () => {
    it('should create a Notice with the message', () => {
      manager['notifyImageError']('Test error');
      expect(Notice).toHaveBeenCalledWith('Test error');
    });

    it('should append file not found for ENOENT error', () => {
      const error = new Error('ENOENT: no such file or directory');
      manager['notifyImageError']('Failed to load image.', error);
      expect(Notice).toHaveBeenCalledWith('Failed to load image. (File not found)');
    });

    it('should append permission denied for EACCES error', () => {
      const error = new Error('EACCES: permission denied');
      manager['notifyImageError']('Failed to load image.', error);
      expect(Notice).toHaveBeenCalledWith('Failed to load image. (Permission denied)');
    });

    it('should use original message for non-Error objects', () => {
      manager['notifyImageError']('Test error', 'not an error object');
      expect(Notice).toHaveBeenCalledWith('Test error');
    });

    it('should use original message for errors without recognized patterns', () => {
      const error = new Error('Some other error');
      manager['notifyImageError']('Test error', error);
      expect(Notice).toHaveBeenCalledWith('Test error');
    });
  });

  describe('addImageFromFile', () => {
    it('should reject files exceeding size limit', async () => {
      const file = {
        name: 'huge.png',
        type: 'image/png',
        size: 6 * 1024 * 1024, // 6MB > 5MB limit
        arrayBuffer: jest.fn(),
      } as unknown as File;

      const result = await manager['addImageFromFile'](file, 'paste');
      expect(result).toBe(false);
      expect(Notice).toHaveBeenCalledWith(expect.stringContaining('limit'));
    });

    it('should reject files with unsupported media type', async () => {
      const file = {
        name: 'test.bmp',
        type: '',
        size: 1024,
        arrayBuffer: jest.fn(),
      } as unknown as File;

      const result = await manager['addImageFromFile'](file, 'drop');
      expect(result).toBe(false);
      expect(Notice).toHaveBeenCalledWith('Unsupported image type.');
    });

    it('should add valid image file and invoke callback', async () => {
      const file = {
        name: 'test.png',
        type: 'image/png',
        size: 5,
        arrayBuffer: jest.fn().mockResolvedValue(new TextEncoder().encode('hello').buffer),
      } as unknown as File;
      const now = jest.spyOn(Date, 'now').mockReturnValue(testDate().getTime());

      try {
        const result = await manager['addImageFromFile'](file, 'paste');
        expect(result).toBe(true);
        expect(manager.hasImages()).toBe(true);
        expect(callbacks.onUserImagesChanged).toHaveBeenCalledTimes(1);

        const images = manager.getAttachedImages();
        expect(images).toHaveLength(1);
        expect(images[0]).toEqual({
          id: expect.stringMatching(/^img-/),
          name: 'test.png',
          mediaType: 'image/png',
          data: 'aGVsbG8=',
          size: 5,
          source: 'paste',
        });

        expect(await manager['addImageFromFile'](file, 'paste')).toBe(true);
        const repeatedImages = manager.getAttachedImages();
        expect(repeatedImages).toHaveLength(2);
        expect(repeatedImages[1].id).toMatch(/^img-/);
        expect(repeatedImages[1].id).not.toBe(images[0].id);
        expect(callbacks.onUserImagesChanged).toHaveBeenCalledTimes(2);
      } finally {
        now.mockRestore();
      }
    });

    it('should handle arrayBuffer failure gracefully', async () => {
      const file = {
        name: 'test.png',
        type: 'image/png',
        size: 1024,
        arrayBuffer: jest.fn().mockRejectedValue(new Error('Read failed')),
      } as unknown as File;

      const result = await manager['addImageFromFile'](file, 'drop');
      expect(result).toBe(false);
      expect(Notice).toHaveBeenCalledWith('Failed to attach image.');
    });

    it('should generate default name when file has no name', async () => {
      const mockBuffer = new ArrayBuffer(4);
      const file = {
        name: '',
        type: 'image/png',
        size: 512,
        arrayBuffer: jest.fn().mockResolvedValue(mockBuffer),
      } as unknown as File;

      const callbacks = createMockCallbacks();
      const { container } = createContainerWithInputWrapper();
      const inputEl = createMockTextArea();
      const mgr: any = new ImageContextManager(container, inputEl, callbacks);

      await mgr['addImageFromFile'](file, 'paste');
      const images = mgr.getAttachedImages();
      expect(images[0].name).toMatch(/^image-\d+\.png$/);
    });

    it('should use file.type as fallback media type when getMediaType returns null', async () => {
      const mockBuffer = new ArrayBuffer(4);
      // File with .svg extension (not in IMAGE_EXTENSIONS), but valid image/* type
      const file = {
        name: 'icon.svg',
        type: 'image/svg+xml',
        size: 512,
        arrayBuffer: jest.fn().mockResolvedValue(mockBuffer),
      } as unknown as File;

      // The getMediaType for .svg returns null, so file.type is used as fallback
      const callbacks = createMockCallbacks();
      const { container } = createContainerWithInputWrapper();
      const inputEl = createMockTextArea();
      const mgr: any = new ImageContextManager(container, inputEl, callbacks);

      const result = await mgr['addImageFromFile'](file, 'paste');
      expect(result).toBe(true);

      const images = mgr.getAttachedImages();
      expect(images[0].mediaType).toBe('image/svg+xml');
    });
  });

  describe('Drag and Drop handlers', () => {
    it('handleDragEnter should show overlay when dragging files', () => {
      const event = {
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
        dataTransfer: { types: ['Files'] },
      };

      manager['handleDragEnter'](event as any);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
      expect(manager['dropOverlay']?.hasClass('visible')).toBe(true);
    });

    it('handleDragEnter should not show overlay when not dragging files', () => {
      const event = {
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
        dataTransfer: { types: ['text/plain'] },
      };

      manager['handleDragEnter'](event as any);

      expect(manager['dropOverlay']?.hasClass('visible')).toBeFalsy();
    });

    it('handleDragOver should prevent default', () => {
      const event = {
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
      };

      manager['handleDragOver'](event as any);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    it('handleDragLeave should hide overlay when cursor leaves input wrapper', () => {
      // Show overlay first
      manager['dropOverlay']?.addClass('visible');

      const event = {
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
        clientX: -1, // Outside bounds
        clientY: -1,
      };

      manager['handleDragLeave'](event as any);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(manager['dropOverlay']?.hasClass('visible')).toBe(false);
    });

    it('handleDrop should hide overlay and process image files', async () => {
      manager['dropOverlay']?.addClass('visible');
      const addImageSpy = jest.spyOn(manager as any, 'addImageFromFile').mockResolvedValue(true);

      const mockFile = { type: 'image/png', name: 'test.png', size: 1024 };
      const event = {
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
        dataTransfer: { files: { length: 1, 0: mockFile, [Symbol.iterator]: function* () { yield mockFile; } } },
      };

      await manager['handleDrop'](event as any);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(manager['dropOverlay']?.hasClass('visible')).toBe(false);
      expect(addImageSpy).toHaveBeenCalledWith(mockFile, 'drop');

      addImageSpy.mockRestore();
    });

    it('handleDrop should skip non-image files', async () => {
      const addImageSpy = jest.spyOn(manager as any, 'addImageFromFile').mockResolvedValue(true);
      jest.spyOn(manager as any, 'isImageFile').mockReturnValue(false);

      const mockFile = { type: 'application/pdf', name: 'doc.pdf', size: 1024 };
      const event = {
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
        dataTransfer: { files: { length: 1, 0: mockFile } },
      };

      await manager['handleDrop'](event as any);

      expect(addImageSpy).not.toHaveBeenCalled();
      addImageSpy.mockRestore();
    });

    it('handleDrop should handle no files gracefully', async () => {
      const event = {
        preventDefault: jest.fn(),
        stopPropagation: jest.fn(),
        dataTransfer: { files: undefined },
      };

      await manager['handleDrop'](event as any);
      // Should not throw and still call preventDefault
      expect(event.preventDefault).toHaveBeenCalled();
    });
  });

  describe('Paste handler', () => {

    it('paste handler should process image items', async () => {
      const addImageSpy = jest.spyOn(manager as any, 'addImageFromFile').mockResolvedValue(true);
      const mockFile = { name: 'pasted.png', type: 'image/png', size: 1024 };
      const pasteEvent = {
        type: 'paste',
        preventDefault: jest.fn(),
        clipboardData: {
          items: {
            length: 1,
            0: {
              type: 'image/png',
              getAsFile: () => mockFile,
            },
          },
        },
      };

      manager['inputEl'].dispatchEvent(pasteEvent);
      // Wait for async paste handler
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(pasteEvent.preventDefault).toHaveBeenCalled();
      expect(addImageSpy).toHaveBeenCalledWith(mockFile, 'paste');
      addImageSpy.mockRestore();
    });

    it('paste handler should ignore non-image items', async () => {
      const addImageSpy = jest.spyOn(manager as any, 'addImageFromFile').mockResolvedValue(true);
      const pasteEvent = {
        type: 'paste',
        preventDefault: jest.fn(),
        clipboardData: {
          items: {
            length: 1,
            0: {
              type: 'text/plain',
              getAsFile: () => null,
            },
          },
        },
      };

      manager['inputEl'].dispatchEvent(pasteEvent);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(pasteEvent.preventDefault).not.toHaveBeenCalled();
      expect(addImageSpy).not.toHaveBeenCalled();
      addImageSpy.mockRestore();
    });

    it('paste handler should handle null clipboardData', async () => {
      const addImageSpy = jest.spyOn(manager as any, 'addImageFromFile').mockResolvedValue(true);
      const pasteEvent = {
        type: 'paste',
        preventDefault: jest.fn(),
        clipboardData: null,
      };

      manager['inputEl'].dispatchEvent(pasteEvent);
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(addImageSpy).not.toHaveBeenCalled();
      addImageSpy.mockRestore();
    });

    it('does not attach a pasted image after destruction begins', async () => {
      let resolveBuffer!: (value: ArrayBuffer) => void;
      const arrayBuffer = new Promise<ArrayBuffer>((resolve) => {
        resolveBuffer = resolve;
      });
      const mockFile = {
        name: 'pasted.png',
        type: 'image/png',
        size: 1024,
        arrayBuffer: jest.fn(() => arrayBuffer),
      };
      const pasteEvent = {
        type: 'paste',
        preventDefault: jest.fn(),
        clipboardData: {
          items: {
            length: 1,
            0: {
              type: 'image/png',
              getAsFile: () => mockFile,
            },
          },
        },
      };

      manager['inputEl'].dispatchEvent(pasteEvent);
      expect(mockFile.arrayBuffer).toHaveBeenCalledTimes(1);
      manager.destroy();
      resolveBuffer(new ArrayBuffer(4));
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await Promise.resolve();
      }

      expect(manager.getAttachedImages()).toEqual([]);
      expect(callbacks.onUserImagesChanged).not.toHaveBeenCalled();
    });
  });

  describe('destroy', () => {
    it('unregisters paste and drag/drop listeners', () => {
      const inputWrapper = manager['containerEl'].querySelector('.claudian-input-wrapper');
      const inputEl = manager['inputEl'];

      expect(inputEl.getEventListenerCount('paste')).toBe(1);
      expect(inputWrapper.getEventListenerCount('dragenter')).toBe(1);
      expect(inputWrapper.getEventListenerCount('dragover')).toBe(1);
      expect(inputWrapper.getEventListenerCount('dragleave')).toBe(1);
      expect(inputWrapper.getEventListenerCount('drop')).toBe(1);

      manager.destroy();

      expect(inputEl.getEventListenerCount('paste')).toBe(0);
      expect(inputWrapper.getEventListenerCount('dragenter')).toBe(0);
      expect(inputWrapper.getEventListenerCount('dragover')).toBe(0);
      expect(inputWrapper.getEventListenerCount('dragleave')).toBe(0);
      expect(inputWrapper.getEventListenerCount('drop')).toBe(0);
    });
  });

  describe('Image context rendering', () => {

    it('opens an image preview from the rendered attachment control and closes it on destroy', () => {
      const overlayEl = createMockEl();
      const removeOverlay = jest.spyOn(overlayEl, 'remove');
      const mockBody = { createDiv: jest.fn().mockReturnValue(overlayEl) };
      const originalDocument = globalThis.document;
      (globalThis as any).document = {
        activeElement: null,
        body: mockBody,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      };

      try {
        manager.setImages([createImageAttachment({ name: 'photo.png' })]);
        const previewButton = manager['contextTray']['containerEl']
          .querySelector('.claudian-context-chip-main');

        expect(previewButton.tagName).toBe('BUTTON');
        previewButton.click();
        expect(mockBody.createDiv).toHaveBeenCalledWith({
          cls: 'claudian-image-modal-overlay',
        });

        manager.destroy();
        expect(removeOverlay).toHaveBeenCalledTimes(1);
      } finally {
        (globalThis as any).document = originalDocument;
      }
    });

    it.each([
      [500, '500 B'],
      [2048, '2.0 KB'],
      [5 * 1024 * 1024, '5.0 MB'],
      [1536, '1.5 KB'],
      [0, '0 B'],
    ])('renders a compact image pill with size %s and no thumbnail', (size, expectedSize) => {
      manager.setImages([createImageAttachment({ id: 'img-1', name: 'photo.png', size })]);

      const trayEl = manager['contextTray']['containerEl'];
      expect(trayEl.hasClass('has-content')).toBe(true);
      const chipEl = trayEl.querySelector('.claudian-context-chip--image');
      expect(chipEl).not.toBeNull();
      expect(chipEl.querySelector('.claudian-context-chip-main').getAttribute('title'))
        .toBe(`photo.png · ${expectedSize}`);

      const thumbEl = chipEl.querySelector('.claudian-context-chip-thumbnail');
      expect(thumbEl).toBeNull();

      const labelEl = chipEl.querySelector('.claudian-context-chip-label');
      expect(labelEl?.textContent).toBe('Image');

      const removeEl = chipEl.querySelector('.claudian-context-chip-remove');
      expect(removeEl).not.toBeNull();
    });

    it('numbers image pills in attachment order when more than one image is attached', () => {
      manager.setImages([
        createImageAttachment({ id: 'img-1', name: 'first.png' }),
        createImageAttachment({ id: 'img-2', name: 'second.png' }),
      ]);

      const trayEl = manager['contextTray']['containerEl'];
      const labels = trayEl.querySelectorAll('.claudian-context-chip-label');

      expect(labels.map((label: any) => label.textContent)).toEqual(['Image 1', 'Image 2']);
    });

    it('remove button should delete the image and update preview', () => {
      const cb = createMockCallbacks();
      const { container } = createContainerWithInputWrapper();
      const input = createMockTextArea();
      const mgr: any = new ImageContextManager(container, input, cb);

      mgr.setImages([
        createImageAttachment({ id: 'img-1', name: 'a.png' }),
        createImageAttachment({ id: 'img-2', name: 'b.png' }),
      ]);
      expect(mgr.getAttachedImages()).toHaveLength(2);

      const trayEl = mgr['contextTray']['containerEl'];
      const firstChip = trayEl.querySelector('.claudian-context-chip--image');
      const removeEl = firstChip.querySelector('.claudian-context-chip-remove');
      removeEl.dispatchEvent({ type: 'click', stopPropagation: jest.fn() });

      expect(mgr.getAttachedImages()).toHaveLength(1);
      expect(mgr.getAttachedImages()[0].id).toBe('img-2');
      expect(cb.onUserImagesChanged).toHaveBeenCalledTimes(1);
    });
  });

});
