/**
 * Slash command warning formatter.
 *
 * Used by multiple UI entry points (main chat view, inline edit modal).
 */

export function formatSlashCommandWarnings(errors: string[]): string {
  const maxItems = 3;
  const head = errors.slice(0, maxItems);
  const more = errors.length > maxItems ? `\n...and ${errors.length - maxItems} more` : '';
  return `Slash command expansion warnings:\n- ${head.join('\n- ')}${more}`;
}
