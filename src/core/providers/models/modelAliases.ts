export function decodeModelAliases(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([id, alias]) =>
    id.trim() && typeof alias === 'string' && alias.trim() ? [[id.trim(), alias.trim()]] : []));
}
