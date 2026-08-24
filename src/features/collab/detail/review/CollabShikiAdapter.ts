import {
  createBundledHighlighter,
  createCssVariablesTheme,
  createSingletonShorthands,
  getTokenStyleObject,
  stringifyTokenStyle,
} from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';

export const bundledLanguages = Object.freeze({});

export const createHighlighter = createBundledHighlighter({
  engine: createJavaScriptRegexEngine,
  langs: bundledLanguages,
  themes: {},
});

export const { codeToHtml } = createSingletonShorthands(createHighlighter);

export function createOnigurumaEngine(): never {
  throw new Error('The Collab text diff renderer does not support Shiki Wasm.');
}

export {
  createCssVariablesTheme,
  createJavaScriptRegexEngine,
  getTokenStyleObject,
  stringifyTokenStyle,
};
