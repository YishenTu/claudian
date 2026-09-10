# Oh My Pi Provider

`src/providers/omp/` adapts oh-my-pi through the shared pi-family engine (`omp --mode rpc`). This is a thin skin: profile, settings/models facades, chat UI config, settings tab, and registration. All runtime behavior lives in `src/providers/pi-rpc/`.

## Profile Facts (verified against omp 18.1.15)

- Binary `omp`; npm package `@oh-my-pi/pi-coding-agent` with bin key `omp` for Windows shim resolution.
- Data roots: `~/.omp/agent/sessions` (user) and `.omp/agent/sessions` (vault-local). `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` overrides are still honored by omp.
- Model ids encode as `omp:<provider>/<modelId>`; the settings/config key is `omp`.
- Env key patterns: `/^PI_/i` and `/^OMP_/i`. omp honors legacy `PI_*` keys plus `OMP_*` keys; `OMP_PROFILE` relocates data dirs and is part of the session fingerprint.
- omp rejects `get_commands` (the pushed `available_commands_update` catalog feeds the command loader) and answers `get_available_models` for discovery.
- Thinking levels include `xhigh` and `max` (already inside the shared level set).

## Rules

- Session JSONL format is pi-compatible; treat omp session files as read-only outside fork materialization.
- Do not add pi-specific behavior here. If a behavior differs between pi and omp, extend `PiFamilyProfile` in the engine instead of branching in the skin.
- Skin files may import engine modules directly (`../pi-rpc/...`); never import the pi skin.
