/** Render unknown values without implicit object coercion or circular-JSON failures. */
export function stringifyUnknown(value: unknown): string {
  if (value !== null && typeof value === 'object') {
    try {
      return JSON.stringify(value) ?? '[Unserializable value]';
    } catch {
      return '[Unserializable value]';
    }
  }
  return String(value);
}
