import {
  createRuntimeInputFingerprint,
  isVersionedRuntimeInputFingerprint,
  RUNTIME_INPUT_FINGERPRINT_VERSION,
} from '@/core/providers/settings/RuntimeInputFingerprint';

describe('RuntimeInputFingerprint', () => {
  const createFingerprint = (
    environmentText: string,
    environmentKeys: readonly string[] = ['MODEL', 'BASE_URL'],
    additionalInputs?: Readonly<Record<string, string | undefined>>,
  ): string => createRuntimeInputFingerprint({
    additionalInputs,
    environmentKeys,
    environmentText,
  });

  it('is deterministic, versioned, and independent of key and line ordering', () => {
    const left = createFingerprint(
      'MODEL=model-a\nBASE_URL=https://example.test',
      ['MODEL', 'BASE_URL'],
      { cliPath: '/bin/provider', mode: 'native' },
    );
    const right = createFingerprint(
      'BASE_URL=https://example.test\nMODEL=model-a',
      ['BASE_URL', 'MODEL', 'MODEL'],
      { mode: 'native', cliPath: '/bin/provider' },
    );

    expect(left).toBe(right);
    expect(left).toMatch(new RegExp(
      `^runtime-input:v${RUNTIME_INPUT_FINGERPRINT_VERSION}:[0-9a-f]{64}$`,
    ));
    expect(isVersionedRuntimeInputFingerprint(left)).toBe(true);
    expect(isVersionedRuntimeInputFingerprint('MODEL=model-a')).toBe(false);
  });

  it('changes for selected environment and additional launch inputs', () => {
    const baseline = createFingerprint(
      'MODEL=model-a\nBASE_URL=https://example.test',
      undefined,
      { cliPath: '/bin/provider' },
    );

    expect(createFingerprint(
      'MODEL=model-b\nBASE_URL=https://example.test',
      undefined,
      { cliPath: '/bin/provider' },
    )).not.toBe(baseline);
    expect(createFingerprint(
      'MODEL=model-a\nBASE_URL=https://example.test',
      undefined,
      { cliPath: '/custom/provider' },
    )).not.toBe(baseline);
  });

  it('distinguishes a missing environment key from an explicitly empty value', () => {
    expect(createFingerprint('', ['MODEL']))
      .not.toBe(createFingerprint('MODEL=', ['MODEL']));
  });

  it('ignores environment variables that were not selected', () => {
    expect(createFingerprint('MODEL=model-a\nUNRELATED=one', ['MODEL']))
      .toBe(createFingerprint('UNRELATED=two\nMODEL=model-a', ['MODEL']));
  });

  it('does not expose a selected secret or common reversible encodings', () => {
    const secret = 'test-only-secret-value';
    const fingerprint = createFingerprint(`OPENAI_API_KEY=${secret}`, ['OPENAI_API_KEY']);
    const changedFingerprint = createFingerprint(
      'OPENAI_API_KEY=different-test-only-secret',
      ['OPENAI_API_KEY'],
    );

    expect(fingerprint).not.toContain(secret);
    expect(fingerprint).not.toContain(Buffer.from(secret, 'utf8').toString('base64'));
    expect(fingerprint).not.toContain(Buffer.from(secret, 'utf8').toString('hex'));
    expect(changedFingerprint).not.toBe(fingerprint);
  });
});
