# Leave constraints

- Only ordinary Members may queue offline Leave. Manager departure requires online authority, and Host departure requires completed Host transfer.
- LAN lost-response recovery replays the durably frozen departure tuple before any active-member snapshot; the revoked credential may no longer reconstruct it. Host changes require public proof-chain verification and durable trust replacement before credentialed retry.
- Cloud Leave instead freezes its exact submitted wire request. Replay survives Project/index cleanup and must not require active membership reads or Native Git.
- Leave eligibility and responsibility receipt reconciliation serialize together. Release that serializer before work suspension, reacquire it to revalidate before cleanup, and resume only the still-current suspension token on rejection; Retirement permanently invalidates it.
- Keep/Delete follows authority success or a durable offline queue record and never reverses membership. Persist checkpoints before Git detach/marker removal; missing paths cannot stand in for completion evidence.
- Once local cleanup is durable, later settlement must not resolve Native Git. Retain the independently discoverable settlement journal until authority confirmation or handoff to the single Retired recovery path.
