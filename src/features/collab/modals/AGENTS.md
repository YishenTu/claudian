# Modal constraints

- Surface close/disable/unload cancels presentation waits, not possible durable Cloud effects. Recovery observes the same application-owned intent; stale completions cannot reopen UI. Application Project publications may precede a command response; updating presentation must not consume that response or skip dependent refresh.
- Project Management opens without online preflight so local recovery remains available. Host controls depend on installation status, never Host membership alone; a foreign synchronized Host is status-only. Legacy claim requires explicit confirmation.
- LAN management retry retains its transient exact intent until cancellation/close; refreshed snapshots cannot change the target of an operation awaiting Retry.
- Cloud management/invitation intent survives close/restart and requires explicit completion.
- Invitation dialogs use application-owned operations; they do not choose LAN/Cloud retry policy or handle management completion receipts.
- Manager authority and Host capability are independent. Manager acknowledgement is synchronization, not an Accept Manager action. Accept Host requires the selected target installation and is progress, not completion.
- Ordinary non-Host Members can initiate Leave offline in LAN and Cloud. Explain that local exit happens immediately and authority settlement follows reconnection; online loading must not hide this local action. Leave defaults to Keep; Delete is a separate destructive choice with immediate local deletion. Removal must not imply remote deletion, and Retire must explain loss of collaboration/Git-only history.
- Create is empty-only. Do not add Vault-file selection/import or separate Cloud login/token/certificate UI; existing entry surfaces accept the complete Server URL.
- Imported claims recover existing identity, not Join. Resumable setup must reuse its application operation rather than rotate intent on Retry.
