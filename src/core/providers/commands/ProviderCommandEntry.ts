import type { SlashCommandSource } from '../../types/settings';
import type { ProviderId } from '../types';

export type ProviderCommandKind = 'command' | 'skill';
export type ProviderCommandScope = 'builtin' | 'vault' | 'user' | 'system' | 'runtime';

export interface ProviderCommandEntry {
  id: string;
  providerId: ProviderId;
  kind: ProviderCommandKind;
  name: string;
  description?: string;
  content: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  context?: 'fork';
  agent?: string;
  hooks?: Record<string, unknown>;
  scope: ProviderCommandScope;
  source: SlashCommandSource;
  isEditable: boolean;
  isDeletable: boolean;
  displayPrefix: string;
  insertPrefix: string;
  /**
   * Opaque provider-owned persistence token used to preserve storage location
   * across edits, renames, and deletes in shared settings UIs.
   */
  persistenceKey?: string;
}
