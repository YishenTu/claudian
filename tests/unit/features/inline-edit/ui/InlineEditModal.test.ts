/**
 * Tests for InlineEditModal - Word-level diff utilities
 *
 * Note: The computeDiff and diffToHtml functions are internal to InlineEditModal.
 * These tests use copied implementations to verify the algorithm behavior.
 * Consider extracting these to a shared module for direct testing.
 */

import { escapeHtml, normalizeInsertionText } from '@/utils/inlineEdit';
import { normalizePathForVault } from '@/utils/path';

// Copy of the diff algorithm from InlineEditModal for testing
interface DiffOp {
  type: 'equal' | 'insert' | 'delete';
  text: string;
}

function computeDiff(oldText: string, newText: string): DiffOp[] {
  const oldWords = oldText.split(/(\s+)/);
  const newWords = newText.split(/(\s+)/);
  const m = oldWords.length,
    n = newWords.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        oldWords[i - 1] === newWords[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = m,
    j = n;
  const temp: DiffOp[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      temp.push({ type: 'equal', text: oldWords[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      temp.push({ type: 'insert', text: newWords[j - 1] });
      j--;
    } else {
      temp.push({ type: 'delete', text: oldWords[i - 1] });
      i--;
    }
  }

  temp.reverse();
  for (const op of temp) {
    if (ops.length > 0 && ops[ops.length - 1].type === op.type) {
      ops[ops.length - 1].text += op.text;
    } else {
      ops.push({ ...op });
    }
  }
  return ops;
}

function diffToHtml(ops: DiffOp[]): string {
  return ops
    .map((op) => {
      const escaped = op.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      switch (op.type) {
        case 'delete':
          return `<span class="claudian-diff-del">${escaped}</span>`;
        case 'insert':
          return `<span class="claudian-diff-ins">${escaped}</span>`;
        default:
          return escaped;
      }
    })
    .join('');
}

describe('InlineEditModal - Insertion Newline Trimming', () => {
  describe('normalizeInsertionText', () => {
    it('should remove leading newlines', () => {
      const input = '\n\nContent here';
      const result = normalizeInsertionText(input);
      expect(result).toBe('Content here');
    });

    it('should remove trailing newlines', () => {
      const input = 'Content here\n\n';
      const result = normalizeInsertionText(input);
      expect(result).toBe('Content here');
    });

    it('should remove both leading and trailing newlines', () => {
      const input = '\n\nContent here\n\n';
      const result = normalizeInsertionText(input);
      expect(result).toBe('Content here');
    });

    it('should preserve internal newlines', () => {
      const input = '\n## Section\n\nParagraph content\n';
      const result = normalizeInsertionText(input);
      expect(result).toBe('## Section\n\nParagraph content');
    });

    it('should handle text with no newlines', () => {
      const input = 'Simple text';
      const result = normalizeInsertionText(input);
      expect(result).toBe('Simple text');
    });

    it('should handle only newlines', () => {
      const input = '\n\n\n';
      const result = normalizeInsertionText(input);
      expect(result).toBe('');
    });

    it('should handle empty string', () => {
      const input = '';
      const result = normalizeInsertionText(input);
      expect(result).toBe('');
    });

    it('should not trim spaces (only newlines)', () => {
      const input = '  Content with spaces  ';
      const result = normalizeInsertionText(input);
      expect(result).toBe('  Content with spaces  ');
    });

    it('should handle multiline markdown content', () => {
      const input = '\n## Description\n\nThis project provides tools for managing notes.\n\n### Features\n- Feature 1\n- Feature 2\n';
      const result = normalizeInsertionText(input);
      expect(result).toBe('## Description\n\nThis project provides tools for managing notes.\n\n### Features\n- Feature 1\n- Feature 2');
    });

    it('should handle code blocks with newlines', () => {
      const input = '\n```javascript\nconst x = 1;\n```\n';
      const result = normalizeInsertionText(input);
      expect(result).toBe('```javascript\nconst x = 1;\n```');
    });

    it('should handle CRLF newlines', () => {
      const input = '\r\n\r\nContent\r\n';
      const result = normalizeInsertionText(input);
      expect(result).toBe('Content');
    });
  });
});

describe('inlineEditUtils - escapeHtml', () => {
  it('should escape angle brackets', () => {
    expect(escapeHtml('a < b && c > d')).toBe('a &lt; b && c &gt; d');
  });

  it('should leave ampersands untouched (matching current preview behavior)', () => {
    expect(escapeHtml('a & b')).toBe('a & b');
  });

  it('should handle empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('InlineEditModal - Word-level Diff', () => {
  describe('computeDiff', () => {
    it('should return equal for identical text', () => {
      const result = computeDiff('hello world', 'hello world');

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('equal');
      expect(result[0].text).toBe('hello world');
    });

    it('should detect single word replacement', () => {
      const result = computeDiff('hello world', 'hello universe');

      const types = result.map((op) => op.type);
      expect(types).toContain('equal');
      expect(types).toContain('delete');
      expect(types).toContain('insert');

      const deleted = result.find((op) => op.type === 'delete');
      const inserted = result.find((op) => op.type === 'insert');
      expect(deleted?.text).toBe('world');
      expect(inserted?.text).toBe('universe');
    });

    it('should detect word insertion', () => {
      const result = computeDiff('hello world', 'hello beautiful world');

      const inserted = result.find((op) => op.type === 'insert');
      expect(inserted).toBeDefined();
      expect(inserted?.text).toContain('beautiful');
    });

    it('should detect word deletion', () => {
      const result = computeDiff('hello beautiful world', 'hello world');

      const deleted = result.find((op) => op.type === 'delete');
      expect(deleted).toBeDefined();
      expect(deleted?.text).toContain('beautiful');
    });

    it('should handle complete replacement', () => {
      const result = computeDiff('foo bar baz', 'one two three');

      const deleted = result.filter((op) => op.type === 'delete');
      const inserted = result.filter((op) => op.type === 'insert');

      expect(deleted.length).toBeGreaterThan(0);
      expect(inserted.length).toBeGreaterThan(0);
    });

    it('should preserve whitespace in diff', () => {
      const result = computeDiff('a  b', 'a   b');

      // The diff should handle different amounts of whitespace
      expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('should handle empty old text', () => {
      const result = computeDiff('', 'new text');

      const inserted = result.filter((op) => op.type === 'insert');
      expect(inserted.length).toBeGreaterThan(0);
    });

    it('should handle empty new text', () => {
      const result = computeDiff('old text', '');

      const deleted = result.filter((op) => op.type === 'delete');
      expect(deleted.length).toBeGreaterThan(0);
    });

    it('should merge consecutive operations of same type', () => {
      const result = computeDiff('a b c', 'x y z');

      // Should merge consecutive deletes and inserts
      const types = result.map((op) => op.type);
      // Check no two consecutive same types (they should be merged)
      for (let i = 1; i < types.length; i++) {
        if (types[i] === types[i - 1] && types[i] !== 'equal') {
          // Whitespace might separate merged ops
          // eslint-disable-next-line jest/no-conditional-expect
          expect(result[i - 1].text.trim() || result[i].text.trim()).toBeTruthy();
        }
      }
    });

    it('should handle text with punctuation', () => {
      const result = computeDiff('Hello, world!', 'Hello, universe!');

      const deleted = result.find((op) => op.type === 'delete');
      const inserted = result.find((op) => op.type === 'insert');

      expect(deleted?.text).toContain('world');
      expect(inserted?.text).toContain('universe');
    });

    it('should handle text with newlines', () => {
      const result = computeDiff('line1\nline2', 'line1\nmodified');

      const deleted = result.find((op) => op.type === 'delete');
      const inserted = result.find((op) => op.type === 'insert');

      expect(deleted).toBeDefined();
      expect(inserted).toBeDefined();
    });

    it('should handle multiline text', () => {
      const oldText = 'First line\nSecond line\nThird line';
      const newText = 'First line\nModified line\nThird line';

      const result = computeDiff(oldText, newText);

      expect(result.some((op) => op.type === 'delete')).toBe(true);
      expect(result.some((op) => op.type === 'insert')).toBe(true);
    });
  });

  describe('diffToHtml', () => {
    it('should return plain text for equal ops', () => {
      const ops: DiffOp[] = [{ type: 'equal', text: 'hello' }];

      const html = diffToHtml(ops);

      expect(html).toBe('hello');
      expect(html).not.toContain('span');
    });

    it('should wrap deleted text with del class', () => {
      const ops: DiffOp[] = [{ type: 'delete', text: 'removed' }];

      const html = diffToHtml(ops);

      expect(html).toContain('claudian-diff-del');
      expect(html).toContain('removed');
    });

    it('should wrap inserted text with ins class', () => {
      const ops: DiffOp[] = [{ type: 'insert', text: 'added' }];

      const html = diffToHtml(ops);

      expect(html).toContain('claudian-diff-ins');
      expect(html).toContain('added');
    });

    it('should escape HTML special characters', () => {
      const ops: DiffOp[] = [{ type: 'insert', text: '<script>alert("xss")</script>' }];

      const html = diffToHtml(ops);

      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>');
    });

    it('should handle multiple operations', () => {
      const ops: DiffOp[] = [
        { type: 'equal', text: 'Hello ' },
        { type: 'delete', text: 'world' },
        { type: 'insert', text: 'universe' },
      ];

      const html = diffToHtml(ops);

      expect(html).toContain('Hello ');
      expect(html).toContain('claudian-diff-del');
      expect(html).toContain('world');
      expect(html).toContain('claudian-diff-ins');
      expect(html).toContain('universe');
    });

    it('should handle empty text', () => {
      const ops: DiffOp[] = [{ type: 'equal', text: '' }];

      const html = diffToHtml(ops);

      expect(html).toBe('');
    });

    it('should preserve whitespace', () => {
      const ops: DiffOp[] = [{ type: 'equal', text: '  spaces  ' }];

      const html = diffToHtml(ops);

      expect(html).toBe('  spaces  ');
    });

    it('should handle special characters in deleted/inserted text', () => {
      const ops: DiffOp[] = [
        { type: 'delete', text: 'a < b' },
        { type: 'insert', text: 'a > b' },
      ];

      const html = diffToHtml(ops);

      expect(html).toContain('&lt;');
      expect(html).toContain('&gt;');
    });
  });

  describe('integration: diff and render', () => {
    it('should produce valid HTML for simple edit', () => {
      const ops = computeDiff('old text', 'new text');
      const html = diffToHtml(ops);

      // Should have both del and ins spans
      expect(html).toContain('claudian-diff-del');
      expect(html).toContain('claudian-diff-ins');
    });

    it('should produce plain text for no changes', () => {
      const ops = computeDiff('same text', 'same text');
      const html = diffToHtml(ops);

      expect(html).toBe('same text');
      expect(html).not.toContain('span');
    });

    it('should handle code snippet changes', () => {
      const oldCode = 'const x = 1;';
      const newCode = 'const x = 2;';

      const ops = computeDiff(oldCode, newCode);
      const html = diffToHtml(ops);

      expect(html).toContain('1');
      expect(html).toContain('2');
    });

    it('should handle markdown formatting changes', () => {
      const oldText = '**bold** text';
      const newText = '*italic* text';

      const ops = computeDiff(oldText, newText);
      diffToHtml(ops); // Verify it doesn't throw

      expect(ops.some((op) => op.type === 'delete')).toBe(true);
      expect(ops.some((op) => op.type === 'insert')).toBe(true);
    });
  });
});

/**
 * Tests for normalizePathForVault edge cases.
 */
describe('normalizePathForVault edge cases', () => {
  it('should return null for null path', () => {
    expect(normalizePathForVault(null, '/test/vault')).toBeNull();
  });

  it('should return null for undefined path', () => {
    expect(normalizePathForVault(undefined, '/test/vault')).toBeNull();
  });

  it('should return null for empty string path', () => {
    expect(normalizePathForVault('', '/test/vault')).toBeNull();
  });

  it('should normalize path within vault to relative path', () => {
    const vaultPath = '/test/vault';
    const filePath = '/test/vault/notes/file.md';
    const result = normalizePathForVault(filePath, vaultPath);
    expect(result).toBe('notes/file.md');
  });

  it('should handle relative path within vault', () => {
    const vaultPath = '/test/vault';
    const filePath = 'notes/file.md';
    const result = normalizePathForVault(filePath, vaultPath);
    expect(result).toBe('notes/file.md');
  });

  it('should handle path outside vault', () => {
    const vaultPath = '/test/vault';
    const filePath = '/other/location/file.md';
    const result = normalizePathForVault(filePath, vaultPath);
    // Should return the normalized path as-is
    expect(result).toBe('/other/location/file.md');
  });

  it('should handle null vault path', () => {
    const filePath = '/some/path/file.md';
    const result = normalizePathForVault(filePath, null);
    expect(result).toBe('/some/path/file.md');
  });

  it('should normalize backslashes to forward slashes', () => {
    const vaultPath = '/test/vault';
    const filePath = 'notes\\subfolder\\file.md';
    const result = normalizePathForVault(filePath, vaultPath);
    expect(result).toContain('/');
    expect(result).not.toContain('\\');
  });

  it('should handle paths with spaces', () => {
    const vaultPath = '/test/vault';
    const filePath = '/test/vault/my notes/file.md';
    const result = normalizePathForVault(filePath, vaultPath);
    expect(result).toBe('my notes/file.md');
  });

  it('should return null for empty relative result', () => {
    const vaultPath = '/test/vault';
    // When path.relative returns empty string (same dir)
    const filePath = '/test/vault';
    const result = normalizePathForVault(filePath, vaultPath);
    // Empty relative path returns null
    expect(result).toBeNull();
  });

  it('should handle tilde paths after normalization', () => {
    const vaultPath = '/home/user/vault';
    // normalizePathForFilesystem should handle tilde expansion
    const filePath = '/home/user/vault/notes/file.md';
    const result = normalizePathForVault(filePath, vaultPath);
    expect(result).toBe('notes/file.md');
  });
});
