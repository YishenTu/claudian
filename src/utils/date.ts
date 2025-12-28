/**
 * Claudian - Date Utilities
 *
 * Date formatting helpers for system prompts.
 */

/** Returns today's date in readable and ISO format for the system prompt. */
export function getTodayDate(): string {
  const now = new Date();
  const readable = now.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const iso = now.toISOString().split('T')[0];
  return `${readable} (${iso})`;
}
