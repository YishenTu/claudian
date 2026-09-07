import { MutationIntentStore } from '@/features/collab/shared/MutationIntentStore';

type MutationKind = 'accept' | 'comment' | 'description';

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/;

describe('MutationIntentStore', () => {
  it('reuses an ID only for byte-identical JSON identities', () => {
    const store = new MutationIntentStore<MutationKind>();

    const first = store.intent('description', { body: 'same', revision: 1 });
    const retry = store.intent('description', { body: 'same', revision: 1 });

    expect(first).toMatch(OPAQUE_ID_PATTERN);
    expect(retry).toBe(first);
  });

  it('rotates the ID when a material input changes', () => {
    const store = new MutationIntentStore<MutationKind>();

    const first = store.intent('description', { body: 'first', revision: 1 });
    const changed = store.intent('description', { body: 'second', revision: 1 });

    expect(changed).toMatch(OPAQUE_ID_PATTERN);
    expect(changed).not.toBe(first);
  });

  it('tracks keys independently', () => {
    const store = new MutationIntentStore<MutationKind>();
    const input = { body: 'same' };

    const description = store.intent('description', input);
    const comment = store.intent('comment', input);

    expect(comment).not.toBe(description);
    expect(store.intent('description', input)).toBe(description);
    expect(store.intent('comment', input)).toBe(comment);
  });

  it('clears only the currently matching ID', () => {
    const store = new MutationIntentStore<MutationKind>();
    const input = { body: 'same' };
    const current = store.intent('comment', input);

    store.clear('comment', 'different');
    expect(store.intent('comment', input)).toBe(current);

    store.clear('comment', current);
    expect(store.intent('comment', input)).not.toBe(current);
  });

  it('discards one key regardless of its current ID', () => {
    const store = new MutationIntentStore<MutationKind>();
    const input = { body: 'same' };
    const description = store.intent('description', input);
    const comment = store.intent('comment', input);

    store.discard('description');

    expect(store.intent('description', input)).not.toBe(description);
    expect(store.intent('comment', input)).toBe(comment);
  });

  it('clears all keys', () => {
    const store = new MutationIntentStore<MutationKind>();
    const input = { body: 'same' };
    const description = store.intent('description', input);
    const accept = store.intent('accept', input);

    store.clearAll();

    expect(store.intent('description', input)).not.toBe(description);
    expect(store.intent('accept', input)).not.toBe(accept);
  });
});
