// @test-ci {"native":true}
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { isPathWithinRoot } from '@/core/storage/pathContainment';

const describePosix = process.platform === 'win32' ? describe.skip : describe;
const describeWindows = process.platform === 'win32' ? describe : describe.skip;

describe('isPathWithinRoot', () => {
  it('uses path segments instead of string prefixes', () => {
    expect(isPathWithinRoot('/home/user/.codex/sessions/a.jsonl', '/home/user/.codex/sessions')).toBe(true);
    expect(isPathWithinRoot('/home/user/.codex/sessions-evil/a.jsonl', '/home/user/.codex/sessions')).toBe(false);
    expect(isPathWithinRoot('/home/user/.codex/sessions/../secrets/a.jsonl', '/home/user/.codex/sessions')).toBe(false);
  });

  it('supports Windows drive and UNC paths independently of the host platform', () => {
    expect(isPathWithinRoot('C:\\Users\\me\\.codex\\sessions\\a.jsonl', 'C:\\Users\\me\\.codex\\sessions')).toBe(true);
    expect(isPathWithinRoot('D:\\Users\\me\\.codex\\sessions\\a.jsonl', 'C:\\Users\\me\\.codex\\sessions')).toBe(false);
    expect(isPathWithinRoot('\\\\wsl$\\Ubuntu\\home\\me\\.codex\\sessions\\a.jsonl', '\\\\wsl$\\Ubuntu\\home\\me\\.codex\\sessions')).toBe(true);
    expect(isPathWithinRoot('\\\\wsl$\\Other\\home\\me\\.codex\\sessions\\a.jsonl', '\\\\wsl$\\Ubuntu\\home\\me\\.codex\\sessions')).toBe(false);
    expect(isPathWithinRoot('//server/share/child.jsonl', '//server/share')).toBe(true);
    expect(isPathWithinRoot('//server\\share\\child.jsonl', '//server\\share')).toBe(true);
    expect(isPathWithinRoot('//server\\other\\child.jsonl', '//server\\share')).toBe(false);
    expect(isPathWithinRoot('//server\\share-evil\\child.jsonl', '//server\\share')).toBe(false);
  });

  describePosix('literal POSIX filenames', () => {
    it.each(['root', 'root\\sessions'])('accepts a literal backslash filename under %s', rootName => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-posix-path-'));
      try {
        const root = path.join(tempDir, rootName);
        const candidate = path.join(root, 'turn\\notes.jsonl');
        fs.mkdirSync(root);
        fs.writeFileSync(candidate, 'Contained history');

        expect(fs.statSync(candidate).isFile()).toBe(true);
        expect(isPathWithinRoot(candidate, root)).toBe(true);
        expect(fs.readFileSync(candidate, 'utf8')).toBe('Contained history');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('rejects sibling, traversal and symlink escapes from a backslash-bearing root', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-posix-escape-'));
      try {
        const root = path.join(tempDir, 'root\\sessions');
        const sibling = `${root}-sibling`;
        const outside = path.join(tempDir, 'outside');
        fs.mkdirSync(root);
        fs.mkdirSync(sibling);
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(sibling, 'session.jsonl'), 'Sibling');
        fs.writeFileSync(path.join(outside, 'session.jsonl'), 'Outside');
        fs.symlinkSync(outside, path.join(root, 'escape'));

        expect(isPathWithinRoot(path.join(sibling, 'session.jsonl'), root)).toBe(false);
        expect(isPathWithinRoot(path.join(root, '..', 'outside', 'session.jsonl'), root)).toBe(false);
        expect(isPathWithinRoot(path.join(root, 'escape', 'session.jsonl'), root)).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describeWindows('native root-relative paths', () => {
    it('resolves mixed-separator paths on the host before checking containment', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-win-path-'));
      const originalCwd = process.cwd();
      try {
        process.chdir(tempDir);
        const root = path.join(tempDir, 'root');
        const outside = path.join(tempDir, 'outside');
        fs.mkdirSync(root);
        fs.mkdirSync(outside);
        fs.writeFileSync(path.join(root, 'inside.jsonl'), 'Inside');
        fs.writeFileSync(path.join(outside, 'session.jsonl'), 'Outside');
        fs.symlinkSync(outside, path.join(root, 'escape'), 'junction');
        const rootRelative = root.replace(/^[A-Za-z]:[\\/]/, '/');

        expect(fs.statSync(`${rootRelative}/inside.jsonl`).isFile()).toBe(true);
        expect(isPathWithinRoot(`${rootRelative}/inside.jsonl`, rootRelative)).toBe(true);
        expect(isPathWithinRoot(`${rootRelative}/escape/session.jsonl`, rootRelative)).toBe(false);
        expect(isPathWithinRoot(`${rootRelative}/escape/missing/session.jsonl`, rootRelative)).toBe(false);
        expect(isPathWithinRoot(`${rootRelative}/missing/session.jsonl`, rootRelative)).toBe(true);
      } finally {
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describePosix('missing descendants of symlinked directories', () => {
    it.each(['escape', 'alias candidate', 'alias root'])(
      'resolves the existing ancestor before admitting a missing history path: %s', scenario => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-missing-history-'));
      try {
        const root = path.join(tempDir, 'root');
        const outside = path.join(tempDir, 'outside');
        const alias = path.join(tempDir, 'alias');
        fs.mkdirSync(root);
        fs.mkdirSync(outside);
        fs.symlinkSync(outside, path.join(root, 'escape'));
        fs.symlinkSync(root, alias);

        const candidate = scenario === 'escape'
          ? path.join(root, 'escape', 'missing', 'session.jsonl')
          : path.join(scenario === 'alias candidate' ? alias : root, 'missing', 'session.jsonl');
        expect(isPathWithinRoot(candidate, scenario === 'alias root' ? alias : root))
          .toBe(scenario !== 'escape');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  it('rejects an existing symlink that escapes the trusted root', () => {
    if (process.platform === 'win32') return;

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudian-path-trust-'));
    const root = path.join(tempDir, 'root');
    const outside = path.join(tempDir, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'session.jsonl'), '{}');
    fs.symlinkSync(outside, path.join(root, 'escape'));

    expect(isPathWithinRoot(path.join(root, 'escape', 'session.jsonl'), root)).toBe(false);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});
