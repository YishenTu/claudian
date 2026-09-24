export class ProviderModelUnavailableError extends Error {
  constructor(providerName: string) {
    super(`The selected ${providerName} model is unavailable. Open Claudian settings → ${providerName}, click Discover, and choose an enabled model.`);
    this.name = 'ProviderModelUnavailableError';
  }
}
