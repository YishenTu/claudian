import type { ProviderHostStorage } from '../bootstrap/storage';
import type { SessionToolEndpoint } from '../session-tools/SessionToolEndpoint';
import type { ProviderCLIResolutionContext } from './types';

/** Execution preferences a runtime falls back to when a request leaves them unset. */
export interface ProviderSelectionDefaults {
  readonly model?: string;
  readonly effortLevel?: string;
  readonly permissionMode?: string;
  readonly serviceTier?: string;
}

/** The application's current selections, as inputs to provider configuration decoding. */
export interface ProviderSelectionInputs extends ProviderSelectionDefaults {
  /** Model ids the current, title-generation and saved selections reference; their metadata is kept. */
  readonly referencedModelIds: readonly string[];
}

/**
 * Live, provider-scoped capabilities for provider runtime code. Every read reflects
 * the committed application state; nothing is cached. Runtime code decodes `config`
 * with its own provider configuration module and never sees the application's
 * settings document.
 */
export interface ProviderRuntimeHost {
  /** A copy of the stored configuration this provider owns. */
  readonly config: Readonly<Record<string, unknown>>;
  /** Current selections as stored, whichever provider they were made for. */
  readonly selection: ProviderSelectionInputs;
  /**
   * The selections the settings projection shows for this provider: each saved preference,
   * else a current selection this provider can reuse, else its default, normalized and
   * migrated by its model and permission policies.
   */
  readonly providerSelection: ProviderSelectionDefaults;
  /**
   * The preferences saved for this provider, verbatim: a field is undefined when none is
   * saved, and no normalization, migration or fallback applies.
   */
  readonly savedSelection: ProviderSelectionDefaults;
  /** Shared plus provider-scoped environment variable text. */
  readonly environmentText: string;
  readonly locale: string;
  readonly clientVersion?: string;
  /** Absolute local directory provider processes run in; null when the host has no local directory. */
  readonly workingDirectory: string | null;
  readonly storage: ProviderHostStorage;
  /** Loopback endpoint through which shared provider processes reach main-chat session tools. */
  readonly sessionToolEndpoint: SessionToolEndpoint;

  resolveCliPath(context?: ProviderCLIResolutionContext): Promise<string | null>;
  notifyChatOptionsChanged(): void;
  /**
   * Updates this provider's stored configuration in one settings transaction. The
   * mutation edits a private copy of the current configuration; returning false
   * discards it without writing. Resolves to whether the configuration was written.
   */
  updateConfig(
    mutation: (
      config: Record<string, unknown>,
      selection: ProviderSelectionInputs,
    ) => boolean | Promise<boolean>,
  ): Promise<boolean>;
}
