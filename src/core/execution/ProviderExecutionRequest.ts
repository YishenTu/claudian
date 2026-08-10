import type { BrowserSelectionContext } from '../../utils/browser';
import type { CanvasSelectionContext } from '../../utils/canvas';
import type { EditorSelectionContext } from '../../utils/editor';
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

export interface ProviderCurrentNoteContext {
  readonly path: string;
  readonly content?: string;
}

export interface ProviderExecutionContext {
  readonly currentNote?: ProviderCurrentNoteContext;
  readonly editorSelection?: EditorSelectionContext | null;
  readonly browserSelection?: BrowserSelectionContext | null;
  readonly canvasSelection?: CanvasSelectionContext | null;
  readonly externalContextPaths?: readonly string[];
}

export type ProviderSystemInstructions =
  | {
      readonly kind: 'provider-default';
    }
  | {
      readonly kind: 'explicit';
      readonly instructions: string;
    };

export interface ProviderExecutionConfiguration {
  readonly systemInstructions: ProviderSystemInstructions;
  readonly model?: string;
  readonly reasoning?: string;
  readonly permissionMode?: string;
  readonly mode?: string;
  readonly serviceTier?: string;
  readonly externalWorkspaceRoots?: readonly string[];
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
  readonly input: readonly ProviderExecutionInputBlock[];
  readonly context?: ProviderExecutionContext;
  readonly conversationHistory?: readonly ChatMessage[];
  readonly configuration: ProviderExecutionConfiguration;
  readonly toolPolicy: ProviderToolPolicy;
  readonly signal: AbortSignal;
}
