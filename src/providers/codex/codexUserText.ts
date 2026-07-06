const CODEX_IMAGE_OPEN_TAG_PATTERN = /^<image\b[^>]*>$/i;
const CODEX_IMAGE_CLOSE_TAG_PATTERN = /^<\/image>$/i;
const CODEX_EMPTY_IMAGE_TAG_PATTERN = /^<image\b[^>]*>\s*<\/image>$/i;
const CODEX_EMPTY_IMAGE_TAG_PATTERN_GLOBAL = /<image\b[^>]*>\s*<\/image>\s*/gi;

export function stripCodexImagePlaceholderText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }

  if (
    CODEX_IMAGE_OPEN_TAG_PATTERN.test(trimmed)
    || CODEX_IMAGE_CLOSE_TAG_PATTERN.test(trimmed)
    || CODEX_EMPTY_IMAGE_TAG_PATTERN.test(trimmed)
  ) {
    return '';
  }

  return text.replace(CODEX_EMPTY_IMAGE_TAG_PATTERN_GLOBAL, '');
}

export function joinCodexUserTextParts(parts: readonly string[], separator = ''): string {
  return parts
    .map(stripCodexImagePlaceholderText)
    .filter(text => text.length > 0)
    .join(separator);
}
