# Environment snippets

Environment snippets save reusable sets of runtime variables. Saving a snippet
adds it to the snippet list; **Insert** applies it to the environment settings.
A snippet is not a separate provider account or a per-conversation environment.

## Choose the environment section

In **Settings → Claudian → General → Environment**, **Shared environment** applies
across providers, such as `PATH`, proxies, certificate paths and temporary folders.
Under **Providers**, each provider has its own **Environment** section for its
variables, such as `ANTHROPIC_*` for Claude Code.

For example, this shared snippet configures a proxy:

```text
HTTPS_PROXY=http://127.0.0.1:7890
NO_PROXY=localhost,127.0.0.1
```

Use `KEY=VALUE`, one assignment per line. The `export` prefix is accepted, and
lines starting with `#` are comments. These fields contain assignments, not shell
scripts; shell commands are not run. Provider-specific assignments take precedence
over the shared assignment when both sections define the same key.

The ownership notice identifies keys that may belong in another section. It is
a prompt to review the configuration, not a rejection of those variables.

## Save a snippet

1. Open the appropriate environment section.
2. Choose **Save current environment as a snippet**, or **Add snippet** beside an
   existing list.
3. Enter a required **Name**, an optional **Description**, and the **Environment
   variables** to keep.
4. Choose **Save**.

The editor starts with the environment already saved for that section. If you
have just changed its textarea, leave that field to finish applying the change
before saving the current environment as a snippet.

A newly saved snippet is classified by the variables it contains. Provider-only
snippets appear with that provider. Shared snippets, and older snippets without a
scope, appear in the shared list. A mixture of shared and provider variables can
be split across those sections when inserted.

## Insert, edit and delete

Use a snippet's **Insert** action to apply it. Insertion replaces the environment
text in each affected section; it does not merge individual assignments with the
old text. Review the saved snippet before inserting if the section contains other
variables you want to keep. Sections not affected by that snippet keep their text.

- **Edit** changes the saved snippet. Choose **Update** to save it; editing the
  snippet does not apply its environment to the running configuration.
- **Delete** asks for confirmation and removes the saved snippet. It does not
  remove variables that an earlier insertion applied.
- A save that fails before committing keeps the snippet editor available for a
  retry. A message that says the snippet was saved but refresh failed means the
  saved settings advanced even though their UI refresh did not finish.

Environment settings affect the provider configuration shared by its sessions.
Inserting a snippet does not pin one conversation to that account or endpoint.
For CLI, authentication and model-discovery problems, see the
[troubleshooting guide](troubleshooting.md).

## Custom model metadata

When the environment declares custom model IDs recognized by a provider, the
snippet editor also offers aliases and context-window sizes for those IDs.
Supported window-size notation includes numbers such as `200k`.

On insertion, saved context limits update the corresponding existing custom
model overrides; omitted limits do not clear older limits. The snippet's alias
fields replace aliases for its model IDs, including clearing an alias left blank.
Other model IDs keep their metadata. If insertion reports an error, check the
environment and model overrides before retrying: an earlier step may already
have been saved. These fields describe existing model IDs;
they do not add a model that the provider cannot use.
