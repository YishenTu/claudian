# Physical Host handoff constraints

- Client-service lifetime and per-Host outgoing runtime lifetime are independent. Physical LAN handoff must not become semantic LAN/Cloud transfer or reuse private bootstrap.
- The target stays provisional until the old CA's activation certificate matches its exact staged manifest. Relinquishment is irreversible; later failure never reopens the old active route.
- Persist outgoing recovery before acknowledging acceptance. Response loss/disconnect must still schedule recovery; Accept/Cancel serialize around that checkpoint.
- Cancellation cannot erase the receiver credential before exact recovery is durable and target cancellation is checkpointed. Only proven pre-cutover cancellation may reopen source admission.
- Preserve replayable hash-only terminal receipts through cleanup and their bounded lifetime; remove staging identity only after cleanup. CA private keys and raw receiver/Member credentials never enter transfer packages or receipts.
