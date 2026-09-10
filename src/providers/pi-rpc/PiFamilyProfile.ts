import type { PiFamilyModelContract } from './models';
import type { PiFamilySettingsAccess } from './settings';

/**
 * Binds the shared pi-family RPC engine to one provider distribution (pi, omp).
 * The wire protocol is pi's; distributions differ in binary name, package
 * identity, data-directory names, and model-id encoding prefix.
 */
export interface PiFamilyProfile {
  /** Env var holding an absolute agent data dir override (e.g. PI_CODING_AGENT_DIR). */
  readonly agentDirEnvKey: string;
  /** Dot-directory name under vault and home roots (e.g. '.pi', '.omp'). */
  readonly agentDirName: string;
  /** Binary name used for PATH lookup when no explicit CLI path is configured. */
  readonly defaultBinaryName: string;
  /** Human-facing name used in user-visible strings. */
  readonly displayName: string;
  /** Env keys whose changes invalidate persisted sessions (fingerprint inputs). */
  readonly envHashKeys: readonly string[];
  /** Env key patterns exposed through the provider registration. */
  readonly envKeyPatterns: readonly RegExp[];
  /** Model-id encoding prefix including the colon (e.g. 'pi:', 'omp:'). */
  readonly modelIdPrefix: string;
  readonly models: PiFamilyModelContract;
  readonly providerId: string;
  /** Env var holding an absolute sessions dir override (e.g. PI_CODING_AGENT_SESSION_DIR). */
  readonly sessionDirEnvKey: string;
  readonly settings: PiFamilySettingsAccess;
  /** package.json bin key used to resolve the entrypoint behind npm-style shims on Windows. */
  readonly windowsBinKey: string;
  /** npm package owning the CLI, used to resolve the real entrypoint behind .cmd shims on Windows. */
  readonly windowsPackageName: string;
  /** Windows npm shim file name (e.g. 'pi.cmd', 'omp.cmd'). */
  readonly windowsShimName: string;
}
