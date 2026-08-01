import type { ProviderId } from '../types/provider';

export type ProviderSessionStatus =
  | 'idle'
  | 'executing'
  | 'cancelling'
  | 'invalidated'
  | 'disposed';

export type ProviderSessionInvalidationReason =
  | 'provider-session-missing'
  | 'provider-transition'
  | 'configuration-changed'
  | 'cancelled'
  | 'transport-closed'
  | 'process-exited'
  | 'provider-error';

export interface ProviderSessionInvalidation {
  readonly reason: ProviderSessionInvalidationReason;
  readonly recoverable: boolean;
  readonly message?: string;
}

/**
 * The only execution-layer state projected into conversation persistence.
 *
 * `revision` is monotonic for one session object. Feature persistence still
 * fences the snapshot by session object, binding, and provider generation.
 */
interface ProviderSessionSnapshotBase {
  readonly providerId: ProviderId;
  readonly revision: number;
  readonly providerSessionId?: string;
  /**
   * Opaque top-level provider-state entries to set after deletions are applied.
   * A key present here wins when it is also listed in `providerStateDeletes`.
   */
  readonly providerState?: Readonly<Record<string, unknown>>;
  /**
   * Opaque top-level provider-state keys consumed by this snapshot.
   * Missing and duplicate keys are idempotent; persistence applies deletions
   * before `providerState` updates and preserves every unmentioned key.
   */
  readonly providerStateDeletes?: readonly string[];
}

export type ProviderSessionSnapshot =
  | (ProviderSessionSnapshotBase & {
      readonly status: 'invalidated';
      readonly invalidation: ProviderSessionInvalidation;
    })
  | (ProviderSessionSnapshotBase & {
      readonly status: Exclude<ProviderSessionStatus, 'invalidated'>;
      readonly invalidation?: never;
    });
