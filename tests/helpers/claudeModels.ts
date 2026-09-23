/** SDK catalog fixture for tests whose subject assumes model discovery has completed. */
export function claudeCatalogFixture(ids = ['haiku', 'sonnet', 'opus', 'fable']) {
  return {
    visibleModels: [...ids],
    discoveredModels: ids.map(value => ({ value, label: value, description: 'SDK model' })),
  };
}
