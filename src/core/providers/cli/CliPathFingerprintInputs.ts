export type CliPathFingerprintInputs = Readonly<Record<
  'hostnameCliPath' | 'legacyCliPath',
  string
>>;

export function createCliPathFingerprintInputs(
  hostnameCliPath: string | undefined,
  legacyCliPath: string | undefined,
): CliPathFingerprintInputs {
  return {
    hostnameCliPath: (hostnameCliPath ?? '').trim(),
    legacyCliPath: (legacyCliPath ?? '').trim(),
  };
}

export function hasCliPathFingerprintInputs(inputs: CliPathFingerprintInputs): boolean {
  return Boolean(inputs.hostnameCliPath || inputs.legacyCliPath);
}
