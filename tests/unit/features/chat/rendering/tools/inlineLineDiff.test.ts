import {
  computeBlockInlineDiffs,
  computeInlineLineDiff,
  tokenizeDiffLine,
} from '@/features/chat/rendering/tools/inlineLineDiff';

describe('inlineLineDiff', () => {
  describe('tokenizeDiffLine', () => {
    it('splits CJK scripts per character while preserving astral characters and combining marks', () => {
      expect(tokenizeDiffLine('这是一段文字')).toEqual(['这', '是', '一', '段', '文', '字']);
      expect(tokenizeDiffLine('これはコーヒーです。')).toEqual(['こ', 'れ', 'は', 'コ', 'ー', 'ヒ', 'ー', 'で', 'す', '。']);
      expect(tokenizeDiffLine('日々是好日')).toEqual(['日', '々', '是', '好', '日']);
      expect(tokenizeDiffLine('이것은 문장입니다.')).toEqual(['이', '것', '은', ' ', '문', '장', '입', '니', '다', '.']);
      expect(tokenizeDiffLine('𠀀测试𠀁')).toEqual(['𠀀', '测', '试', '𠀁']);
      expect(tokenizeDiffLine('か\u3099き')).toEqual(['か\u3099', 'き']);
      expect(tokenizeDiffLine('\u1100\u1161\u1100\u1165')).toEqual(['\u1100\u1161', '\u1100\u1165']);
      expect(tokenizeDiffLine('\uFF76\uFF9E\uFF76')).toEqual(['\uFF76\uFF9E', '\uFF76']);
    });

    it('keeps non-CJK words intact and separates punctuation and whitespace', () => {
      expect(tokenizeDiffLine('在 Obsidian 中使用 Claudian 插件')).toEqual([
        '在', ' ', 'Obsidian', ' ', '中', '使', '用', ' ', 'Claudian', ' ', '插', '件',
      ]);
      expect(tokenizeDiffLine('const old_value = compute(a, b);')).toEqual([
        'const', ' ', 'old', '_', 'value', ' ', '=', ' ', 'compute', '(', 'a', ',', ' ', 'b', ')', ';',
      ]);
      expect(tokenizeDiffLine('')).toEqual([]);
    });
  });

  describe('computeInlineLineDiff', () => {
    it('highlights a single inserted CJK character without marking the deleted line', () => {
      expect(computeInlineLineDiff('这是一段文字', '这不是一段文字')).toEqual({
        deleteSegments: null,
        insertSegments: [
          { text: '这', changed: false },
          { text: '不', changed: true },
          { text: '是一段文字', changed: false },
        ],
      });
    });

    it('keeps decomposed Hangul syllables and half-width voiced katakana intact when highlighting', () => {
      // Decomposed Korean NFD: '가나다' -> '거나다' highlights the whole syllable '가' / '거'
      const hangulOld = '\u1100\u1161\u1102\u1161\u1103\u1161';
      const hangulNew = '\u1100\u1165\u1102\u1161\u1103\u1161';
      expect(computeInlineLineDiff(hangulOld, hangulNew)).toEqual({
        deleteSegments: [
          { text: '\u1100\u1161', changed: true },
          { text: '\u1102\u1161\u1103\u1161', changed: false },
        ],
        insertSegments: [
          { text: '\u1100\u1165', changed: true },
          { text: '\u1102\u1161\u1103\u1161', changed: false },
        ],
      });

      // Half-width Japanese katakana: 'ﾃｽﾄｶ' -> 'ﾃｽﾄｶﾞ' highlights 'ｶ' -> 'ｶﾞ', not only 'ﾞ'
      expect(computeInlineLineDiff('ﾃｽﾄ\uFF76', 'ﾃｽﾄ\uFF76\uFF9E')).toEqual({
        deleteSegments: [
          { text: 'ﾃｽﾄ', changed: false },
          { text: '\uFF76', changed: true },
        ],
        insertSegments: [
          { text: 'ﾃｽﾄ', changed: false },
          { text: '\uFF76\uFF9E', changed: true },
        ],
      });
    });

    it('highlights a single removed CJK character without marking the inserted line', () => {
      expect(computeInlineLineDiff('这不是一段文字', '这是一段文字')).toEqual({
        deleteSegments: [
          { text: '这', changed: false },
          { text: '不', changed: true },
          { text: '是一段文字', changed: false },
        ],
        insertSegments: null,
      });
    });

    it('highlights multiple changed CJK spans in one sentence while keeping unchanged clauses', () => {
      expect(computeInlineLineDiff('今天天气很好，我们去公园散步吧。', '今天天气真不错，我们去海边散步吧。')).toEqual({
        deleteSegments: [
          { text: '今天天气', changed: false },
          { text: '很好', changed: true },
          { text: '，我们去', changed: false },
          { text: '公园', changed: true },
          { text: '散步吧。', changed: false },
        ],
        insertSegments: [
          { text: '今天天气', changed: false },
          { text: '真不错', changed: true },
          { text: '，我们去', changed: false },
          { text: '海边', changed: true },
          { text: '散步吧。', changed: false },
        ],
      });
    });

    it('handles single-character edits inside long CJK paragraphs via prefix/suffix trimming', () => {
      const prefix = '这是一段很长的中文段落内容，用于测试超长段落中的单字修改定位。'.repeat(80);
      const suffix = '后面还有大量完全相同的中文内容以确保前后缀裁剪生效。'.repeat(80);
      const diff = computeInlineLineDiff(`${prefix}旧${suffix}`, `${prefix}新${suffix}`);

      expect(diff).toEqual({
        deleteSegments: [
          { text: prefix, changed: false },
          { text: '旧', changed: true },
          { text: suffix, changed: false },
        ],
        insertSegments: [
          { text: prefix, changed: false },
          { text: '新', changed: true },
          { text: suffix, changed: false },
        ],
      });
    });

    it('highlights indentation changes and whitespace-only edits', () => {
      expect(computeInlineLineDiff('  这是一段文字', '    这是一段文字')).toEqual({
        deleteSegments: null,
        insertSegments: [
          { text: '  ', changed: false },
          { text: '  ', changed: true },
          { text: '这是一段文字', changed: false },
        ],
      });
      expect(computeInlineLineDiff('  ', '    ')).toEqual({
        deleteSegments: null,
        insertSegments: [
          { text: '  ', changed: false },
          { text: '  ', changed: true },
        ],
      });
    });

    it('returns null for identical, empty, unrelated, or oversized middle-matrix lines', () => {
      expect(computeInlineLineDiff('相同', '相同')).toBeNull();
      expect(computeInlineLineDiff('', '新增')).toBeNull();
      expect(computeInlineLineDiff('const alpha = 1;', 'return false;')).toBeNull();
      expect(computeInlineLineDiff('他', '她')).toBeNull();

      // Exceeds MAX_LCS_CELLS (600 * 600 = 360,000 > 250,000) with no common prefix/suffix
      const largeA = Array.from({ length: 600 }, (_, idx) => (idx % 2 === 0 ? '甲' : '乙')).join('');
      const largeB = Array.from({ length: 600 }, (_, idx) => (idx % 2 === 0 ? '丙' : '丁')).join('');
      expect(computeInlineLineDiff(largeA, largeB)).toBeNull();
    });
  });

  describe('computeBlockInlineDiffs', () => {
    it('matches related lines monotonically when deletions and insertions are shifted', () => {
      const result = computeBlockInlineDiffs(
        ['旧标题', '这是一段文字'],
        ['这不是一段文字', '新结尾'],
      );

      expect(result.deleteSegments).toEqual([null, null]);
      expect(result.insertSegments).toEqual([
        [
          { text: '这', changed: false },
          { text: '不', changed: true },
          { text: '是一段文字', changed: false },
        ],
        null,
      ]);
    });

    it('keeps identical lines unhighlighted while diffing modified neighbors', () => {
      const result = computeBlockInlineDiffs(
        ['第一行不变', '第二行旧内容', '第三行不变'],
        ['第一行不变', '第二行新内容', '第三行不变'],
      );

      expect(result.deleteSegments).toEqual([
        null,
        [
          { text: '第二行', changed: false },
          { text: '旧', changed: true },
          { text: '内容', changed: false },
        ],
        null,
      ]);
      expect(result.insertSegments).toEqual([
        null,
        [
          { text: '第二行', changed: false },
          { text: '新', changed: true },
          { text: '内容', changed: false },
        ],
        null,
      ]);
    });

    it('prefers ordered matches over reversed anagrams in multi-line blocks', () => {
      const result = computeBlockInlineDiffs(
        ['上海自来水'],
        ['上海自来水厂', '水来自海上'],
      );

      expect(result.deleteSegments).toEqual([null]);
      expect(result.insertSegments).toEqual([
        [
          { text: '上海自来水', changed: false },
          { text: '厂', changed: true },
        ],
        null,
      ]);
    });
  });
});
