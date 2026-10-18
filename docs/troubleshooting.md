# Troubleshooting

The following sections use Claude Code as an example.

## Provider CLI not found

If Claudian cannot auto-detect a provider CLI, verify that the CLI is installed and available through PATH. Typical errors include `spawn claude ENOENT` and `Claude Code CLI not found`.

On macOS and Linux, Obsidian launched from the Dock or a desktop entry does not inherit your terminal's PATH, so Claudian reads PATH once from your login shell (`$SHELL -i -l`). CLIs and Node.js installed through version managers such as nvm, fnm, Volta, asdf, or mise are found the same way your terminal finds them. Reload Claudian after changing your shell profile. If your profile is slow or interactive, skip that part when `CLAUDIAN_RESOLVING_ENVIRONMENT` is set; Claudian falls back to common install locations if the shell does not answer within 10 seconds.

On Windows, Obsidian uses the PATH from your user and system environment variables. Restart Obsidian after changing them.

Leave the CLI path setting empty first so Claudian can auto-detect the CLI. If auto-detection fails, find the executable path, open Settings → Claudian → Providers → Claude Code, expand the Claude Code installation card, and set Claude Code CLI path.

For Codex on macOS, auto-detection also checks ChatGPT.app in `/Applications` and `~/Applications`, including its nested `codex-cli/CodexCLI.app` runtime. A configured CLI path or shared PATH entry takes precedence.

| Platform | Command | Example Path |
|----------|---------|--------------|
| macOS/Linux | `which claude` | `/Users/you/.volta/bin/claude` |
| Windows (native) | `where.exe claude` | `C:\Users\you\AppData\Local\Claude\claude.exe` |
| Windows (npm) | `npm root -g` | `{root}\@anthropic-ai\claude-code\cli-wrapper.cjs` |

> **Note**: On Windows, avoid `.cmd` and `.ps1` wrappers. Use `claude.exe` for native installs, or `cli-wrapper.cjs` for package-manager installs. `cli.js` is only a legacy fallback for older Claude Code npm packages.

**Alternative**: Add your Node.js bin directory to PATH in Settings → Claudian → General → Environment → Shared environment.

## A newly released model is missing

Claudian discovers models from each configured provider rather than keeping its own hard-coded model list. A model can therefore be available through a provider API or announced publicly before it appears in the catalog returned for your provider installation, configuration, and account.

1. Update the provider CLI or application, when applicable, and confirm the model appears there.
2. In Settings → Claudian → Providers, open the provider and confirm its CLI path, environment, and other connection settings use the same installation and account.
3. Under **Models**, open **Browse models**, then click **Refresh** if models are already listed, or **Discover** otherwise, to request the current catalog.
4. Enable the new model and start a new chat if you want to use it. Existing chats keep their selected model.

If the model is still absent, the active provider runtime or account has not reported it to Claudian. Public or API availability alone does not guarantee catalog availability for every provider integration or account. Avoid editing Claudian's installed bundle to add the model manually; those changes are unsupported and will be overwritten by updates.

For OpenCode, discovery failures show the request error, including a server error reference when supplied. A successful catalog with no enabled models instead shows configuration guidance. Check the vault's `.opencode/opencode.json`, compare `opencode models --standalone` from that vault using the same CLI and environment, and use `opencode debug paths` to locate OpenCode logs. Configured plugins may be incompatible with the installed OpenCode version; an empty catalog alone does not establish a plugin failure.

## Node.js not found for an npm-installed CLI

npm-installed provider CLIs need Node.js. Claudian prefers the Node.js next to the CLI, then the first one on PATH. If the CLI still reports that Node.js is missing (for example `env: node: No such file or directory`), check where your terminal finds it:

```bash
dirname "$(which node)"
```

Either:

1. Install the native binary (recommended).
2. Add that directory in Settings → Claudian → General → Environment → Shared environment: `PATH=/path/to/node/bin`.

## Authentication fails while the CLI subscription works

Claude can report `authentication_failed` inside Obsidian while the selected CLI works with a subscription in a terminal. An `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` inherited from the system environment takes precedence over subscription sign-in, so pointing Claudian at another CLI path does not help. The chat error includes the same recovery steps.

In Settings → Claudian → Providers → Claude Code → Environment → Custom variables, add an empty assignment for the conflicting credential so Claude falls back to the subscription:

```env
ANTHROPIC_API_KEY=
```

Use `ANTHROPIC_AUTH_TOKEN=` instead when that is the inherited credential. Override only credentials you intend to disable, and keep these assignments out of the shared environment so other providers are unaffected.

When asking for help, share the variable names involved rather than their secret values.

## More help

For provider-specific installation and configuration guidance, refer to the provider documentation linked in the [Requirements](../README.md#requirements) section. If you have a feature request or run into a bug, please [submit a GitHub issue](https://github.com/YishenTu/claudian/issues).
