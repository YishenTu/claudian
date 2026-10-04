/** @jest-environment jsdom */

import {
  escapePromptXMLAttribute,
  formatPromptXMLCdata,
} from '../../../src/utils/promptXML';

describe('prompt XML utilities', () => {
  it('escapes attribute delimiters and normalizes control whitespace', () => {
    expect(escapePromptXMLAttribute('a "quote" & <tag>\nnext')).toBe(
      'a &quot;quote&quot; &amp; &lt;tag&gt;&#10;next',
    );
  });

  it('preserves readable body text while splitting CDATA terminators', () => {
    expect(formatPromptXMLCdata('a < b && marker === "]]>"]')).toBe(
      '<![CDATA[a < b && marker === "]]]]><![CDATA[>"]]]>',
    );
  });

  it('normalizes XML-invalid characters into a parseable fragment', () => {
    const path = escapePromptXMLAttribute('note\0\ud800.md');
    const body = formatPromptXMLCdata('body\f\udfff]]>tail');
    const xml = `<context path="${path}">${body}</context>`;
    const document = new DOMParser().parseFromString(xml, 'application/xml');

    expect(path).toBe('note\ufffd\ufffd.md');
    expect(document.querySelector('parsererror')).toBeNull();
    expect(document.documentElement.textContent).toBe('body\ufffd\ufffd]]>tail');
  });
});
