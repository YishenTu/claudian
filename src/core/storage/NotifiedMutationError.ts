/** A mutation failure that has already been presented to the user. */
export class NotifiedMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotifiedMutationError';
  }
}

export function isNotifiedMutationError(error: unknown): error is NotifiedMutationError {
  return error instanceof NotifiedMutationError;
}
