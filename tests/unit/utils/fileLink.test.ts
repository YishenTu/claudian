/**
 * Tests for fileLink utility - wikilink pattern matching
 *
 * Focuses on testing the regex pattern logic, which is the core value.
 * DOM manipulation is tested manually in Obsidian.
 */

import { extractLinkTarget } from '@/utils/fileLink';

// Extract the pattern from the module for testing
// This matches the pattern in src/utils/fileLink.ts
const WIKILINK_PATTERN = /(?<!!)\[\[([^\]|#^]+)(?:#[^\]|]+)?(?:\^[^\]|]+)?(?:\|[^\]]+)?\]\]/g;

interface WikilinkMatch {
  fullMatch: string;
  linkPath: string;
  index: number;
}

function findWikilinks(text: string): WikilinkMatch[] {
  WIKILINK_PATTERN.lastIndex = 0;
  const matches: WikilinkMatch[] = [];

  let match: RegExpExecArray | null;
  while ((match = WIKILINK_PATTERN.exec(text)) !== null) {
    matches.push({
      fullMatch: match[0],
      linkPath: match[1],
      index: match.index,
    });
  }

  return matches;
}

function extractDisplayText(fullMatch: string, linkPath: string): string {
  const pipeIndex = fullMatch.lastIndexOf('|');
  return pipeIndex > 0 ? fullMatch.slice(pipeIndex + 1, -2) : linkPath;
}

describe('wikilink pattern matching', () => {
  describe('basic wikilinks', () => {
    it('matches simple wikilink', () => {
      const matches = findWikilinks('[[note.md]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note.md');
    });

    it('matches wikilink without extension', () => {
      const matches = findWikilinks('[[note]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note');
    });

    it('matches wikilink with folder path', () => {
      const matches = findWikilinks('[[folder/subfolder/note.md]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('folder/subfolder/note.md');
    });

    it('matches wikilink in surrounding text', () => {
      const matches = findWikilinks('Check [[note.md]] for info');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note.md');
      expect(matches[0].index).toBe(6);
    });
  });

  describe('wikilinks with display text', () => {
    it('matches wikilink with pipe alias', () => {
      const matches = findWikilinks('[[note.md|My Note]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note.md');
      expect(matches[0].fullMatch).toBe('[[note.md|My Note]]');
    });

    it('extracts display text correctly', () => {
      const fullMatch = '[[note.md|My Display Text]]';
      const displayText = extractDisplayText(fullMatch, 'note.md');
      expect(displayText).toBe('My Display Text');
    });

    it('uses link path when no display text', () => {
      const fullMatch = '[[note.md]]';
      const displayText = extractDisplayText(fullMatch, 'note.md');
      expect(displayText).toBe('note.md');
    });
  });

  describe('wikilinks with headings and blocks', () => {
    it('matches wikilink with heading reference', () => {
      const matches = findWikilinks('[[note.md#section]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note.md');
    });

    it('matches wikilink with block reference', () => {
      const matches = findWikilinks('[[note.md^blockid]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note.md');
    });

    it('matches wikilink with heading and display text', () => {
      const matches = findWikilinks('[[note.md#section|Section Link]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note.md');
    });
  });

  describe('multiple wikilinks', () => {
    it('matches multiple wikilinks in text', () => {
      const matches = findWikilinks('See [[note1.md]] and [[note2.md]]');
      expect(matches).toHaveLength(2);
      expect(matches[0].linkPath).toBe('note1.md');
      expect(matches[1].linkPath).toBe('note2.md');
    });

    it('matches consecutive wikilinks', () => {
      const matches = findWikilinks('[[a.md]][[b.md]]');
      expect(matches).toHaveLength(2);
    });

    it('captures correct indices for multiple matches', () => {
      const text = '[[first.md]] middle [[second.md]]';
      const matches = findWikilinks(text);
      expect(matches[0].index).toBe(0);
      expect(matches[1].index).toBe(20);
    });
  });

  describe('image embeds (should NOT match)', () => {
    it('does not match image embed', () => {
      const matches = findWikilinks('![[image.png]]');
      expect(matches).toHaveLength(0);
    });

    it('does not match image embed with alt text', () => {
      const matches = findWikilinks('![[image.png|alt text]]');
      expect(matches).toHaveLength(0);
    });

    it('matches file link but not image embed', () => {
      const matches = findWikilinks('[[note.md]] and ![[image.png]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note.md');
    });

    it('handles mixed file links and image embeds', () => {
      const text = '![[img1.png]] [[file.md]] ![[img2.png]] [[other.md]]';
      const matches = findWikilinks(text);
      expect(matches).toHaveLength(2);
      expect(matches[0].linkPath).toBe('file.md');
      expect(matches[1].linkPath).toBe('other.md');
    });
  });

  describe('edge cases', () => {
    it('handles empty text', () => {
      const matches = findWikilinks('');
      expect(matches).toHaveLength(0);
    });

    it('handles text without wikilinks', () => {
      const matches = findWikilinks('Just plain text here');
      expect(matches).toHaveLength(0);
    });

    it('handles incomplete wikilink syntax', () => {
      const matches = findWikilinks('[[incomplete');
      expect(matches).toHaveLength(0);
    });

    it('matches wikilink at start of text', () => {
      const matches = findWikilinks('[[note.md]] is first');
      expect(matches).toHaveLength(1);
      expect(matches[0].index).toBe(0);
    });

    it('matches wikilink at end of text', () => {
      const matches = findWikilinks('last is [[note.md]]');
      expect(matches).toHaveLength(1);
    });

    it('handles special characters in path', () => {
      const matches = findWikilinks('[[folder/my note (2024).md]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('folder/my note (2024).md');
    });

    it('handles spaces in filename', () => {
      const matches = findWikilinks('[[my long filename.md]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('my long filename.md');
    });

    it('handles deep folder paths', () => {
      const matches = findWikilinks('[[a/b/c/d/e/note.md]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('a/b/c/d/e/note.md');
    });
  });

  describe('real-world examples', () => {
    it('matches typical vault path from screenshot', () => {
      const text = 'Found in [[30.areas/a.finance/Investment lessons/2024.Current trading lessons.md]]';
      const matches = findWikilinks(text);
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('30.areas/a.finance/Investment lessons/2024.Current trading lessons.md');
    });

    it('matches multiple paths in a list', () => {
      const text = `
1. [[30.areas/finance/note1.md]] - First
2. [[30.areas/finance/note2.md]] - Second
      `;
      const matches = findWikilinks(text);
      expect(matches).toHaveLength(2);
    });

    it('handles markdown formatting around links', () => {
      const text = 'Check **[[important.md]]** for *[[details.md]]*';
      const matches = findWikilinks(text);
      expect(matches).toHaveLength(2);
    });
  });

  describe('wikilink target extraction', () => {
    it('keeps heading references in target', () => {
      expect(extractLinkTarget('[[note#section]]')).toBe('note#section');
    });

    it('keeps block references in target', () => {
      expect(extractLinkTarget('[[note^block]]')).toBe('note^block');
    });

    it('drops display text while preserving anchors', () => {
      expect(extractLinkTarget('[[note#section|Alias]]')).toBe('note#section');
    });
  });
});
