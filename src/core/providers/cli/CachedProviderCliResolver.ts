import { findCliBinaryPath, resolveConfiguredCliPath } from '../../../utils/cliBinaryLocator';
import { getHostnameKey, parseEnvironmentVariables } from '../../../utils/env';
import { createRuntimeInputFingerprint } from '../settings/RuntimeInputFingerprint';
import { createCliPathFingerprintInputs } from './CliPathFingerprintInputs';

export interface ProviderCliSettingsProjection {
  cliPathsByHost?: Readonly<Record<string, string>>;
  environmentText: string;
  legacyCliPath?: string;
  resolutionInputs?: Readonly<Record<string, string | undefined>>;
}

export interface ProviderCliResolutionContext extends ProviderCliSettingsProjection {
  environmentVariables: Readonly<Record<string, string>>;
  hostnamePath: string;
  legacyCliPath: string;
}

type ProviderCliResolution = (
  context: ProviderCliResolutionContext,
  resolveDefault: () => string | null,
) => string | null;

export interface CachedProviderCliResolverOptions {
  binaryName: string;
  getSettingsProjection: (settings: Record<string, unknown>) => ProviderCliSettingsProjection;
  hostnameKey?: string;
  providerId: string;
  resolve?: ProviderCliResolution;
}

export class CachedProviderCliResolver {
  private cacheKey = '';
  private cacheValid = false;
  private cachedResolution: string | null = null;
  private readonly hostnameKey: string;

  constructor(private readonly options: CachedProviderCliResolverOptions) {
    this.hostnameKey = options.hostnameKey ?? getHostnameKey();
  }

  resolveFromSettings(settings: Record<string, unknown>): string | null {
    return this.resolve(this.options.getSettingsProjection(settings));
  }

  resolve(projection: ProviderCliSettingsProjection): string | null {
    const context = this.createResolutionContext(projection);
    const cacheKey = this.createCacheKey(context);
    if (this.cacheValid && cacheKey === this.cacheKey) {
      return this.cachedResolution;
    }

    const resolveDefault = (): string | null => (
      resolveConfiguredCliPath(context.hostnamePath)
      ?? resolveConfiguredCliPath(context.legacyCliPath)
      ?? findCliBinaryPath(this.options.binaryName, context.environmentVariables.PATH)
    );

    this.cachedResolution = this.options.resolve
      ? this.options.resolve(context, resolveDefault)
      : resolveDefault();
    this.cacheKey = cacheKey;
    this.cacheValid = true;
    return this.cachedResolution;
  }

  reset(): void {
    this.cacheKey = '';
    this.cacheValid = false;
    this.cachedResolution = null;
  }

  private createResolutionContext(
    projection: ProviderCliSettingsProjection,
  ): ProviderCliResolutionContext {
    const environmentText = projection.environmentText || '';
    return {
      ...projection,
      environmentText,
      environmentVariables: parseEnvironmentVariables(environmentText),
      hostnamePath: (projection.cliPathsByHost?.[this.hostnameKey] ?? '').trim(),
      legacyCliPath: (projection.legacyCliPath ?? '').trim(),
    };
  }

  private createCacheKey(context: ProviderCliResolutionContext): string {
    const additionalInputs: Record<string, string | undefined> = {
      binaryName: this.options.binaryName,
      environmentText: context.environmentText,
      ...createCliPathFingerprintInputs(context.hostnamePath, context.legacyCliPath),
      providerId: this.options.providerId,
    };
    for (const [key, value] of Object.entries(context.resolutionInputs ?? {})) {
      additionalInputs[`provider:${key}`] = value;
    }

    return createRuntimeInputFingerprint({
      additionalInputs,
      environmentKeys: Object.keys(context.environmentVariables),
      environmentText: context.environmentText,
    });
  }
}
