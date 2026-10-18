import { parseOpencodeNativeVersion } from '@/providers/opencode/runtime/OpencodeVersion';
import { getOpencodeState } from '@/providers/opencode/types';

it('accepts only OpenCode v2 runtimes', () => {
  expect(parseOpencodeNativeVersion('2.0.12')).toBe(2);
  expect(parseOpencodeNativeVersion(undefined)).toBeUndefined();
  expect(() => parseOpencodeNativeVersion('1.18.32')).toThrow('OpenCode v1 is no longer supported');
  expect(() => parseOpencodeNativeVersion('3.0.0')).toThrow('Unsupported OpenCode version');
});

it('decodes only the v2 stamp from stored state', () => {
  expect(getOpencodeState({ nativeVersion: 2, futureCursor: 'keep' })).toEqual({ nativeVersion: 2, futureCursor: 'keep' });
  expect(getOpencodeState({ nativeVersion: 1, futureCursor: 'keep' })).toEqual({ futureCursor: 'keep' });
  expect(getOpencodeState({ nativeVersion: '2', futureCursor: 'keep' })).toEqual({ futureCursor: 'keep' });
});
