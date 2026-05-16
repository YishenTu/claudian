import type { ProviderCliResolver } from '../../../core/providers/types';
import { getHostnameKey } from '../../../utils/env';
import { getCursorProviderSettings } from '../settings';

/**
 * Resolves the configured `cursor-agent` CLI path from provider settings.
 *
 * Phase 1: returns the configured path verbatim (per-host map first, then
 * scalar `cliPath`). Validation, PATH probing, and fallback discovery move in
 * with `CursorBinaryLocator` during Phase 2.
 */
export class CursorCliResolver implements ProviderCliResolver {
  private cachedPath: string | null = null;
  private cacheKey: string | null = null;

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    const cursorSettings = getCursorProviderSettings(settings);
    const hostKey = getHostnameKey();
    const hostScopedPath = cursorSettings.cliPathsByHost[hostKey] ?? '';
    const candidate = hostScopedPath || cursorSettings.cliPath;
    const trimmed = candidate.trim();

    if (!trimmed) {
      this.cacheKey = null;
      this.cachedPath = null;
      return null;
    }

    if (this.cacheKey === trimmed && this.cachedPath !== null) {
      return this.cachedPath;
    }

    this.cacheKey = trimmed;
    this.cachedPath = trimmed;
    return trimmed;
  }

  reset(): void {
    this.cacheKey = null;
    this.cachedPath = null;
  }
}
