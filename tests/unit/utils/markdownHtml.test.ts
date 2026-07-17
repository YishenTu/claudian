import { escapeHtml } from '@/utils/html';
import { escapeRawHtmlTags } from '@/utils/markdownHtml';

describe('markdownHtml', () => {
  describe('escapeRawHtmlTags', () => {
    it('escapes placeholder-style tags and raw HTML exactly', () => {
      expect(
        escapeRawHtmlTags('Use <meta-name> and <span title="A&B">value</span>.')
      ).toBe(
        'Use &lt;meta-name&gt; and &lt;span title=&quot;A&amp;B&quot;&gt;value&lt;/span&gt;.'
      );
    });

    it('preserves inline, fenced, and indented code', () => {
      const markdown = [
        '`<meta-name>` and <meta-name>',
        '```html',
        '<my-component>',
        '```',
        '    <indented-code>',
      ].join('\n');

      expect(escapeRawHtmlTags(markdown)).toBe([
        '`<meta-name>` and &lt;meta-name&gt;',
        '```html',
        '<my-component>',
        '```',
        '    <indented-code>',
      ].join('\n'));
    });

    it('preserves blockquoted and list-nested fences and multiline code spans', () => {
      const markdown = [
        '> ```html',
        '> <blockquote-code>',
        '> ```',
        '- ```html',
        '  <list-code>',
        '  ```',
        '- > ~~~html',
        '  > <nested-code>',
        '  > ~~~',
        '10. ~~~html',
        '    <ordered-list-code>',
        '    ~~~',
        '<after-list>',
        '10. Item',
        '',
        '    ~~~html',
        '    <continued-list-code>',
        '    ~~~',
        '<after-continued-list>',
        '`multiline code',
        '<inline-code>` and <placeholder>',
      ].join('\n');

      expect(escapeRawHtmlTags(markdown)).toBe([
        '> ```html',
        '> <blockquote-code>',
        '> ```',
        '- ```html',
        '  <list-code>',
        '  ```',
        '- > ~~~html',
        '  > <nested-code>',
        '  > ~~~',
        '10. ~~~html',
        '    <ordered-list-code>',
        '    ~~~',
        '&lt;after-list&gt;',
        '10. Item',
        '',
        '    ~~~html',
        '    <continued-list-code>',
        '    ~~~',
        '&lt;after-continued-list&gt;',
        '`multiline code',
        '<inline-code>` and &lt;placeholder&gt;',
      ].join('\n'));
    });

    it('does not close a root fence on container-like code lines', () => {
      const markdown = [
        '```markdown',
        '- ```',
        '> ```',
        '<inside-code>',
        '```',
        '<after-code>',
      ].join('\n');

      expect(escapeRawHtmlTags(markdown)).toBe([
        '```markdown',
        '- ```',
        '> ```',
        '<inside-code>',
        '```',
        '&lt;after-code&gt;',
      ].join('\n'));
    });

    it('does not match multiline code spans across blank-line block boundaries', () => {
      const markdown = [
        'unmatched `',
        '',
        '<meta-name>',
        '',
        '`later',
      ].join('\n');

      expect(escapeRawHtmlTags(markdown)).toBe([
        'unmatched `',
        '',
        '&lt;meta-name&gt;',
        '',
        '`later',
      ].join('\n'));

      const headingBoundary = [
        'unmatched `',
        '# Heading',
        '<meta-name>',
        '`later',
      ].join('\n');
      expect(escapeRawHtmlTags(headingBoundary)).toBe([
        'unmatched `',
        '# Heading',
        '&lt;meta-name&gt;',
        '`later',
      ].join('\n'));
    });

    it('does not match multiline inline spans across container boundaries', () => {
      const markdown = [
        'unmatched `',
        '- <list-placeholder>`',
        'unmatched `',
        '> <quote-placeholder>`',
        'unmatched $x',
        '- <math-list-placeholder>$',
        'unmatched $x',
        '> <math-quote-placeholder>$',
      ].join('\n');

      expect(escapeRawHtmlTags(markdown)).toBe([
        'unmatched `',
        '- &lt;list-placeholder&gt;`',
        'unmatched `',
        '> &lt;quote-placeholder&gt;`',
        'unmatched $x',
        '- &lt;math-list-placeholder&gt;$',
        'unmatched $x',
        '> &lt;math-quote-placeholder&gt;$',
      ].join('\n'));
    });

    it('preserves multiline code spans within the same container paragraph', () => {
      const markdown = [
        '- `list code',
        '  <inside-list>` and <after-list>',
        '> `quote code',
        '> <inside-quote>` and <after-quote>',
        '- > `nested code',
        '  > <inside-nested>` and <after-nested>',
      ].join('\n');

      expect(escapeRawHtmlTags(markdown)).toBe([
        '- `list code',
        '  <inside-list>` and &lt;after-list&gt;',
        '> `quote code',
        '> <inside-quote>` and &lt;after-quote&gt;',
        '- > `nested code',
        '  > <inside-nested>` and &lt;after-nested&gt;',
      ].join('\n'));
    });

    it('preserves angle comparisons inside inline and display math', () => {
      const markdown = '$x<y$ and $a>b$.\n$$c<d \\land d>e$$';
      expect(escapeRawHtmlTags(markdown)).toBe(markdown);
    });

    it('escapes HTML inside invalid inline math delimiters', () => {
      expect(
        escapeRawHtmlTags('Prices are $5 <meta-name> and $10.')
      ).toBe(
        'Prices are $5 &lt;meta-name&gt; and $10.'
      );
      expect(escapeRawHtmlTags('$ x<meta-name>$')).toBe('$ x&lt;meta-name&gt;$');
      expect(escapeRawHtmlTags('$x<meta-name> $')).toBe('$x&lt;meta-name&gt; $');
      expect(escapeRawHtmlTags('$x<meta-name>$10')).toBe('$x&lt;meta-name&gt;$10');
    });

    it('preserves backslash-escaped HTML-like text', () => {
      expect(escapeRawHtmlTags(String.raw`\<meta-name\> and <name>`)).toBe(
        String.raw`\<meta-name\> and &lt;name&gt;`
      );
      expect(escapeRawHtmlTags("\\`<name>\\`")).toBe("\\`&lt;name&gt;\\`");
    });

    it('preserves URI and email autolinks', () => {
      expect(
        escapeRawHtmlTags('<https://example.com/a> <user@example.com> <placeholder>')
      ).toBe(
        '<https://example.com/a> <user@example.com> &lt;placeholder&gt;'
      );
    });

    it('preserves image wikilinks for later embed processing', () => {
      expect(escapeRawHtmlTags('![[<image-name>.png|<alt>]]')).toBe(
        '![[<image-name>.png|<alt>]]'
      );
    });

    it('escapes multiline HTML constructs and declarations', () => {
      const markdown = [
        '<!--',
        '<comment-body>',
        '-->',
        '<span',
        ' title="A&B">',
        'value',
        '</span>',
        '<!DOCTYPE html>',
        '<!doctype html>',
      ].join('\n');

      expect(escapeRawHtmlTags(markdown)).toBe([
        '&lt;!--',
        '&lt;comment-body&gt;',
        '--&gt;',
        '&lt;span',
        ' title=&quot;A&amp;B&quot;&gt;',
        'value',
        '&lt;/span&gt;',
        '&lt;!DOCTYPE html&gt;',
        '&lt;!doctype html&gt;',
      ].join('\n'));
    });

    it.each([
      ['comment', '<!--\n<meta-name>'],
      ['CDATA section', '<![CDATA[\n<meta-name>'],
      ['processing instruction', '<?target\n<meta-name>'],
    ])('escapes an unclosed HTML %s through EOF', (_kind, markdown) => {
      expect(escapeRawHtmlTags(markdown)).toBe(escapeHtml(markdown));
    });

    it('distinguishes paragraph continuation indentation from indented code', () => {
      const markdown = [
        'Use:',
        '    <paragraph-placeholder>',
        '',
        '    <root-code>',
        '',
        '>     <quote-code>',
        '',
        '> Use:',
        '>     <quote-paragraph-placeholder>',
        '',
        '- Use:',
        '      <list-paragraph-placeholder>',
        '',
        '      <list-code>',
        '',
        '# Heading',
        '    <heading-code>',
        '',
        '<!-- closed -->',
        '    <html-following-code>',
      ].join('\n');

      expect(escapeRawHtmlTags(markdown)).toBe([
        'Use:',
        '    &lt;paragraph-placeholder&gt;',
        '',
        '    <root-code>',
        '',
        '>     <quote-code>',
        '',
        '> Use:',
        '>     &lt;quote-paragraph-placeholder&gt;',
        '',
        '- Use:',
        '      &lt;list-paragraph-placeholder&gt;',
        '',
        '      <list-code>',
        '',
        '# Heading',
        '    <heading-code>',
        '',
        '&lt;!-- closed --&gt;',
        '    <html-following-code>',
      ].join('\n'));
    });
  });
});
