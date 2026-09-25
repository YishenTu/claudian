import {
  createCLIPathFingerprintInputs,
  hasCLIPathFingerprintInputs,
} from '@/core/providers/cli/CLIPathFingerprintInputs';

describe('CLI path fingerprint inputs', () => {
  it('normalizes and preserves hostname and legacy candidates independently', () => {
    const inputs = createCLIPathFingerprintInputs(
      ' /configured/hostname-cli ',
      ' /configured/legacy-cli ',
    );

    expect(inputs).toEqual({
      hostnameCliPath: '/configured/hostname-cli',
      legacyCliPath: '/configured/legacy-cli',
    });
    expect(hasCLIPathFingerprintInputs(inputs)).toBe(true);
  });

  it('represents missing candidates explicitly without treating them as configured', () => {
    const inputs = createCLIPathFingerprintInputs(undefined, '  ');

    expect(inputs).toEqual({
      hostnameCliPath: '',
      legacyCliPath: '',
    });
    expect(hasCLIPathFingerprintInputs(inputs)).toBe(false);
  });
});
