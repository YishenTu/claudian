export type ProviderReadinessStatus = 'disabled' | 'blocked' | 'attention' | 'ready';

export type ProviderReadinessCheckId = 'enabled' | 'cli' | 'models' | 'selection';

export interface ProviderReadinessInput {
  enabled: boolean;
  cliPath: string | null;
  discoveredModelCount: number;
  selectedModelCount: number;
}

export interface ProviderReadinessCheck {
  id: ProviderReadinessCheckId;
  status: ProviderReadinessStatus;
}

export interface ProviderReadinessSnapshot {
  status: ProviderReadinessStatus;
  checks: ProviderReadinessCheck[];
}

export function assessProviderReadiness(
  input: ProviderReadinessInput,
): ProviderReadinessSnapshot {
  if (!input.enabled) {
    return {
      status: 'disabled',
      checks: [
        { id: 'enabled', status: 'disabled' },
        { id: 'cli', status: 'disabled' },
        { id: 'models', status: 'disabled' },
        { id: 'selection', status: 'disabled' },
      ],
    };
  }

  const cliStatus: ProviderReadinessStatus = input.cliPath ? 'ready' : 'blocked';
  const modelsStatus: ProviderReadinessStatus = input.discoveredModelCount > 0
    ? 'ready'
    : 'attention';
  const selectionStatus: ProviderReadinessStatus = input.selectedModelCount > 0
    ? 'ready'
    : 'blocked';
  const checks: ProviderReadinessCheck[] = [
    { id: 'enabled', status: 'ready' },
    { id: 'cli', status: cliStatus },
    { id: 'models', status: modelsStatus },
    { id: 'selection', status: selectionStatus },
  ];

  return {
    status: checks.some(check => check.status === 'blocked')
      ? 'blocked'
      : checks.some(check => check.status === 'attention')
        ? 'attention'
        : 'ready',
    checks,
  };
}
