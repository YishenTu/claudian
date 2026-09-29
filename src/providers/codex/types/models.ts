export type CodexModel = string;

export const CODEX_SPARK_MODEL: CodexModel = 'gpt-5.3-codex-spark';

/** Formats a Codex model id or hyphenated app-server name: `gpt-6-astra` → `GPT-6 Astra`. */
export function formatCodexModelLabel(name: string): string {
  const match = name.match(/^gpt-(\d[^-\s]*)(?:-(\S+))?$/i);
  if (!match) {
    return name;
  }

  const [, version, suffix] = match;
  const words = suffix?.split('-').filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1)) ?? [];
  return [`GPT-${version}`, ...words].join(' ');
}
