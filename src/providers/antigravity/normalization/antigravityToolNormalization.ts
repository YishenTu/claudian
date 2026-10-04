import {
  ACPToolStreamAdapter,
  type ACPToolStreamPresentationAdapter,
} from '@/providers/acp/ACPToolStreamAdapter';

export const antigravityToolPresentationAdapter: ACPToolStreamPresentationAdapter = {
  normalizeToolInput(_rawName, input) {
    return input;
  },

  normalizeToolName(rawName) {
    if (!rawName) return 'tool';
    const lower = rawName.toLowerCase();
    if (lower.includes('read') || lower.includes('view')) return 'Read';
    if (lower.includes('write') || lower.includes('create') || lower.includes('edit')) return 'Edit';
    if (lower.includes('command') || lower.includes('bash') || lower.includes('terminal') || lower.includes('exec')) return 'Bash';
    if (lower.includes('plan')) return 'Plan';
    return rawName;
  },

  normalizeToolResultDetails() {
    return undefined;
  },

  resolveRawToolName(current, update) {
    const rawName = update.title || update.kind || current?.rawName || 'tool';
    return {
      provenance: update.title ? 'title' : update.kind ? 'kind' : 'fallback',
      rawName,
    };
  },
};

export function createAntigravityToolStreamAdapter(): ACPToolStreamAdapter {
  return new ACPToolStreamAdapter(antigravityToolPresentationAdapter);
}
