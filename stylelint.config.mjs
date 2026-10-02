export default {
  rules: {
    'declaration-no-important': [true],
    'selector-pseudo-class-disallowed-list': ['has'],
    'declaration-property-value-disallowed-list': { display: ['contents'] },
    // Obsidian's compatibility check flags text-indent, including plain lengths and resets.
    'property-disallowed-list': ['text-indent'],
  },
};
