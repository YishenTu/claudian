# Skills management

Open **Settings → Claudian → Skills** to manage skills and Claude Code commands stored in the current vault.

## Management and native discovery

The Skills panel manages vault resources. User-level skills are discovered by each provider's native harness and are managed with your preferred tools, outside this panel. A skill missing from this panel does not by itself mean the provider cannot use it. See the [maintainer's scope clarification](https://github.com/YishenTu/claudian/issues/2040#issuecomment-6595658518).

These paths are relative to the vault root:

| Path | Managed content |
| --- | --- |
| `.claude/skills/<package>/SKILL.md` | Claude Code vault skill packages before unification |
| `.claude/commands/**/*.md` | Claude Code vault commands, including nested commands |
| `.agents/skills/<package>/SKILL.md` | Shared vault skill packages |

When the vault has not recorded a successful Sync and `.claude/skills` is an ordinary folder or missing, the panel has **Claude Code** and **Other providers** tabs. The first manages Claude skills and commands; the second manages shared skills. An existing healthy link to `.agents/skills` already uses the shared list.

## What Sync changes

**Sync** unifies Claude's vault resources with `.agents/skills`; it is a filesystem migration, not a change to provider discovery settings.

1. Click **Sync** to open **Sync Skills**. When there are items to process, the preview explains the conversion and shows items that need attention.
2. Resolve the displayed problems. Where offered, **Fix** lets you correct a name or description, **Keep as command** leaves a command in place, and **Discard (move to trash)** discards the applicable non-command item. **Replace shared skill** explicitly replaces a conflicting shared package; it does not merge the packages.
3. Choose **Continue** to review the final link confirmation, then **Sync and link** to apply it. If there are no items to process, the dialog goes directly to confirmation. Nothing on disk changes before this final confirmation.

Depending on the current folders and your choices, Sync can:

- Move Claude skill packages into `.agents/skills`.
- Convert Claude commands into shared skills and move the original command files to trash. Commands kept as commands stay in `.claude/commands`.
- Move leftover contents of `.claude/skills` that are not recognized skill packages to trash, and remove links inside that folder without following their targets.
- Replace `.claude/skills` with a folder link to `.agents/skills`, or create the link if the folder was missing.

For moved or converted skills, the resulting `SKILL.md` contains the name, description and instructions. Other frontmatter keys are dropped, so provider-specific behavior can change. Review Claude-only syntax such as `$ARGUMENTS` before using a shared skill with another provider; Sync does not translate that syntax.

The operation can finish some items before another item fails and stop before linking. Read the displayed results, resolve the reported problems and run Sync again; do not assume an all-or-nothing migration or complete rollback.

## Synced, Resync and other devices

After unification, the panel uses one shared list, with a command section when commands remain. A healthy `.claude/skills` link shows **Synced**; a missing, broken or different link shows **Resync** once the vault has recorded Sync. A foreign or broken link also offers **Resync** before that flag is recorded.

The vault records that Sync ran, but the folder link is checked from disk on each device. Your vault-sync tool may not reproduce that link on another device. Use **Resync** there to review and recreate it. Repairing a foreign or broken link replaces the link, without changing the folder it previously targeted.

## Provider compatibility

Shared storage does not guarantee identical skill syntax, discovery or refresh behavior across providers. The native harness remains responsible for those behaviors.
