import {
  assertOpencodeSessionCompatibility,
  parseOpencodeNativeVersion,
} from '@/providers/opencode/runtime/OpencodeVersion';
import { getOpencodeState } from '@/providers/opencode/types';

it('allows a v1 session upgrade but blocks a v2 session downgrade or unknown runtime', () => {
  const persisted = getOpencodeState({ nativeVersion: 2, databasePath: '/native/opencode.db' });
  expect(() => assertOpencodeSessionCompatibility(1, parseOpencodeNativeVersion('2.0.12'))).not.toThrow();
  expect(() => assertOpencodeSessionCompatibility(persisted.nativeVersion, parseOpencodeNativeVersion('1.18.32')))
    .toThrow('This conversation requires OpenCode v2');
  expect(() => assertOpencodeSessionCompatibility(persisted.nativeVersion, undefined))
    .toThrow('This conversation requires OpenCode v2');
});

it('rejects unsupported negotiated versions and decodes stored versions at runtime', () => {
  expect(() => parseOpencodeNativeVersion('3.0.0')).toThrow('Unsupported OpenCode version');
  expect(getOpencodeState({ nativeVersion: '2', futureCursor: 'keep' })).toEqual({ futureCursor: 'keep' });
});
