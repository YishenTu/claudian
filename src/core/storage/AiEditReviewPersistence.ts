/** Vault-local pending editor reviews; decoded by the owning feature. */
export interface AiEditReviewPersistence {
  load(): Promise<unknown>;
  save(value: unknown): Promise<void>;
  flush(): Promise<void>;
}
