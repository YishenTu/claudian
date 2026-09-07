const WINDOWS_RESERVED_NAME_PATTERN = /^(?:con|prn|aux|nul|com(?:[1-9¹²³])|lpt(?:[1-9¹²³]))(?:\..*)?$/iu;

export function isWindowsReservedName(segment: string): boolean {
  return WINDOWS_RESERVED_NAME_PATTERN.test(segment);
}
