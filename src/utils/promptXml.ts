function normalizePromptXmlCharacters(value: string): string {
  let normalized = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    const isValidXmlCharacter = codePoint === 0x09
      || codePoint === 0x0a
      || codePoint === 0x0d
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    normalized += isValidXmlCharacter ? character : '\ufffd';
  }
  return normalized;
}

export function escapePromptXmlAttribute(value: string): string {
  return normalizePromptXmlCharacters(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}

export function formatPromptXmlCdata(value: string): string {
  const normalized = normalizePromptXmlCharacters(value);
  return `<![CDATA[${normalized.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}
