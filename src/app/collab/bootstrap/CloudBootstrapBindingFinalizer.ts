import type { CollabIsoTimestamp } from '@claudian/collab-protocol';

import {
  advanceCloudBootstrapTransitionPhase,
  type CloudBootstrapTransitionPhase,
  type CloudBootstrapTransitionRecord,
  type CloudBootstrapTransitionStorePort,
  decodeCloudBootstrapTransitionRecord,
} from '@/app/collab/bootstrap/CloudBootstrapTransitionRecord';
import { CollabError } from '@/core/collab/ClaudianCollabError';

export interface CloudBootstrapBindingEffects {
  confirmReadiness(record: CloudBootstrapTransitionRecord, signal?: AbortSignal): Promise<void>;
  repairIndex(record: CloudBootstrapTransitionRecord, signal?: AbortSignal): Promise<void>;
  replaceMembership(record: CloudBootstrapTransitionRecord, signal?: AbortSignal): Promise<void>;
  retireLanAuthority(record: CloudBootstrapTransitionRecord, signal?: AbortSignal): Promise<void>;
  rotateOrigin(record: CloudBootstrapTransitionRecord, signal?: AbortSignal): Promise<void>;
  verifyActivation(record: CloudBootstrapTransitionRecord, signal?: AbortSignal): Promise<void>;
  verifyCloud(record: CloudBootstrapTransitionRecord, signal?: AbortSignal): Promise<void>;
}

export interface CloudBootstrapBindingFinalizerOptions {
  readonly effects: CloudBootstrapBindingEffects;
  readonly now?: () => Date;
  readonly transitions: CloudBootstrapTransitionStorePort;
}

function cancelled(): CollabError {
  return new CollabError({ code: 'cancelled', recoveryActions: ['retry'] });
}

const NEXT_PHASE = Object.freeze({
  intent: 'readiness-confirmed',
  'readiness-confirmed': 'origin-rotated',
  'origin-rotated': 'cloud-verified',
  'cloud-verified': 'membership-replaced',
  'membership-replaced': 'index-repaired',
  'index-repaired': 'lan-authority-retired',
  'lan-authority-retired': 'fence-terminal',
} satisfies Record<Exclude<CloudBootstrapTransitionPhase, 'fence-terminal'>, CloudBootstrapTransitionPhase>);

export class CloudBootstrapBindingFinalizer {
  private readonly now: () => Date;

  constructor(private readonly options: CloudBootstrapBindingFinalizerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async finalize(
    record: CloudBootstrapTransitionRecord,
    signal?: AbortSignal,
  ): Promise<CloudBootstrapTransitionRecord> {
    let current = decodeCloudBootstrapTransitionRecord(record);
    if (current.attemptState !== 'activated') {
      throw new TypeError('Cloud bootstrap binding requires activation');
    }
    if (current.phase === 'fence-terminal') {
      if (signal?.aborted) throw cancelled();
      await this.options.effects.verifyActivation(current, signal);
      if (signal?.aborted) throw cancelled();
      await this.revalidateCloudBinding(current, signal);
      if (signal?.aborted) throw cancelled();
      await this.options.effects.retireLanAuthority(current, signal);
      if (signal?.aborted) throw cancelled();
      return current;
    }
    while (current.phase !== 'fence-terminal') {
      if (signal?.aborted) throw cancelled();
      await this.options.effects.verifyActivation(current, signal);
      if (signal?.aborted) throw cancelled();
      await this.applyCurrentPhase(current, signal);
      if (signal?.aborted) throw cancelled();
      current = advanceCloudBootstrapTransitionPhase(
        current,
        NEXT_PHASE[current.phase],
        this.timestamp(),
      );
      await this.options.transitions.save(current);
    }
    return current;
  }

  private async applyCurrentPhase(
    record: CloudBootstrapTransitionRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    switch (record.phase) {
      case 'intent':
        return this.options.effects.confirmReadiness(record, signal);
      case 'readiness-confirmed':
        return this.options.effects.rotateOrigin(record, signal);
      case 'origin-rotated':
        return this.options.effects.verifyCloud(record, signal);
      case 'cloud-verified':
        return this.options.effects.replaceMembership(record, signal);
      case 'membership-replaced':
        return this.options.effects.repairIndex(record, signal);
      case 'index-repaired': {
        await this.revalidateCloudBinding(record, signal);
        return this.options.effects.retireLanAuthority(record, signal);
      }
      case 'lan-authority-retired': {
        await this.revalidateCloudBinding(record, signal);
        return this.options.effects.retireLanAuthority(record, signal);
      }
      case 'fence-terminal':
        return undefined;
    }
  }

  private async revalidateCloudBinding(
    record: CloudBootstrapTransitionRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.options.effects.verifyCloud(record, signal);
    if (signal?.aborted) throw cancelled();
    await this.options.effects.replaceMembership(record, signal);
    if (signal?.aborted) throw cancelled();
    await this.options.effects.repairIndex(record, signal);
  }

  private timestamp(): CollabIsoTimestamp {
    return this.now().toISOString();
  }
}
