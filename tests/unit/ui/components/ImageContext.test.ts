import { ImageContextManager } from '@/ui/components/ImageContext';

function createMockElement() {
  return {
    createDiv: jest.fn(() => createMockElement()),
    createSpan: jest.fn(() => createMockElement()),
    createEl: jest.fn(() => createMockElement()),
    setText: jest.fn(),
    setAttribute: jest.fn(),
    addClass: jest.fn(),
    removeClass: jest.fn(),
    empty: jest.fn(),
    querySelector: jest.fn(() => null),
    insertBefore: jest.fn(),
    style: {},
  } as any;
}

function createManager() {
  const app = {} as any;
  const containerEl = createMockElement();
  const inputEl = { addEventListener: jest.fn() } as any;
  const callbacks = { onImagesChanged: jest.fn() } as any;
  return new ImageContextManager(app, containerEl as any, inputEl as any, callbacks);
}

describe('ImageContextManager extractImagePath', () => {
  it('extracts quoted image paths', () => {
    const manager = createManager();
    expect(manager.extractImagePath('Here is "image.png"')).toBe('image.png');
    expect(manager.extractImagePath("Here is 'image.jpg'")).toBe('image.jpg');
  });

  it('extracts markdown image paths', () => {
    const manager = createManager();
    expect(manager.extractImagePath('![alt](path/to/image.png)')).toBe('path/to/image.png');
    expect(manager.extractImagePath('![alt](path/to/image.png "title")')).toBe('path/to/image.png');
    expect(manager.extractImagePath('![alt](<path/to/image.png>)')).toBe('path/to/image.png');
  });

  it('extracts Windows-style image paths', () => {
    const manager = createManager();
    expect(manager.extractImagePath('C:\\Users\\me\\img.jpg')).toBe('C:\\Users\\me\\img.jpg');
  });

  it('extracts MSYS-style image paths', () => {
    const manager = createManager();
    expect(manager.extractImagePath('/c/Users/me/img.webp')).toBe('/c/Users/me/img.webp');
  });

  it('ignores http URLs', () => {
    const manager = createManager();
    expect(manager.extractImagePath('https://example.com/image.png')).toBeNull();
  });

  it('parses file URLs into local paths', () => {
    const manager = createManager();
    expect(manager.extractImagePath('file:///C:/Users/me/image.png')).toBe('C:\\Users\\me\\image.png');
    expect(manager.extractImagePath('file://localhost/C:/Users/me/image.png')).toBe('C:\\Users\\me\\image.png');
    expect(manager.extractImagePath('file:///Users/me/image.png')).toBe('/Users/me/image.png');
    expect(manager.extractImagePath('file://server/share/image.png')).toBe('\\\\server\\share\\image.png');
    expect(manager.extractImagePath('file:///C:/Users/me/My%20Image.png')).toBe('C:\\Users\\me\\My Image.png');
    expect(manager.extractImagePath('file:///Users/me/My%20Image.png')).toBe('/Users/me/My Image.png');
    expect(manager.extractImagePath('file:///C:/Users/me/%ZZ.png')).toBeNull();
  });

  it('handles trailing punctuation', () => {
    const manager = createManager();
    expect(manager.extractImagePath('image.png)')).toBe('image.png');
    expect(manager.extractImagePath('image.png,')).toBe('image.png');
  });

  it('extracts HTML image src paths', () => {
    const manager = createManager();
    expect(manager.extractImagePath('<img src="path/to/image.png" />')).toBe('path/to/image.png');
    expect(manager.extractImagePath('<img alt="x" src=path/to/image.png>')).toBe('path/to/image.png');
    expect(manager.extractImagePath("<img src='C:\\\\Users\\\\me\\\\img.jpg'>")).toBe('C:\\\\Users\\\\me\\\\img.jpg');
  });

  it('skips URL tokens and returns the next image path', () => {
    const manager = createManager();
    expect(manager.extractImagePath('https://example.com/image.png and local.png')).toBe('local.png');
  });

  it('returns null for empty or non-image inputs', () => {
    const manager = createManager();
    expect(manager.extractImagePath('')).toBeNull();
    expect(manager.extractImagePath('document.pdf')).toBeNull();
  });

  it('handles malformed URL encoding gracefully', () => {
    const manager = createManager();
    // Incomplete percent-encoding
    expect(manager.extractImagePath('file:///C:/Users/me/%2.png')).toBeNull();
    // Invalid encoding at different positions
    expect(manager.extractImagePath('file:///C:/Users/me/%20%ZZ.png')).toBeNull();
    // Mixed valid and invalid encoding
    expect(manager.extractImagePath('file:///C:/Users/me/%2.png%20more.png')).toBeNull();
  });

  it('rejects paths with traversal attempts', () => {
    const manager = createManager();
    // Unix-style traversal
    expect(manager.extractImagePath('../../etc/passwd.jpg')).toBeNull();
    expect(manager.extractImagePath('/path/../../../etc/passwd.jpg')).toBeNull();
    // Windows-style traversal
    expect(manager.extractImagePath('..\\..\\windows\\system32\\img.jpg')).toBeNull();
    expect(manager.extractImagePath('C:\\path\\..\\..\\windows\\img.jpg')).toBeNull();
    // But allow legitimate paths with '..' in the middle (like '..' as part of a filename)
    // Note: This is a simple check that only looks for '../' and '..\' as prefixes
  });
});

describe('ImageContextManager handleImagePathInText', () => {
  it('removes file URLs from text when image loads', async () => {
    const manager = createManager();
    const addImageSpy = jest.spyOn(manager, 'addImageFromPath').mockResolvedValue(true);

    const result = await manager.handleImagePathInText('file:///C:/Users/me/image.png');

    expect(addImageSpy).toHaveBeenCalledWith('C:\\Users\\me\\image.png');
    expect(result).toEqual({ text: '', imageLoaded: true });
    addImageSpy.mockRestore();
  });
});
