import {
  createEnvironmentRuntimeInputFingerprint,
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

  describe('createEnvironmentRuntimeInputFingerprint', () => {
    const baseline = 'CONFIG_DIR=/store\nSOME_CUSTOM_FLAG=1';

    it.each([
      ['a changed store-moving key', 'CONFIG_DIR=/other-store\nSOME_CUSTOM_FLAG=1'],
      ['a changed arbitrary key', 'CONFIG_DIR=/store\nSOME_CUSTOM_FLAG=2'],
      ['a removed key', 'SOME_CUSTOM_FLAG=1'],
      ['a key emptied in place', 'CONFIG_DIR=\nSOME_CUSTOM_FLAG=1'],
      ['an added key', `${baseline}\nANOTHER_FLAG=1`],
    ])('fingerprints every configured key, so %s changes it', (_label, environmentText) => {
      expect(createEnvironmentRuntimeInputFingerprint(environmentText))
        .not.toBe(createEnvironmentRuntimeInputFingerprint(baseline));
    });

    it('changes with additional launch inputs and ignores line order', () => {
      const fingerprint = createEnvironmentRuntimeInputFingerprint(baseline, { cliPath: '/bin/provider' });

      expect(createEnvironmentRuntimeInputFingerprint('SOME_CUSTOM_FLAG=1\nCONFIG_DIR=/store', { cliPath: '/bin/provider' }))
        .toBe(fingerprint);
      expect(createEnvironmentRuntimeInputFingerprint(baseline, { cliPath: '/custom/provider' }))
        .not.toBe(fingerprint);
      expect(createEnvironmentRuntimeInputFingerprint(baseline)).not.toBe(fingerprint);
    });
  });
});
