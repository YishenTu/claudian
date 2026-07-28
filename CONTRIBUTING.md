# Contributing to Claudian

Issues and pull requests are welcome. Issues are the preferred way to contribute: if you describe the problem and your environment clearly, I will review it and make a best effort to address it.

## Before You Start

- Search existing issues and pull requests to avoid duplicates.
- For a substantial change, open an issue first so the problem and scope can be discussed before implementation.
- Keep each pull request focused on one problem. Unrelated fixes, refactors, formatting changes, or dependency updates should be submitted separately.

## Reporting an Issue

A useful issue explains the problem well enough for someone else to understand and reproduce it. Please include:

- What you were trying to do.
- What happened and what you expected instead.
- Clear reproduction steps or a minimal example.
- Your Claudian version, Obsidian version, operating system, provider, provider CLI version, and installation method.
- Relevant logs, screenshots, or recordings.

Remove API keys, tokens, private vault content, personal paths, and other sensitive information before attaching logs or screenshots.

For a feature request, start with the user problem or unmet use case. A proposed solution is helpful, but explaining the need is more important than prescribing an implementation.

## Pull Requests

Pull requests are welcome when they solve a specific, well-defined problem. A pull request description must explain:

- **Why:** the problem being solved, who it affects, and why it is worth solving.
- **What:** the behavior or code that changes.
- **Why this approach:** why the proposed design is a good fit, including meaningful alternatives and tradeoffs.
- **Validation:** tests and manual checks performed, with screenshots or recordings for user-facing changes.
- **Impact:** known limitations, compatibility or data risks, and any follow-up work.
- **Context:** a linked issue when one exists.

Please also:

- Add or update tests for behavior changes and bug fixes.
- Preserve provider and feature ownership boundaries; avoid coupling shared feature code to provider internals.
- Avoid new production dependencies unless the need and tradeoff are explicit.
- Update documentation when behavior or user-facing configuration changes.

## New Provider Policy

Pull requests that add a new provider are not accepted.

This is a maintenance and product-quality boundary:

1. I am the sole maintainer of this project and remain responsible for every integration after it is merged. If I do not use a provider myself, I cannot test and maintain its integration responsibly over time.
2. Integrated providers must offer a broadly consistent feature set and user experience. Past attempts have shown that partial integrations are difficult to bring to parity and keep reliable.
3. Some provider CLIs do not currently expose the capabilities required for a complete integration. For example, Antigravity CLI does not expose ACP or a comparable integration protocol, and Cursor CLI does not allow the system prompt to be customized fully.
4. Integrating a separate CLI from every model vendor is not sustainable. OpenCode and Pi already support multiple model vendors through API configuration. Codex and Claude Code can also use alternative model endpoints through configuration. Inside an Obsidian vault, switching the underlying harness usually provides limited additional value compared with the ongoing integration and maintenance cost.

You may open an issue to describe an unmet provider-related use case, but please do not submit a new-provider implementation. An issue does not imply that the provider will be added.

Contributions that improve an existing provider are welcome when they follow the focused pull request requirements above and preserve the expected cross-provider experience.

## Development

Claudian requires the Node.js version declared in `.node-version`.

```bash
npm install
npm run dev
```

For a bug fix or new behavior, add or update a failing test first, then make the narrowest implementation change that passes it. Use focused checks while iterating. Before submitting a pull request, run the full verification suite:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
```

The project architecture and area-specific development rules are documented in `AGENTS.md` and the scoped `AGENTS.md` files under `src/`.
