import * as terserProductionBundleHelpers from '../../../scripts/terserProductionBundle.js';

const { minifyProductionBundle } = terserProductionBundleHelpers;

describe('production bundle minification', () => {
  it('preserves CommonJS behavior and license comments while reducing output', async () => {
    const source = `
      /*! Example dependency license */
      function computeVisibleResult(firstValue, secondValue) {
        const unusedIntermediateName = firstValue * 100;
        if (unusedIntermediateName < 0) throw new Error('unreachable');
        return firstValue + secondValue;
      }
      module.exports = { computeVisibleResult };
    `;

    const output = await minifyProductionBundle(source);
    const module = { exports: {} as { computeVisibleResult?: (left: number, right: number) => number } };
    Function('module', 'exports', output)(module, module.exports);

    expect(output.length).toBeLessThan(source.length);
    expect(output).toContain('Example dependency license');
    expect(module.exports.computeVisibleResult?.(20, 22)).toBe(42);
  });
});
