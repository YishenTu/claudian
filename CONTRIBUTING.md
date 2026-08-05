# Contributing to Oh My Claudian

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
- Your Oh My Claudian version, Obsidian version, operating system, provider, provider CLI version, and installation method.
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

Provider additions must include focused tests and a clear explanation of the runtime, permission, history, and settings behavior they introduce.

Provider contributions should preserve provider isolation, use provider-native behavior where possible, and document any capabilities that are intentionally unavailable. Changes that improve an existing provider should follow the same focused pull request requirements.

## Development

Oh My Claudian requires the Node.js version declared in `.node-version`.

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

For user-facing settings changes, manually check every provider tab (Claude, Codex, Grok, OpenCode, OMP, and Pi) when the provider is available. Confirm that readiness status reflects the provider's own CLI and model configuration, and that refreshing the panel does not mutate provider-native files.

During development, `npm run dev` also watches styles and `manifest.json`. Set `OBSIDIAN_VAULT` in `.env.local` to copy rebuilt resources into a test vault automatically.

The project architecture and area-specific development rules are documented in `AGENTS.md` and the scoped `AGENTS.md` files under `src/`.
