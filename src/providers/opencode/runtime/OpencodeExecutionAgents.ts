import type { OpencodeExecutionProfile } from '../execution/OpencodeSessionContract';
import type { OpencodeManagedAgentConfig } from './OpencodeLaunchArtifacts';

/** OpenCode's native default agent; the main chat runs on it in every permission mode. */
export const OPENCODE_BUILD_AGENT_ID = 'build';

export const AUX_AGENT_IDS: Record<Exclude<OpencodeExecutionProfile, 'managed'>, string> = {
  passive: 'claudian-title',
  readonly: 'claudian-inline-edit',
};

const READ_PERMISSION = Object.freeze({
  '*': 'allow',
  '*.env': 'deny',
  '*.env.*': 'deny',
  '*.env.example': 'allow',
});

export function buildAgentConfig(
  profile: Exclude<OpencodeExecutionProfile, 'managed'>,
): OpencodeManagedAgentConfig {
  return profile === 'readonly'
    ? {
      definition: {
        description: 'Claudian read-only execution agent.',
        mode: 'primary',
        permission: {
          '*': 'deny',
          codesearch: 'allow',
          external_directory: 'deny',
          glob: 'allow',
          grep: 'allow',
          lsp: 'allow',
          read: READ_PERMISSION,
          webfetch: 'allow',
          websearch: 'allow',
        },
      },
      id: AUX_AGENT_IDS.readonly,
    }
    : {
      definition: {
        description: 'Claudian passive execution agent.',
        mode: 'primary',
        permission: {
          '*': 'deny',
          external_directory: 'deny',
        },
      },
      id: AUX_AGENT_IDS.passive,
    };
}
