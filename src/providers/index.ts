import type {
  ProviderId,
  ProviderRegistration,
  ProviderWorkspaceRegistration,
} from '../core/providers/types';
import { claudeWorkspaceRegistration } from './claude/app/ClaudeWorkspaceServices';
import { claudeProviderRegistration } from './claude/registration';
import { codexWorkspaceRegistration } from './codex/app/CodexWorkspaceServices';
import { codexProviderRegistration } from './codex/registration';

export const PROVIDER_REGISTRATIONS: Partial<Record<ProviderId, ProviderRegistration>> = {
  claude: claudeProviderRegistration,
  codex: codexProviderRegistration,
};

export const PROVIDER_WORKSPACE_REGISTRATIONS: Partial<Record<ProviderId, ProviderWorkspaceRegistration>> = {
  claude: claudeWorkspaceRegistration,
  codex: codexWorkspaceRegistration,
};
