import { parseOpencodeNativeVersion } from '@/providers/opencode/runtime/OpencodeVersion';

it('accepts only OpenCode v2 runtimes', () => {
  expect(parseOpencodeNativeVersion('2.0.12')).toBe(2);
  expect(parseOpencodeNativeVersion(undefined)).toBeUndefined();
  expect(() => parseOpencodeNativeVersion('1.18.32')).toThrow('OpenCode v1 is no longer supported');
  expect(() => parseOpencodeNativeVersion('3.0.0')).toThrow('Unsupported OpenCode version');
});
