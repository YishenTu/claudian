# Windows and WSL execution

Start with a provider CLI already installed and configured in the environment you intend to use.
On Windows, Claudian can launch selected providers natively or inside a WSL distro.
The installation method determines where the CLI runs and which path namespace it uses.

## Choose the installation method

Open **Settings → Claudian → Providers** and select your provider's installation settings.
On Windows, Claude Code, Codex, Grok, OpenCode, Pi and DeepSeek Harness expose **Installation method**:

- **Native Windows** uses the Windows installation.
- **WSL** uses the Linux installation inside the selected distro.

**WSL distro override** appears and becomes editable when WSL is selected.
Antigravity uses native execution and has no installation-method selector.
These controls are Windows-specific; their presence does not establish a provider's support for every Windows or WSL version.

Choose the environment where your intended CLI is installed, then initially leave its CLI path empty for discovery.
If you specify a path, use a Windows executable path for native execution and a Linux command or absolute Linux path for WSL.
For example, `codex` and `/home/you/bin/codex` are illustrative WSL CLI field values, not installation commands.
A Windows executable path is rejected in the WSL CLI field.

Installation method, distro override and CLI path preferences are kept per computer.
Changing launch settings can replace runtime resources or retire session bindings; finish current work before switching environments.

## Select the distro

Claudian resolves the WSL distro in this order:

1. A nonempty **WSL distro override**.
2. The distro named in the vault's WSL UNC path.
3. The default WSL distro.

For a vault opened through a WSL UNC path, use that same distro.
An override naming another distro is rejected when preparing the launch.
For a Windows drive vault, an override lets you choose a distro without changing the operating system's default.
If no distro can be determined, check the override and whether a default distro is available.

## Distinguish vault paths from CLI paths

Obsidian accesses the vault through a Windows host path; a WSL process needs its Linux counterpart.
The existing path mapper translates examples like these for a selected Ubuntu distro:

| Vault path on the Windows host | Path inside WSL |
| --- | --- |
| `C:\Notes\Vault` | `/mnt/c/Notes/Vault` |
| `\\wsl$\Ubuntu\home\you\Vault` | `/home/you/Vault` |

The WSL UNC spelling `\\wsl.localhost\Ubuntu\home\you\Vault` is recognized too.
An ordinary network share or a UNC path belonging to another distro is not automatically representable.
These mappings describe the vault path translation; they do not configure drive mounts or guarantee that every provider-specific store path is accessible.
Keep an explicitly configured WSL CLI path in Linux form rather than copying the host vault's Windows path syntax.

## Check the Linux environment

WSL execution uses its Linux home and shell environment, including Linux PATH defaults.
Claudian selects provider-owned inherited variables and explicitly configured variables for forwarding; it does not simply copy the entire Windows environment.
Explicit Linux-form `HOME` or `PATH` values can override the distro defaults.
Review shared and provider-specific environment settings for values intended for this Linux installation.
Provider-specific store and launch rules still apply; choosing WSL does not by itself select the same account or history as a Windows installation.

## When execution fails

Use the reported error to narrow the check; providers may report different failures:

- A Linux-command/path validation error: confirm **Installation method** and the CLI field refer to the same environment.
- An unrepresentable workspace or different-distro error: compare the vault's host path with the selected distro and the mappings above.
- An unresolved Linux home error: check the selected distro and its shell environment, including any explicit home override.
- A Codex target-mismatch error: check that the chosen CLI actually starts the requested Windows or Linux runtime.

For general discovery checks, return to [Provider CLI not found](troubleshooting.md#provider-cli-not-found).
For provider-specific setup requirements, use the provider documentation linked from [Requirements](../README.md#requirements).
