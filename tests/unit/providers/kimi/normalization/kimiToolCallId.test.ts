import { stripKimiToolCallPrefix } from '@/providers/kimi/normalization/kimiToolCallId';

describe('stripKimiToolCallPrefix', () => {
  it('strips the <turn-uuid>/ prefix from kimi tool call ids', () => {
    expect(stripKimiToolCallPrefix('1b3bd402-e93c-4c4e-a6aa/toolu_01ABC')).toBe('toolu_01ABC');
    expect(stripKimiToolCallPrefix('turn-uuid/call_123')).toBe('call_123');
  });

  it('passes through plain ids untouched', () => {
    expect(stripKimiToolCallPrefix('toolu_01ABC')).toBe('toolu_01ABC');
    expect(stripKimiToolCallPrefix('call_123')).toBe('call_123');
    expect(stripKimiToolCallPrefix('')).toBe('');
  });

  it('only strips up to the first slash', () => {
    expect(stripKimiToolCallPrefix('turn-uuid/namespace/tool')).toBe('namespace/tool');
  });

  it('keeps ids whose slash could not come from a turn prefix', () => {
    expect(stripKimiToolCallPrefix('/leading-slash')).toBe('/leading-slash');
    expect(stripKimiToolCallPrefix('turn-uuid/')).toBe('');
  });
});
