import type { AuxQueryConfig, AuxQueryRunner } from '../../../core/auxiliary/AuxQueryRunner';
import type ClaudianPlugin from '../../../main';

/**
 * Phase 1 stub. Real implementation lands in Phase 2 once the cursor-agent
 * subprocess transport and event schema are validated. Keeping a typed
 * placeholder here lets the provider register and aux services compile
 * without changing the registration shape later.
 */
export class CursorAuxQueryRunner implements AuxQueryRunner {
  constructor(private readonly _plugin: ClaudianPlugin) {}

  async query(_config: AuxQueryConfig, _prompt: string): Promise<string> {
    throw new Error('Cursor provider runtime is not yet implemented.');
  }

  reset(): void {
    // No-op until Phase 2 wires real subprocess lifecycle.
  }
}
