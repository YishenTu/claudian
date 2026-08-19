import {
  createBundledHighlighter,
  createCssVariablesTheme,
  createSingletonShorthands,
  getTokenStyleObject,
  stringifyTokenStyle,
} from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import { createOnigurumaEngine } from '@shikijs/engine-oniguruma';

export const bundledLanguages = Object.freeze({});

export const createHighlighter = createBundledHighlighter({
  engine: createJavaScriptRegexEngine,
  langs: bundledLanguages,
  themes: {},
});

export const { codeToHtml } = createSingletonShorthands(createHighlighter);

export {
  createCssVariablesTheme,
  createJavaScriptRegexEngine,
  createOnigurumaEngine,
  getTokenStyleObject,
  stringifyTokenStyle,
};
