# Pi-Family RPC Engine

`src/providers/pi-rpc/` owns the protocol machinery shared by Pi and Oh My Pi (omp). Both distributions speak pi's NDJSON RPC (`--mode rpc`, protocol v1: frames `{id, type, ...}` answered by `{type:'response', command, success, data}`). Symbols keep the `Pi` prefix: the wire protocol is pi's; omp is a compatible distribution, not a separate protocol.

## Ownership

| Component | Owns |
| --- | --- |
| `runtime/PiRpcTransport`, `runtime/PiJsonl` | NDJSON framing, id correlation, failure rejection, `data` unwrapping |
| `runtime/PiLaunchSpec`, `runtime/PiSubprocess` | launch args and subprocess transport; Windows npm-shim resolution through the owning package's `bin` entry |
| `runtime/PiCliResolver` | cached per-host CLI resolution (hostname override → legacy path → PATH) |
| `runtime/PiModelDiscoveryService`, `runtime/PiCommandMetadataProbe` | independent metadata subprocesses |
| `execution/PiRpcSessionKernel`, `execution/PiExecutionSession` | RPC turn lifecycle, resume-proof identity check, fork materialization |
| `history/` | session-file discovery across trusted roots, JSONL branch replay, historical model recovery |
| `env/PiSettingsReconciler` | runtime fingerprint and session invalidation on environment change |
| `ui/PiFamilyChatUIConfig` | chat UI config factory shared by skins |

## Profile Contract

`PiFamilyProfile` carries every distribution-specific fact: `providerId`, `displayName`, `modelIdPrefix`, `defaultBinaryName`, Windows package/shim/bin key, `envKeyPatterns`, `envHashKeys`, agent-dir env keys and dot-directory name, plus the bound settings/model contracts from `definePiFamilySettings` / `definePiFamilyModels`. Engine code reads distribution facts only through the profile; a hardcoded `'pi'` literal here silently binds omp to pi. Distribution literals live only in the skin profiles (`src/providers/{pi,omp}/profile.ts`).

## Protocol Rules

- Stay on protocol v1. omp advertises `supportedProtocolVersions: [1, 2]`, but v1 is the supported client surface; do not negotiate v2 without a concrete need.
- omp rejects `get_commands`; command discovery must keep the pushed `available_commands_update` fallback working.
- A relaunched kernel must prove `get_state` identity matches the requested resume target before user input flows.
- `PiRpcTransport.request` resolves to `record.data` and rejects on `success: false`; never re-check `success` on a resolved value.
- Unknown event types are dropped by the normalizer (`default: return []`). Keep that tolerance: omp emits extra events (`advisor_cost_changed`, subagent frames).
- User-facing strings interpolate `profile.displayName`.

## Boundary

- No Obsidian DOM here; extension UI requests flow through `PiExtensionUiBridge` and injected renderers.
- Engine files must not import provider skins. Skins bind profiles and inject renderers.
- No feature/app imports; core contracts and `@/utils` only.

## Verification

Scoped suites mirror this tree under `tests/unit/providers/pi-rpc/` and `tests/integration/providers/pi-rpc/`. Engine behavior is distribution-independent, so when changing parameterization, exercise both profiles (pi fixtures exist in the moved suites; omp profile smoke lives in `.context/smoke-omp-engine.ts`).
