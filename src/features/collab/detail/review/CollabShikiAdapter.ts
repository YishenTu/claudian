interface PlainTextTheme {
  readonly bg?: string;
  readonly colors?: Readonly<Record<string, string>>;
  readonly fg?: string;
  readonly name: string;
  readonly type?: 'dark' | 'light';
}

interface HastText {
  readonly type: 'text';
  value: string;
}

interface HastElement {
  children: HastNode[];
  properties: Record<string, unknown>;
  tagName: string;
  readonly type: 'element';
}

interface HastRoot {
  children: HastNode[];
  readonly type: 'root';
}

type HastNode = HastElement | HastText;

interface PlainTextToken {
  __lineChar?: number;
  readonly content: string;
  readonly lineCharacter: number;
  readonly offset: number;
}

interface ShikiTransformer {
  code?(this: TransformerContext, node: HastElement): HastElement | void;
  line?(this: TransformerContext, node: HastElement, line: number): HastElement | void;
  preprocess?(this: TransformerContext, code: string, options: CodeToHastOptions): string | void;
  pre?(this: TransformerContext, node: HastElement): HastElement | void;
  root?(this: TransformerContext, node: HastRoot): HastRoot | void;
  span?(
    this: TransformerContext,
    node: HastElement,
    line: number,
    column: number,
    lineNode: HastElement,
    token: PlainTextToken,
  ): HastElement | void;
  tokens?(this: TransformerContext, tokens: PlainTextToken[][]): PlainTextToken[][] | void;
}

interface DecorationPosition {
  readonly character: number;
  readonly line: number;
}

interface PlainTextDecoration {
  readonly end: DecorationPosition;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly start: DecorationPosition;
}

interface CodeToHastOptions {
  readonly decorations?: readonly PlainTextDecoration[];
  readonly transformers?: readonly ShikiTransformer[];
}

interface TransformerContext {
  readonly meta: Record<string, unknown>;
  readonly options: CodeToHastOptions;
  readonly source: string;
}

interface TokenStyle {
  readonly bgColor?: string;
  readonly color?: string;
  readonly fontStyle?: number;
  readonly htmlStyle?: Readonly<Record<string, string>> | string;
}

const EMPTY_LANGUAGES = Object.freeze({});

export const bundledLanguages = EMPTY_LANGUAGES;

export function createHighlighter(): PlainTextHighlighter {
  return new PlainTextHighlighter();
}

export function createJavaScriptRegexEngine(): Readonly<Record<string, never>> {
  return Object.freeze({});
}

export function createOnigurumaEngine(): never {
  throw new Error('The Collab text diff renderer does not support Shiki Wasm.');
}

export function createCssVariablesTheme(options: {
  readonly name?: string;
  readonly variablePrefix?: string;
} = {}): PlainTextTheme {
  const prefix = options.variablePrefix ?? '--shiki-';
  return {
    bg: `var(${prefix}background)`,
    colors: {
      'editor.background': `var(${prefix}background)`,
      'editor.foreground': `var(${prefix}foreground)`,
    },
    fg: `var(${prefix}foreground)`,
    name: options.name ?? 'css-variables',
    type: 'dark',
  };
}

export function getTokenStyleObject(token: TokenStyle): Record<string, string> {
  const style: Record<string, string> = {};
  if (token.color) style.color = token.color;
  if (token.bgColor) style['background-color'] = token.bgColor;
  if (token.fontStyle) {
    if ((token.fontStyle & 1) !== 0) style['font-style'] = 'italic';
    if ((token.fontStyle & 2) !== 0) style['font-weight'] = 'bold';
    const decorations: string[] = [];
    if ((token.fontStyle & 4) !== 0) decorations.push('underline');
    if ((token.fontStyle & 8) !== 0) decorations.push('line-through');
    if (decorations.length > 0) style['text-decoration'] = decorations.join(' ');
  }
  return style;
}

export function stringifyTokenStyle(style: Readonly<Record<string, string>> | string): string {
  if (typeof style === 'string') return style;
  return Object.entries(style).map(([key, value]) => `${key}:${value}`).join(';');
}

export function codeToHtml(code: string): string {
  return `<pre><code>${escapeHtml(code)}</code></pre>`;
}

export function transformerStyleToClass(): Readonly<Record<string, never>> {
  return Object.freeze({});
}

class PlainTextHighlighter {
  private readonly themes = new Map<string, PlainTextTheme>();

  codeToHast(source: string, options: CodeToHastOptions): HastRoot {
    const transformers = options.transformers ?? [];
    const context: TransformerContext = { meta: {}, options, source };
    let transformedSource = source;
    for (const transformer of transformers) {
      transformedSource = transformer.preprocess?.call(context, transformedSource, options)
        ?? transformedSource;
    }

    let lineOffset = 0;
    let tokens = transformedSource.split('\n').map((line, lineIndex) => {
      const lineTokens = tokensForLine(
        line,
        lineIndex,
        lineOffset,
        options.decorations ?? [],
      );
      lineOffset += line.length + 1;
      return lineTokens;
    });
    for (const transformer of transformers) {
      tokens = transformer.tokens?.call(context, tokens) ?? tokens;
    }

    const code: HastElement = element('code');
    for (let lineIndex = 0; lineIndex < tokens.length; lineIndex += 1) {
      if (lineIndex > 0) code.children.push(text('\n'));
      let line = element('span', { class: 'line' });
      let column = 0;
      for (const token of tokens[lineIndex]) {
        let span = element('span', tokenProperties(token, lineIndex, options.decorations ?? []));
        span.children.push(text(token.content));
        for (const transformer of transformers) {
          span = transformer.span?.call(context, span, lineIndex + 1, column, line, token) ?? span;
        }
        line.children.push(span);
        column += token.content.length;
      }
      for (const transformer of transformers) {
        line = transformer.line?.call(context, line, lineIndex + 1) ?? line;
      }
      code.children.push(line);
    }

    let transformedCode = code;
    for (const transformer of transformers) {
      transformedCode = transformer.code?.call(context, transformedCode) ?? transformedCode;
    }
    let pre = element('pre');
    pre.children.push(transformedCode);
    for (const transformer of transformers) {
      pre = transformer.pre?.call(context, pre) ?? pre;
    }
    let root: HastRoot = { children: [pre], type: 'root' };
    for (const transformer of transformers) {
      root = transformer.root?.call(context, root) ?? root;
    }
    return root;
  }

  dispose(): void {
    this.themes.clear();
  }

  getTheme(name: string): PlainTextTheme {
    const theme = this.themes.get(name);
    if (!theme) throw new Error(`Unknown Collab diff theme: ${name}`);
    return theme;
  }

  loadThemeSync(theme: PlainTextTheme): void {
    this.themes.set(theme.name, theme);
  }
}

function tokensForLine(
  line: string,
  lineIndex: number,
  lineOffset: number,
  decorations: readonly PlainTextDecoration[],
): PlainTextToken[] {
  const boundaries = new Set([0, line.length]);
  for (const decoration of decorations) {
    if (decoration.start.line !== lineIndex || decoration.end.line !== lineIndex) continue;
    boundaries.add(decoration.start.character);
    boundaries.add(decoration.end.character);
  }
  const sortedBoundaries = [...boundaries].sort((left, right) => left - right);
  const tokens: PlainTextToken[] = [];
  for (let index = 1; index < sortedBoundaries.length; index += 1) {
    const start = sortedBoundaries[index - 1];
    const end = sortedBoundaries[index];
    tokens.push({
      content: line.slice(start, end),
      lineCharacter: start,
      offset: lineOffset + start,
    });
  }
  return tokens;
}

function tokenProperties(
  token: PlainTextToken,
  lineIndex: number,
  decorations: readonly PlainTextDecoration[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const character = token.lineCharacter;
  const tokenEnd = character + token.content.length;
  for (const decoration of decorations) {
    if (
      decoration.start.line !== lineIndex
      || decoration.end.line !== lineIndex
      || decoration.start.character > character
      || decoration.end.character < tokenEnd
    ) continue;
    Object.assign(properties, decoration.properties);
  }
  return properties;
}

function element(
  tagName: string,
  properties: Record<string, unknown> = {},
): HastElement {
  return { children: [], properties, tagName, type: 'element' };
}

function text(value: string): HastText {
  return { type: 'text', value };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
