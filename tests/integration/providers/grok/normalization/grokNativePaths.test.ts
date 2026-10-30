import { createExecutionPathMapper } from '@/core/process/execution-target/WSLPathMapper';
import { mapGrokNativePaths } from '@/providers/grok/normalization/grokNativePaths';
import { normalizeGrokToolResultDetails } from '@/providers/grok/normalization/grokToolNormalization';

it('projects tool, diff and image paths before host consumers while preserving text and unknown fields', () => {
  const mapper = createExecutionPathMapper({ method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' });
  const update = mapGrokNativePaths({
    rawInput: { target_file: '/mnt/c/vault/note.md', unknown: '/keep/unknown' },
    rawOutput: { type: 'ImageGen', path: '/home/me/image.png', filename: 'image.png' },
    locations: [{ path: '/mnt/c/vault/note.md', line: 2 }],
    content: [{ type: 'diff', path: '/mnt/c/vault/note.md', oldText: '/keep/text' }],
  }, mapper);
  expect(update.rawInput).toEqual({ target_file: 'C:\\vault\\note.md', unknown: '/keep/unknown' });
  expect(update.locations[0].path).toBe('C:\\vault\\note.md');
  expect(update.content[0]).toMatchObject({ path: 'C:\\vault\\note.md', oldText: '/keep/text' });
  expect(update.rawOutput.path).toBe('\\\\wsl$\\Ubuntu\\home\\me\\image.png');
  expect(normalizeGrokToolResultDetails('image_gen', {}, update.rawOutput)?.resultImages)
    .toEqual([expect.objectContaining({ kind: 'file', path: '\\\\wsl$\\Ubuntu\\home\\me\\image.png' })]);
});

describe('structured path fields', () => {
  const mapper = createExecutionPathMapper({ method: 'wsl', distroName: 'Ubuntu', platformFamily: 'unix', platformOs: 'linux' });
  it.each(['path', 'file_path', 'filePath', 'target_file', 'absolute_path', 'target_directory', 'directory', 'cwd'])('projects %s', field => {
    expect(mapGrokNativePaths({ nested: [{ [field]: '/mnt/c/vault/a.md' }] }, mapper)).toEqual({ nested: [{ [field]: 'C:\\vault\\a.md' }] });
  });

  it('keeps non-string, relative and backslash-rooted path fields literal', () => {
    const update = {
      path: { value: '/mnt/c/vault/a.md' }, file_path: 7, cwd: 'relative/a.md', directory: null,
      target_directory: '\\\\server\\share\\a.md', absolute_path: '\\mnt\\c\\vault\\a.md',
    };
    expect(mapGrokNativePaths(update, mapper)).toEqual(structuredClone(update));
  });
});
