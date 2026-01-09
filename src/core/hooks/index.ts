/**
 * Hooks barrel export.
 */

export {
  clearDiffState,
  createFileHashPostHook,
  createFileHashPreHook,
  type DiffContentEntry,
  type FileEditPostCallback,
  getDiffData,
  MAX_DIFF_SIZE,
} from './DiffTrackingHooks';
export {
  type BlocklistContext,
  createBlocklistHook,
  createVaultRestrictionHook,
  type VaultRestrictionContext,
} from './SecurityHooks';
