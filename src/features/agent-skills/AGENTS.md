# Agent skill constraints

- Vault skill management is filesystem-only and never changes how providers discover skills. The `.claude/skills` → `.agents/skills` link state is per device: read it from disk, never persist it. Settings only record the vault-wide fact that Sync ran (`skillsSynced`). Folder links are removed with unlink, never trashed or followed.
