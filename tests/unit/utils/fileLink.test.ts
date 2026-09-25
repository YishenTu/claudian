import { parseWikilinks } from '@/utils/fileLink';

describe('parseWikilinks', () => {
  describe('basic wikilinks', () => {
    it('matches simple wikilink', () => {
      const matches = parseWikilinks('[[note.md]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note.md');
      expect(matches[0].displayText).toBe('note.md');
    });

    it('matches wikilink without extension', () => {
      const matches = parseWikilinks('[[note]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note');
    });

    it('matches wikilink with folder path', () => {
      const matches = parseWikilinks('[[folder/subfolder/note.md]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('folder/subfolder/note.md');
    });

    it('matches wikilink in surrounding text', () => {
      const matches = parseWikilinks('Check [[note.md]] for info');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note.md');
      expect(matches[0].index).toBe(6);
    });
  });

  describe('wikilinks with display text', () => {
    it('matches wikilink with pipe alias', () => {
      const matches = parseWikilinks('[[note.md|My Note]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note.md');
      expect(matches[0].fullMatch).toBe('[[note.md|My Note]]');
    });

    it('extracts display text correctly', () => {
      const fullMatch = '[[note.md|My Display Text]]';
      const displayText = parseWikilinks(fullMatch)[0].displayText;
      expect(displayText).toBe('My Display Text');
    });
  });

  describe('wikilinks with headings and blocks', () => {
    it('matches wikilink with heading reference', () => {
      const matches = parseWikilinks('[[note.md#section]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note.md');
    });

    it('matches wikilink with block reference', () => {
      const matches = parseWikilinks('[[note.md^blockid]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note.md');
    });

    it('matches wikilink with heading and display text', () => {
      const matches = parseWikilinks('[[note.md#section|Section Link]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note.md');
    });
  });

  describe('multiple wikilinks', () => {
    it('matches multiple wikilinks in text', () => {
      const matches = parseWikilinks('See [[note1.md]] and [[note2.md]]');
      expect(matches).toHaveLength(2);
      expect(matches[0].linkPath).toBe('note2.md');
      expect(matches[1].linkPath).toBe('note1.md');
    });

    it('matches consecutive wikilinks', () => {
      const matches = parseWikilinks('[[a.md]][[b.md]]');
      expect(matches).toHaveLength(2);
    });

    it('captures correct indices for multiple matches', () => {
      const text = '[[first.md]] middle [[second.md]]';
      const matches = parseWikilinks(text);
      expect(matches[0].index).toBe(20);
      expect(matches[1].index).toBe(0);
    });
  });

  describe('image embeds (should NOT match)', () => {
    it('does not match image embed', () => {
      const matches = parseWikilinks('![[image.png]]');
      expect(matches).toHaveLength(0);
    });

    it('does not match image embed with alt text', () => {
      const matches = parseWikilinks('![[image.png|alt text]]');
      expect(matches).toHaveLength(0);
    });

    it('matches file link but not image embed', () => {
      const matches = parseWikilinks('[[note.md]] and ![[image.png]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('note.md');
    });

    it('handles mixed file links and image embeds', () => {
      const text = '![[img1.png]] [[file.md]] ![[img2.png]] [[other.md]]';
      const matches = parseWikilinks(text);
      expect(matches).toHaveLength(2);
      expect(matches[0].linkPath).toBe('other.md');
      expect(matches[1].linkPath).toBe('file.md');
    });
  });

  describe('edge cases', () => {
    it('handles empty text', () => {
      const matches = parseWikilinks('');
      expect(matches).toHaveLength(0);
    });

    it('handles text without wikilinks', () => {
      const matches = parseWikilinks('Just plain text here');
      expect(matches).toHaveLength(0);
    });

    it('handles incomplete wikilink syntax', () => {
      const matches = parseWikilinks('[[incomplete');
      expect(matches).toHaveLength(0);
    });

    it('matches wikilink at start of text', () => {
      const matches = parseWikilinks('[[note.md]] is first');
      expect(matches).toHaveLength(1);
      expect(matches[0].index).toBe(0);
    });

    it('matches wikilink at end of text', () => {
      const matches = parseWikilinks('last is [[note.md]]');
      expect(matches).toHaveLength(1);
    });

    it('handles special characters in path', () => {
      const matches = parseWikilinks('[[folder/my note (2024).md]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('folder/my note (2024).md');
    });

    it('handles spaces in filename', () => {
      const matches = parseWikilinks('[[my long filename.md]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('my long filename.md');
    });

    it('handles deep folder paths', () => {
      const matches = parseWikilinks('[[a/b/c/d/e/note.md]]');
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('a/b/c/d/e/note.md');
    });
  });

  describe('real-world examples', () => {
    it('matches typical vault path from screenshot', () => {
      const text = 'Found in [[30.areas/a.finance/Investment lessons/2024.Current trading lessons.md]]';
      const matches = parseWikilinks(text);
      expect(matches).toHaveLength(1);
      expect(matches[0].linkPath).toBe('30.areas/a.finance/Investment lessons/2024.Current trading lessons.md');
    });

    it('matches multiple paths in a list', () => {
      const text = `
1. [[30.areas/finance/note1.md]] - First
2. [[30.areas/finance/note2.md]] - Second
      `;
      const matches = parseWikilinks(text);
      expect(matches).toHaveLength(2);
    });

    it('handles markdown formatting around links', () => {
      const text = 'Check **[[important.md]]** for *[[details.md]]*';
      const matches = parseWikilinks(text);
      expect(matches).toHaveLength(2);
    });
  });

  describe('wikilink target extraction', () => {
    it('keeps heading references in target', () => {
      expect(parseWikilinks('[[note#section]]')[0].linkTarget).toBe('note#section');
    });

    it('keeps block references in target', () => {
      expect(parseWikilinks('[[note^block]]')[0].linkTarget).toBe('note^block');
    });

    it('drops display text while preserving anchors', () => {
      expect(parseWikilinks('[[note#section|Alias]]')[0].linkTarget).toBe('note#section');
    });
  });
});
