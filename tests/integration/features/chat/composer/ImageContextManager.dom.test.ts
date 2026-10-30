/** @vitest-environment jsdom */

import { axe } from '@test/helpers/accessibility';
import { createEvent, fireEvent, within } from '@testing-library/dom';
import { App } from 'obsidian';
import type { Mock } from 'vitest';

import { ImageContextManager } from '@/features/chat/composer/ImageContextManager';

let visibility: HTMLStyleElement;
let host: HTMLElement;
let wrapper: HTMLElement;
let input: HTMLTextAreaElement;
let manager: ImageContextManager;
let changed: Mock<() => void>;

function imagesChanged(count: number): Promise<void> {
  return new Promise(resolve => changed.mockImplementation(() => {
    if (manager.getAttachedImages().length === count) resolve();
  }));
}

function imageFile(name: string, type = 'image/png') {
  // jsdom has no File.arrayBuffer; byte reading is the browser boundary.
  return Object.assign(new File(['hello'], name, { type }), {
    arrayBuffer: vi.fn(async () => new TextEncoder().encode('hello').buffer),
  });
}

beforeEach(() => {
  visibility = document.head.appendChild(document.createElement('style'));
  visibility.textContent = '.claudian-hidden { display: none; }';
  host = document.body.createDiv();
  wrapper = host.createDiv({ cls: 'claudian-input-wrapper' });
  input = wrapper.createEl('textarea', { attr: { 'aria-label': 'Message' } });
  changed = vi.fn();
  manager = new ImageContextManager(new App().keymap, host, input, { onUserImagesChanged: changed });
});

afterEach(() => {
  manager.destroy();
  host.remove();
  visibility.remove();
});

it('reads supported dropped image extensions into ordered, removable context items', async () => {
  const entries = [
    ['photo.jpg', 'image/jpeg'], ['photo.jpeg', 'image/jpeg'], ['image.png', 'image/png'],
    ['animation.gif', 'image/gif'], ['photo.webp', 'image/webp'], ['PHOTO.JPG', 'image/jpeg'], ['image.Png', 'image/png'],
  ];
  const files = entries.map(([name]) => imageFile(name));
  fireEvent.dragEnter(wrapper, { dataTransfer: { types: ['Files'] } });
  const overlay = within(wrapper).getByText('Drop image here').closest('.claudian-drop-overlay')!;
  expect(overlay.classList.contains('visible')).toBe(true);
  const processed = imagesChanged(entries.length);
  const event = createEvent.drop(wrapper, { dataTransfer: { files } });
  fireEvent(wrapper, event);
  expect(event.defaultPrevented).toBe(true);
  expect(overlay.classList.contains('visible')).toBe(false);
  await processed;
  expect(manager.getAttachedImages()).toEqual(entries.map(([name, mediaType]) => expect.objectContaining({
    name, mediaType, source: 'drop', size: 5, data: 'aGVsbG8=',
  })));
  expect(changed).toHaveBeenCalledTimes(entries.length);
  expect(within(host).getAllByRole('button', { name: /^Image attachment:/ }).map(button => button.textContent))
    .toEqual(['Image 1', 'Image 2', 'Image 3', 'Image 4', 'Image 5', 'Image 6', 'Image 7']);
  fireEvent.click(within(host).getByRole('button', { name: 'Remove Image attachment: photo.jpg · 5 B' }));
  expect(manager.getAttachedImages().map(image => image.name)).toEqual(entries.slice(1).map(([name]) => name));
  expect(within(host).queryByRole('button', { name: 'Image attachment: photo.jpg · 5 B' })).toBeNull();
  expect(changed).toHaveBeenCalledTimes(entries.length + 1);
  expect(await axe(host)).toHaveNoViolations();
});

it('skips unsupported dropped names and MIME types before reading bytes while accepting the next image', async () => {
  const rejected = [imageFile('document.pdf', 'application/pdf'), imageFile('noextension'), imageFile('test.bmp', 'image/bmp')];
  const accepted = imageFile('valid.png');
  const processed = imagesChanged(1);
  fireEvent.drop(wrapper, { dataTransfer: { files: [...rejected, accepted] } });
  await processed;
  expect(within(host).getByRole('button', { name: 'Image attachment: valid.png · 5 B' })).toBeDefined();
  expect(manager.getAttachedImages()).toEqual([expect.objectContaining({ name: 'valid.png' })]);
  for (const file of rejected) expect(file.arrayBuffer).not.toHaveBeenCalled();
  expect(changed).toHaveBeenCalledTimes(1);
});

it('reads every image in a mixed clipboard batch and renders their retained order', async () => {
  const files = [imageFile('first.jpg', 'image/jpeg'), imageFile('second.png')];
  const event = createEvent.paste(input, { clipboardData: { items: [
    { type: 'image/jpeg', getAsFile: () => files[0] },
    { type: 'text/plain', getAsFile: () => null },
    { type: 'image/png', getAsFile: () => files[1] },
  ] } });
  const processed = imagesChanged(files.length);
  fireEvent(input, event);
  expect(event.defaultPrevented).toBe(true);
  await processed;
  expect(manager.getAttachedImages()).toEqual([
    expect.objectContaining({ name: 'first.jpg', mediaType: 'image/jpeg', source: 'paste', data: 'aGVsbG8=' }),
    expect.objectContaining({ name: 'second.png', mediaType: 'image/png', source: 'paste', data: 'aGVsbG8=' }),
  ]);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(within(host).getAllByRole('button', { name: /^Image attachment:/ }).map(button => button.getAttribute('aria-label')))
    .toEqual(['Image attachment: first.jpg · 5 B', 'Image attachment: second.png · 5 B']);
});
