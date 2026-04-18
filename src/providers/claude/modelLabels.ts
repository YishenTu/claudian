function getFamilyDisplayName(family: string): string {
  return family.charAt(0).toUpperCase() + family.slice(1).toLowerCase();
}

function formatClaudeModelDateTag(date: string | undefined): string | null {
  if (!date || date.length < 6) {
    return null;
  }

  return `(${date.slice(2, 6)})`;
}

export function getCustomModelLabelSource(modelId: string): string {
  if (!modelId.includes('/')) {
    return modelId;
  }

  return modelId.split('/').pop() || modelId;
}

export function formatGenericCustomModelLabel(labelSource: string): string {
  return labelSource
    .replace(/-/g, ' ')
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

export function formatClaudeCustomModelLabel(labelSource: string): string | null {
  const trimmed = labelSource.trim();
  if (!trimmed) {
    return null;
  }

  const is1M = trimmed.toLowerCase().endsWith('[1m]');
  const without1M = is1M ? trimmed.slice(0, -4) : trimmed;
  const claudePrefixIndex = without1M.toLowerCase().indexOf('claude-');
  const candidate = claudePrefixIndex >= 0 ? without1M.slice(claudePrefixIndex) : without1M;

  const versionedMatch = candidate.match(
    /^claude-(haiku|sonnet|opus)-(\d+)-(\d+)(?:-(\d{8}))?(?:-v\d+:\d+)?$/i,
  );
  if (versionedMatch) {
    const [, family, major, minor, date] = versionedMatch;
    const suffixes = [
      formatClaudeModelDateTag(date),
      is1M ? '(1M)' : null,
    ].filter(Boolean).join(' ');
    return `${getFamilyDisplayName(family)} ${major}.${minor}${suffixes ? ` ${suffixes}` : ''}`;
  }

  const majorOnlyMatch = candidate.match(
    /^claude-(haiku|sonnet|opus)-(\d+)(?:-(\d{8}))?(?:-v\d+:\d+)?$/i,
  );
  if (majorOnlyMatch) {
    const [, family, major, date] = majorOnlyMatch;
    const suffixes = [
      formatClaudeModelDateTag(date),
      is1M ? '(1M)' : null,
    ].filter(Boolean).join(' ');
    return `${getFamilyDisplayName(family)} ${major}${suffixes ? ` ${suffixes}` : ''}`;
  }

  return null;
}
