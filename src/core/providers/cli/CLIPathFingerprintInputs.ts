export type CLIPathFingerprintInputs = Readonly<Record<
  'hostnameCliPath' | 'legacyCliPath',
  string
>>;

export function createCLIPathFingerprintInputs(
  hostnameCliPath: string | undefined,
  legacyCliPath: string | undefined,
): CLIPathFingerprintInputs {
  return {
    hostnameCliPath: (hostnameCliPath ?? '').trim(),
    legacyCliPath: (legacyCliPath ?? '').trim(),
  };
}

export function hasCLIPathFingerprintInputs(inputs: CLIPathFingerprintInputs): boolean {
  return Boolean(inputs.hostnameCliPath || inputs.legacyCliPath);
}
