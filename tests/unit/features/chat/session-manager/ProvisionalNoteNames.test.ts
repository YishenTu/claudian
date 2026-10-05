import { isProvisionalNotePath } from '@/features/chat/session-manager/ProvisionalNoteNames';

describe('isProvisionalNotePath', () => {
  it.each([
    ['Untitled.md', 'en'],
    ['Untitled 1.md', 'en'],
    ['Untitled 42.md', 'en'],
    ['未命名.md', 'zh'],
    ['未命名 2.md', 'zh-TW'],
    ['Notes/Sans titre 3.md', 'fr'],
  ])('recognizes the localized provisional note path %s', (path, language) => {
    expect(isProvisionalNotePath(path, language)).toBe(true);
  });

  it.each([
    ['Untitled project.md', 'en'],
    ['Untitled-1.md', 'en'],
    ['未命名项目.md', 'zh'],
    ['Sans titre final.md', 'fr'],
  ])('does not overmatch the ordinary note path %s', (path, language) => {
    expect(isProvisionalNotePath(path, language)).toBe(false);
  });
});
