const CODEX_IMAGE_OPEN_TAG_PATTERN = /^<image\b[^>]*>$/i;
const CODEX_IMAGE_CLOSE_TAG_PATTERN = /^<\/image>$/i;
const CODEX_EMPTY_IMAGE_TAG_PATTERN = /^<image\b[^>]*>\s*<\/image>$/i;
const CODEX_EMPTY_IMAGE_TAG_PATTERN_GLOBAL = /<image\b[^>]*>\s*<\/image>\s*/gi;

const CODEX_CONTROL_BLOCK_TAGS = [
  'recommended_plugins',
  'system_instruction',
  'environment_context',
  'turn_aborted',
  'user-preferences',
  'subagent_notification',
  'skill',
];

const CODEX_AGENTS_INSTRUCTIONS_PREFIX = '# AGENTS.md instructions';
const CODEX_AGENTS_INSTRUCTIONS_CLOSE_TAG = '</INSTRUCTIONS>';

function stripLeadingTaggedBlock(text: string, tagName: string): string | null {
  const openTag = `<${tagName}>`;
  if (!text.startsWith(openTag)) {
    return null;
  }

  const closeTag = `</${tagName}>`;
  const closeIndex = text.indexOf(closeTag, openTag.length);
  if (closeIndex === -1) {
    return '';
  }

  return text.slice(closeIndex + closeTag.length);
}

function stripLeadingAgentsInstructions(text: string): string | null {
  if (!text.startsWith(CODEX_AGENTS_INSTRUCTIONS_PREFIX)) {
    return null;
  }

  const closeIndex = text.indexOf(CODEX_AGENTS_INSTRUCTIONS_CLOSE_TAG);
  if (closeIndex === -1) {
    return '';
  }

  return text.slice(closeIndex + CODEX_AGENTS_INSTRUCTIONS_CLOSE_TAG.length);
}

function stripLeadingCodexControlMetadata(text: string): string {
  let remaining = text.trimStart();

  while (remaining) {
    const withoutAgentsInstructions = stripLeadingAgentsInstructions(remaining);
    if (withoutAgentsInstructions !== null) {
      remaining = withoutAgentsInstructions.trimStart();
      continue;
    }

    let strippedTaggedBlock = false;
    for (const tagName of CODEX_CONTROL_BLOCK_TAGS) {
      const next = stripLeadingTaggedBlock(remaining, tagName);
      if (next === null) {
        continue;
      }

      remaining = next.trimStart();
      strippedTaggedBlock = true;
      break;
    }

    if (!strippedTaggedBlock) {
      break;
    }
  }

  return remaining;
}

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

export function extractCodexUserVisibleText(text: string): string | null {
  const withoutImagePlaceholders = stripCodexImagePlaceholderText(text);
  const visible = stripCodexImagePlaceholderText(
    stripLeadingCodexControlMetadata(withoutImagePlaceholders),
  ).trim();

  return visible ? visible : null;
}
