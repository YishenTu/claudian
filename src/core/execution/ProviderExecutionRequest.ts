import type { BrowserSelectionContext } from '@/core/prompt/browserContext';
import type { CanvasSelectionContext } from '@/core/prompt/canvasContext';
import type { EditorSelectionContext } from '@/core/prompt/editorContext';

import type { ChatMessage, ImageAttachment } from '../types';

export type ProviderExecutionInputBlock =
  | {
      readonly type: 'text';
      readonly text: string;
    }
  | {
      readonly type: 'image';
      readonly image: ImageAttachment;
    };

export interface ProviderLinkedContentContext {
  readonly path: string;
  readonly content?: string;
}

export interface ProviderSessionReference {
  readonly id: string;
  readonly title: string;
  readonly providerId: string;
  readonly updatedAt: string;
}

export type ProviderSelectionSnapshot =
  | { readonly kind: 'editor'; readonly selection: EditorSelectionContext }
  | { readonly kind: 'browser'; readonly selection: BrowserSelectionContext }
  | { readonly kind: 'canvas'; readonly selection: CanvasSelectionContext };

export interface ProviderExecutionContext {
  /** Selections in capture order. */
  readonly selections?: readonly ProviderSelectionSnapshot[];
  readonly sessionReferences?: readonly ProviderSessionReference[];
  readonly linkedContent?: ProviderLinkedContentContext;
}

/**
 * Resolved per request, so they may differ between sessions and change between turns: a change applies from the
 * session's next turn, never mid-turn. A provider may refuse a change for a non-persistent session (a side chat) whose
 * context a restart would lose; keep such a session's instructions fixed for its lifetime.
 *
 * Both kinds carry literal text resolved by the caller; adapters only deliver it through their native transport and
 * never compose or substitute prompts themselves. The kind tells adapters which transport framing applies.
 */
export type ProviderSystemInstructions =
  | {
      /** The default Main Agent prompt, built by the shared core prompt builder. */
      readonly kind: 'main-agent';
      readonly instructions: string;
    }
  | {
      readonly kind: 'explicit';
      readonly instructions: string;
    };

export interface ProviderExecutionConfiguration {
  readonly systemInstructions: ProviderSystemInstructions;
  readonly model?: string;
  /** Explicit choices cannot be replaced by saved defaults. Null omits the native override; undefined permits auxiliary defaults. */
  readonly reasoning?: string | null;
  readonly permissionMode?: string;
  readonly serviceTier?: string;
  /** Request a transient next-prompt prediction, subject to provider settings and support. Omitted for auxiliary work. */
  readonly promptSuggestions?: boolean;
}

export type ProviderToolPolicy =
  | {
      readonly kind: 'passive';
    }
  | {
      readonly kind: 'read-only';
    }
  | {
      readonly kind: 'provider-default';
    }
  | {
      readonly kind: 'unrestricted';
    }
  | {
      readonly kind: 'allow-list';
      readonly names: readonly string[];
    };

/**
 * Canonical provider-neutral input for one requested execution.
 *
 * Provider backends resolve their own settings at execution time and map this
 * desired configuration into their native protocol. This contract deliberately
 * carries no feature-purpose discriminator, provider credentials, environment,
 * or opaque provider settings bag.
 */
export interface ProviderExecutionRequest {
  /** Opaque caller identity a provider can return with a user-message echo, including a delayed steer. */
  readonly inputId?: string;
  readonly input: readonly ProviderExecutionInputBlock[];
  readonly context?: ProviderExecutionContext;
  readonly conversationHistory?: readonly ChatMessage[];
  readonly configuration: ProviderExecutionConfiguration;
  readonly toolPolicy: ProviderToolPolicy;
  readonly signal: AbortSignal;
}
