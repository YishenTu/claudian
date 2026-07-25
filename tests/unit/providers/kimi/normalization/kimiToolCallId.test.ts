import { stripKimiToolCallPrefix } from '@/providers/kimi/normalization/kimiToolCallId';

describe('stripKimiToolCallPrefix', () => {
  it('strips the <turnId>: prefix from kimi tool call ids', () => {
    expect(stripKimiToolCallPrefix('3:toolu_01ABC')).toBe('toolu_01ABC');
    expect(stripKimiToolCallPrefix('12:call_123')).toBe('call_123');
  });

  it('passes through plain ids untouched', () => {
    expect(stripKimiToolCallPrefix('toolu_01ABC')).toBe('toolu_01ABC');
    expect(stripKimiToolCallPrefix('call_123')).toBe('call_123');
    expect(stripKimiToolCallPrefix('')).toBe('');
  });

  it('only strips a numeric first segment', () => {
    expect(stripKimiToolCallPrefix('toolu_01ABC:extra')).toBe('toolu_01ABC:extra');
    expect(stripKimiToolCallPrefix('1b3bd402-e93c:tool-1')).toBe('1b3bd402-e93c:tool-1');
  });

  it('keeps the remainder intact when the raw id contains colons', () => {
    expect(stripKimiToolCallPrefix('7:toolu_01:part2')).toBe('toolu_01:part2');
  });

  it('keeps ids whose colon could not come from a turn prefix', () => {
    expect(stripKimiToolCallPrefix(':leading-colon')).toBe(':leading-colon');
    expect(stripKimiToolCallPrefix('42:')).toBe('');
  });
});
