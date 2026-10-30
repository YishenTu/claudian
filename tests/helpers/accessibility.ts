import type { AxeResults, ImpactValue, RunOptions, Spec } from 'axe-core';
import axeCore from 'axe-core';
import merge from 'es-toolkit/compat/merge';

export interface AxeRunOptions extends RunOptions {
  impactLevels?: ImpactValue[];
}

export interface AxeConfiguration extends AxeRunOptions {
  globalOptions?: Spec;
}

const colorRuleIDs = axeCore.getRules(['cat.color']).map(rule => rule.ruleId);

function mountForScan(html: Element | string): { element: Element; restore(): void } {
  if (html && typeof html === 'object' && typeof html.tagName === 'string') {
    if (document.body.contains(html)) return { element: html, restore() {} };
    html = html.outerHTML;
  }
  if (typeof html !== 'string') {
    throw new Error('html parameter should be an HTML string or an HTML element');
  }
  if (!/(<([^>]+)>)/i.test(html)) {
    throw new Error(`html parameter ("${html}") has no elements`);
  }
  const originalHTML = document.body.innerHTML;
  document.body.innerHTML = html;
  return {
    element: document.body,
    restore() { document.body.innerHTML = originalHTML; },
  };
}

export function configureAxe({ globalOptions = {}, ...defaults }: AxeConfiguration = {}) {
  const { rules = [], ...configuration } = globalOptions;
  // jsdom cannot measure color contrast. Explicit caller rules can re-enable it.
  axeCore.configure({
    rules: [...colorRuleIDs.map(id => ({ id, enabled: false })), ...rules],
    ...configuration,
  });
  return (html: Element | string, options: AxeRunOptions = {}): Promise<AxeResults> => {
    const mounted = mountForScan(html);
    const runOptions = merge({}, defaults, options);
    return new Promise((resolve, reject) => {
      axeCore.run(mounted.element, runOptions, (error, results) => {
        mounted.restore();
        if (error) reject(error);
        else resolve(results);
      });
    });
  };
}

export const axe = configureAxe();

export const toHaveNoViolations = {
  toHaveNoViolations(results: AxeResults) {
    if (typeof results.violations === 'undefined') {
      throw new Error('Accessibility results have no violations property. Use a reporter that returns standard axe results.');
    }
    const impacts = (results.toolOptions as AxeRunOptions | undefined)?.impactLevels;
    const violations = impacts?.length
      ? results.violations.filter(violation => impacts.includes(violation.impact as ImpactValue))
      : results.violations;
    const report = violations.flatMap(violation => violation.nodes.map(node => [
      `${violation.help} (${violation.id})`,
      `Selector: ${node.target.join(', ')}`,
      node.html,
      node.failureSummary,
      violation.helpUrl,
    ].filter(Boolean).join('\n'))).join('\n\n');
    return {
      actual: violations,
      pass: report.length === 0,
      message: () => report
        ? `Accessibility violations:\n\n${report}`
        : 'Expected accessibility violations, but none were found.',
    };
  },
};
