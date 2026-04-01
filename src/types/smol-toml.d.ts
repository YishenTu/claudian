declare module 'smol-toml' {
  export function parse(input: string): unknown;
  export function stringify(value: unknown): string;
}
