# Test constraints

- Use package test commands: `npm run test:unit -- --runTestsByPath <path>` runs either a unit or integration Jest file with the required Node local-storage option. `npm run test` also runs script/architecture/config checks; targeted Jest does not.
- Follow nearby tests and shared helpers. Use unit tests for isolated logic and integration tests for interactions between owned modules or real dependencies. Keep those interacting modules real; use narrow public ports for environment, Obsidian, provider, or other dependencies outside the behavior under test. Do not add production facades solely for testing.
- Assert observable contracts using independent fixtures or worked examples. Avoid mirroring algorithms, incidental call counts, or private storage layouts. Shared provider changes need neutral-contract coverage and distinct native adapter cases.
- DOM interaction and accessibility regressions need real-DOM tests with Testing Library role/name queries and targeted `jest-axe` checks. Isolated controller logic may use unit tests without a DOM; `MockElement` class/tag assertions do not establish accessibility or keyboard behavior.
