import obsidianStylelint from 'stylelint-config-obsidianmd';

export default {
  extends: ['stylelint-config-obsidianmd'],
  rules: {
    'plugin/no-unsupported-browser-features': [true, {
      ...obsidianStylelint.rules['plugin/no-unsupported-browser-features'][1],
      // Keep the Obsidian 1.11.4 compatibility baseline; the preset targets 1.13.4.
      browsers: ['electron >= 39'],
    }],
    // Owned classes include BEM modifiers and serialized tool states; host classes are external.
    'selector-class-pattern': '^(?:claudian-[a-z0-9]+(?:[-_]{1,2}[a-z0-9]+)*|cm-[a-zA-Z0-9-]+|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)$',
    // Component/state groups intentionally share host selectors without a global specificity order.
    'no-descending-specificity': null,
    // Longhands avoid resetting unspecified host styles through shorthand expansion.
    'declaration-block-no-redundant-longhand-properties': null,
    // Preserve existing host fallbacks and visually hidden accessibility helpers.
    'property-no-vendor-prefix': [true, { ignoreProperties: ['-webkit-box-decoration-break', '-webkit-backdrop-filter', '-webkit-user-select'] }],
    'property-no-deprecated': [true, { ignoreProperties: ['clip'] }],
    // Preserve existing wrapping independently of inherited overflow-wrap values.
    'declaration-property-value-keyword-no-deprecated': [true, { ignoreKeywords: ['break-word'] }],
  },
};
