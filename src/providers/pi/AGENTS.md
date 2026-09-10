# Pi Provider

`src/providers/pi/` is the Pi skin over the shared pi-family engine in `src/providers/pi-rpc/`. Facades in `settings.ts`, `models.ts`, `types.ts`, `env/`, and `app/` keep the historical export surface bound to the pi profile.

## Ownership

| Component | Owns |
| --- | --- |
| `profile.ts` | Pi distribution facts: binary `pi`, package `@earendil-works/pi-coding-agent`, `.pi` data dirs, `pi:` model prefix, `PI_*` env keys |
| `capabilities.ts`, `registration.ts` | provider registration, storage adapters, and workspace wiring |
| `ui/PiChatUIConfig.ts` | chat UI binding via `definePiFamilyChatUIConfig` and `PI_PROVIDER_ICON` |
| `ui/PiSettingsTab.ts` | settings presentation; labels here are provider-owned prose, not locale keys |

## Rules

- Runtime and protocol behavior is engine-owned; change it in `src/providers/pi-rpc/`, never by forking it here.
- Engine files must not import this directory except through the injected profile and renderer objects.
- The resume-proof, history, and fingerprint rules in the engine guide apply unchanged to Pi.
