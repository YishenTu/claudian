import { resolveExecutionTargetAsync } from '@/core/process/execution-target/ExecutionTargetResolver';
import { probeTargetEnvironment } from '@/core/process/execution-target/TargetEnvironmentProbe';

import { decodePiConfig } from '../config';
import { getPiWSLForwardedEnvironment } from '../runtime/piWSLEnvironment';
import type { PiHistoryPathContext } from './PiHistoryPathResolver';

const STORE_VARIABLES = ['HOME', 'PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'PI_PACKAGE_DIR'] as const;

/** Shares concurrent probes; later reads refresh the shell-derived store environment. */
export class PiHistoryContextResolver {
  private inFlight?: { key: string; environment: Promise<Record<string, string | undefined>> };

  async resolve(vaultPath: string | null, context: PiHistoryPathContext): Promise<PiHistoryPathContext> {
    const target = context.executionTarget ?? await resolveExecutionTargetAsync({
      settings: decodePiConfig(context.config ?? {}, { referencedModelIds: [] }),
      hostPlatform: context.hostPlatform, hostVaultPath: vaultPath,
    });
    if (target.method !== 'wsl') {
      this.inFlight = undefined;
      return { ...context, executionTarget: target };
    }
    const hostCwd = vaultPath ?? context.vaultPath ?? process.cwd();
    const env = Object.fromEntries(Object.entries(context.environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
    const forwardEnvironment = getPiWSLForwardedEnvironment(env, context.environmentText ?? '');
    // Shell startup can use any forwarded input when selecting its store.
    const key = JSON.stringify([target, hostCwd, Object.entries(env).sort(([left], [right]) => left.localeCompare(right)), forwardEnvironment]);
    if (this.inFlight?.key !== key) {
      const environment = probeTargetEnvironment({ target, hostCwd, env, forwardEnvironment, variables: STORE_VARIABLES }).then(result => {
        if (!result) throw new Error('Cannot resolve the Pi WSL environment. Check the selected distro and shell startup.');
        return Object.fromEntries(STORE_VARIABLES.map(name => [name, result[name]]));
      });
      this.inFlight = { key, environment };
    }
    const inFlight = this.inFlight;
    try {
      return {
        ...context, executionTarget: target, environment: { ...context.environment, ...await inFlight.environment },
        // Values now come from Linux after WSL forwarding and shell startup.
        environmentText: undefined,
      };
    } finally {
      if (this.inFlight === inFlight) this.inFlight = undefined;
    }
  }
}
