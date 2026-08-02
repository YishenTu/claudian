import {
  createCliPathFingerprintInputs,
  hasCliPathFingerprintInputs,
} from '@/core/providers/cli/CliPathFingerprintInputs';

describe('CLI path fingerprint inputs', () => {
  it('normalizes and preserves hostname and legacy candidates independently', () => {
    const inputs = createCliPathFingerprintInputs(
      ' /configured/hostname-cli ',
      ' /configured/legacy-cli ',
    );

    expect(inputs).toEqual({
      hostnameCliPath: '/configured/hostname-cli',
      legacyCliPath: '/configured/legacy-cli',
    });
    expect(hasCliPathFingerprintInputs(inputs)).toBe(true);
  });

  it('represents missing candidates explicitly without treating them as configured', () => {
    const inputs = createCliPathFingerprintInputs(undefined, '  ');

    expect(inputs).toEqual({
      hostnameCliPath: '',
      legacyCliPath: '',
    });
    expect(hasCliPathFingerprintInputs(inputs)).toBe(false);
  });
});
