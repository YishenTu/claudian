import 'vitest';

declare module 'vitest' {
  // Match the upstream generic parameters for declaration merging.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface Assertion<R extends void | Promise<void> = void, T = unknown> {
    toHaveNoViolations(): R;
  }

  interface AsymmetricMatchersContaining {
    toHaveNoViolations(): { asymmetricMatch(value: unknown): boolean };
  }
}
