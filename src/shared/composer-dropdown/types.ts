import type { ProviderCommandKind } from '@/core/providers/commands/ProviderCommandEntry';

/** Text/caret contract shared by native inputs and the Main Chat rich editor. */
export interface ComposerInputElement extends HTMLElement {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  placeholder: string;
  replaceText?: (from: number, to: number, text: string) => void;
  /** Transient placeholder presentation, never part of value or undo history. */
  setGhostText?: (text: string | null) => void;
  /** Lets an input present completed command and skill tokens; setting it again re-resolves them. */
  setCommandResolver?: (resolver: ComposerCommandResolver | null) => void;
  /** Completed chips are not editable completion queries. */
  isChipRange?: (from: number, to: number) => boolean;
}

export type ComposerCommandResolver = (token: string, atInputStart: boolean) => ProviderCommandKind | null;

export interface ComposerTriggerMatch {
  readonly atInputStart: boolean;
  readonly end: number;
  readonly query: string;
  readonly start: number;
  readonly trigger: string;
}

export interface ComposerDropdownValueItem {
  readonly className?: string;
  readonly detail?: string;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly id: string;
  readonly kind: 'value';
  readonly label: string;
  readonly replacement: string;
  readonly value?: unknown;
}

export interface ComposerDropdownFolderItem {
  readonly className?: string;
  readonly detail?: string;
  readonly disabled?: boolean;
  readonly icon?: string;
  readonly id: string;
  readonly inputPrefix?: string;
  readonly kind: 'folder';
  readonly label: string;
  load(
    query: string,
    signal: AbortSignal,
  ): Promise<readonly ComposerDropdownItem[]> | readonly ComposerDropdownItem[];
}

export interface ComposerDropdownStatusItem {
  readonly className?: string;
  readonly detail?: string;
  readonly id: string;
  readonly kind: 'status';
  readonly label: string;
  readonly state: 'empty' | 'error' | 'loading';
}

export type ComposerDropdownItem =
  | ComposerDropdownValueItem
  | ComposerDropdownFolderItem
  | ComposerDropdownStatusItem;

export type ComposerSelectionAction =
  | { readonly kind: 'none' }
  | {
    readonly kind: 'invoke';
    readonly onApplied: () => void;
  }
  | {
    readonly kind: 'replace';
    readonly text: string;
  };

export interface ComposerDropdownSource {
  readonly id: string;
  onOpen?(): void;
  readonly inputLoadPolicy?: 'debounced' | 'immediate';
  load(
    match: ComposerTriggerMatch,
    signal: AbortSignal,
  ): Promise<readonly ComposerDropdownItem[]> | readonly ComposerDropdownItem[];
  match(input: string, cursor: number): ComposerTriggerMatch | null;
  select(
    item: ComposerDropdownValueItem,
    match: ComposerTriggerMatch,
  ): ComposerSelectionAction;
  subscribeInvalidation?(listener: () => void): () => void;
}
