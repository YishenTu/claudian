# Contributing to Claudian

Issues and pull requests are welcome. Issues are the preferred way to contribute: if you describe the problem and your environment clearly, I will review it and make a best effort to address it.

## Before You Start

- Search existing issues and pull requests to avoid duplicates.
- For a substantial change or a change to intended behavior (such as new settings, commands, or UI), open an issue and get agreement before implementing it, even if you see it as a fix.
- An open issue is a proposal, not an accepted task. Before implementing someone else's issue, check that the maintainer has confirmed the problem and the direction there. If they haven't, comment on the issue first. Pull requests for issues that haven't been confirmed, or that go against the maintainer's response, may be closed without review.
- Keep each pull request focused on one problem. Unrelated fixes, refactors, formatting changes, or dependency updates should be submitted separately.
- When a change is too large for one pull request, prefer a stacked series: each pull request builds on the previous one and names the pull request it depends on. Avoid many independent pull requests that touch the same files and must be rebased one after another.

## Reporting an Issue

A useful issue explains the problem well enough for someone else to understand and reproduce it. Please include:

- What you were trying to do.
- What happened and what you expected instead.
- Clear reproduction steps or a minimal example.
- Your Claudian version, Obsidian version, operating system, provider, provider CLI version, and installation method.
- Relevant logs, screenshots, or recordings.

For a feature request or a proposal to change existing behavior, start with the user problem or use case and your rationale. A proposed solution is helpful, but explaining the need is more important than prescribing an implementation, and current behavior may be intentional.

Remove API keys, tokens, private vault content, personal paths, and other sensitive information before attaching logs or screenshots.

## Development

AI coding agents are welcome, and current state-of-the-art models are recommended.

- Use the Node.js version declared in `.node-version`.
- Follow [AGENTS.md](AGENTS.md) and the scoped `AGENTS.md`. They are the authoritative development, testing and verification rules.
- For a bug fix or behavior change, write the failing test first, confirm it fails for the intended reason, then make the narrowest change that passes it.
- Before submitting a pull request, run the verification your change requires.
- Have the change reviewed by a different model from the one that wrote it, covering correctness, architecture and ownership boundaries, and simplification. Address the findings, and mention the review under Validation.

## Pull Requests

Pull requests are welcome when they solve a specific, well-defined problem. A pull request description must explain:

- **Why:** the problem being solved, who it affects, and why it is worth solving.
- **What:** the behavior or code that changes.
- **Why this approach:** why the proposed design is a good fit, including meaningful alternatives and tradeoffs.
- **Validation:** tests and manual checks you actually ran, and what you did not verify, with screenshots or recordings for user-facing changes.
- **Impact:** known limitations, compatibility or data risks, and any follow-up work.
- **Context:** a linked issue when one exists.

Please also:

- Title and describe a pull request by what it actually does. New capabilities and changes to intended behavior are features, not fixes; reserve `fix:` for restoring behavior that is broken.
- Preserve provider and feature ownership boundaries; avoid coupling shared feature code to provider internals.
- Avoid new production dependencies unless the need and tradeoff are explicit.
- Keep one source of truth for each piece of state, policy, or text; reuse existing helpers instead of copying them.

### Bug Fixes

A bug fix must show that the problem occurs in real use, through a reproduction, a real record, or a real configuration. A test that fails only under conditions real use does not produce is not enough. For speculative edge cases and defensive hardening, open an issue first that explains the failure mode, its likelihood, and the cost of the fix.

### Tests

Add or update tests for behavior changes and bug fixes. Tests are judged by quality, not size. Follow [tests/AGENTS.md](tests/AGENTS.md): exercise the real behavior, assert observable results rather than incidental details, and catch a regression that existing checks would miss.

### Documentation

- Do not modify `README.md`. The maintainer owns it; pull requests that change it will be asked to drop those changes.
- Do not add documentation that explains features; the maintainer adds it when needed. Do correct existing documentation that your change makes inaccurate.

## New Provider Policy

Pull requests that add a new provider are not accepted.

This is a maintenance and product-quality boundary:

1. I am the sole maintainer of this project and remain responsible for every integration after it is merged. If I do not use a provider myself, I cannot test and maintain its integration responsibly over time.
2. Integrated providers must offer a broadly consistent feature set and user experience. Past attempts have shown that partial integrations are difficult to bring to parity and keep reliable.
3. Some provider CLIs do not currently expose the capabilities required for a complete integration. For example, Cursor CLI does not allow the system prompt to be customized fully.
4. Integrating a separate CLI from every model vendor is not sustainable. OpenCode and Pi already support multiple model vendors through API configuration. Codex and Claude Code can also use alternative model endpoints through configuration. Inside an Obsidian vault, switching the underlying harness usually provides limited additional value compared with the ongoing integration and maintenance cost.

You may open an issue to describe an unmet provider-related use case, but please do not submit a new-provider implementation. An issue does not imply that the provider will be added.

Contributions that improve an existing provider are welcome when they follow the focused pull request requirements above and preserve the expected cross-provider experience.
