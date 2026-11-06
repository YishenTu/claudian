# Antigravity CLI

Claudian connects to [Antigravity CLI](https://antigravity.google/product/antigravity-cli)
through its ACP server. Install and sign in to the CLI before enabling the provider.
Authentication and model access are managed by Antigravity; Claudian does not store
Google credentials or determine which subscriptions are eligible.

## Connect the provider

1. Install Antigravity CLI and complete its native sign-in:

   ```bash
   agy acp --login
   ```

2. Open **Settings → Claudian → Providers → Antigravity** and enable the provider.
   Leave **CLI path** empty for discovery, or set the path to the `agy` executable.
   Claudian runs the host installation; WSL installations are not offered.
3. Under **Models**, choose **Browse models**, then **Discover** or **Refresh**, and
   enable the models you want. Available models and thinking levels come from your
   native session. A model with a fixed thinking level has no effort picker.
4. Start a new conversation and select an Antigravity model. If sign-in expires,
   repeat `agy acp --login` using the same installation and home directory.

Provider-specific environment variables belong in the Antigravity provider's
**Environment** section. The native store is under
`~/.gemini/antigravity-cli` (`USERPROFILE` on Windows). Changing the home directory
selects a different store; keep the original environment when reopening old sessions.

## Instructions belong to the new conversation

Antigravity freezes its agent instructions and tool list when a native session is
created. Editing Claudian's custom instructions or project instructions affects
**new conversations**, rather than the next turn of an existing Antigravity session.
Moving an existing Antigravity conversation to another project also keeps the
instructions from its original project. Start a new conversation in the destination
project when you need its current instructions.

Claudian writes its managed agent definitions into `.agents/agents/claudian-*/agent.md`
inside the vault. Leave those files managed by Claudian. A foreign or malformed file
under the same name prevents creation, and editing or deleting the generated file
does not change instructions already stored in an existing native session. A
same-name agent at a parent Git root can override the vault's definition.

## What differs from other providers

| Area | Antigravity behavior in Claudian |
|---|---|
| Side chats, forks and rewind | Unavailable because the native ACP server does not offer the required session operations. |
| Permissions | **Ask**, **Accept edits** and **YOLO** are available. Native plan mode is not selected. |
| Inline Edit | Can use native commands as well as read and search tools. Antigravity has no read-only sandbox; the Inline Edit instructions keep those commands read-only. |
| Subagents | Not enabled under the managed custom agent. |
| MCP | Uses the CLI's native MCP configuration. Claudian's cross-session tools are attached separately. |
| Slash commands | Native commands are discovered, while `boost`, `browser`, `plan`, `schedule` and `teamwork` are hidden because their required behavior is unavailable over this integration. |

## Live output and reopened history

Some tools, including reads, searches, image generation and MCP calls, send no
result body over ACP. Their cards can therefore have no live output even after they
complete. Reopening the conversation reads the results from the native transcript.
Work that completes after the turn has ended is also visible only after reopening.
Automatic compaction boundaries appear after reopening; a completed explicit
`/compact` can show its boundary live.

The context gauge has native reporting limitations. Gemini uses an assumed
1,048,576-token window; the gauge is hidden by default for other model families. Usage can sum several model calls within a turn and overstate current context.
Reopened **Worked for** timing uses transcript step start times, so a text-only reply
can show `00:00`.

Antigravity prunes older native conversations after its retention limit. Claudian's
session list does not preserve the native session or transcript after that pruning.
See the maintained [native limitations and workarounds](https://github.com/YishenTu/claudian/issues/2044)
for the verified CLI versions and the status of these upstream constraints.
