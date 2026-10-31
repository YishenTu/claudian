/** Test observation only; no completion state or semantics are added to production DOM. */
const host = await vi.importActual<typeof import('../__mocks__/obsidian')>('obsidian');

export const { controlChangeSettled, setObsidianActiveDocument } = host;
export type { ModalScope } from '../__mocks__/obsidian';
