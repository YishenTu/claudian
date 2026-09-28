import { getInstallationKey } from '@/core/device/InstallationKey';

import { findCLIBinaryPath, resolveConfiguredCLIPath } from '../../../utils/cliBinaryLocator';
import { parseEnvironmentVariables } from '../../../utils/env';
import { createRuntimeInputFingerprint } from '../settings/RuntimeInputFingerprint';
import { createCLIPathFingerprintInputs } from './CLIPathFingerprintInputs';

export interface ProviderCLISettingsProjection {
  cliPathsByHost?: Readonly<Record<string, string>>;
  environmentText: string;
  legacyCliPath?: string;
  resolutionInputs?: Readonly<Record<string, string | undefined>>;
}

export interface ProviderCLIResolutionContext extends ProviderCLISettingsProjection {
  environmentVariables: Readonly<Record<string, string>>;
  hostnamePath: string;
  legacyCliPath: string;
}

type ProviderCLIResolution = (
  context: ProviderCLIResolutionContext,
  resolveDefault: () => string | null,
) => string | null;

export interface CachedProviderCLIResolverOptions {
  binaryName: string;
  findBinaryPath?: (additionalPath?: string) => string | null;
  getSettingsProjection: (settings: Record<string, unknown>) => ProviderCLISettingsProjection;
  hostnameKey?: string;
  providerId: string;
  resolve?: ProviderCLIResolution;
  shouldCache?: (result: string | null, context: ProviderCLIResolutionContext) => boolean;
}

export class CachedProviderCLIResolver {
  private cacheKey = '';
  private cacheValid = false;
  private cachedResolution: string | null = null;
  private readonly hostnameKey: string;

  constructor(private readonly options: CachedProviderCLIResolverOptions) {
    this.hostnameKey = options.hostnameKey ?? getInstallationKey();
  }

  resolveFromSettings(
    settings: Record<string, unknown>,
    resolutionInputs?: ProviderCLISettingsProjection['resolutionInputs'],
  ): string | null {
    const projection = this.options.getSettingsProjection(settings);
    return this.resolve({
      ...projection,
      resolutionInputs: { ...projection.resolutionInputs, ...resolutionInputs },
    });
  }

  resolve(projection: ProviderCLISettingsProjection): string | null {
    const context = this.#createResolutionContext(projection);
    const cacheKey = this.#createCacheKey(context);
    if (this.cacheValid && cacheKey === this.cacheKey) {
      return this.cachedResolution;
    }

    const resolveDefault = (): string | null => (
      resolveConfiguredCLIPath(context.hostnamePath)
      ?? resolveConfiguredCLIPath(context.legacyCliPath)
      ?? (this.options.findBinaryPath
        ? this.options.findBinaryPath(context.environmentVariables.PATH)
        : findCLIBinaryPath(this.options.binaryName, context.environmentVariables.PATH))
    );

    this.cachedResolution = this.options.resolve
      ? this.options.resolve(context, resolveDefault)
      : resolveDefault();
    this.cacheKey = cacheKey;
    this.cacheValid = this.options.shouldCache?.(this.cachedResolution, context) ?? true;
    return this.cachedResolution;
  }

  reset(): void {
    this.cacheKey = '';
    this.cacheValid = false;
    this.cachedResolution = null;
  }

  #createResolutionContext(
    projection: ProviderCLISettingsProjection,
  ): ProviderCLIResolutionContext {
    const environmentText = projection.environmentText || '';
    return {
      ...projection,
      environmentText,
      environmentVariables: parseEnvironmentVariables(environmentText),
      hostnamePath: (projection.cliPathsByHost?.[this.hostnameKey] ?? '').trim(),
      legacyCliPath: (projection.legacyCliPath ?? '').trim(),
    };
  }

  #createCacheKey(context: ProviderCLIResolutionContext): string {
    const additionalInputs: Record<string, string | undefined> = {
      binaryName: this.options.binaryName,
      environmentText: context.environmentText,
      ...createCLIPathFingerprintInputs(context.hostnamePath, context.legacyCliPath),
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
