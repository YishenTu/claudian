export function isTlsValidationError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code ?? '';
  return code.includes('CERT')
    || code.includes('TLS')
    || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
    || code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
    || code === 'ERR_TLS_CERT_ALTNAME_INVALID';
}
