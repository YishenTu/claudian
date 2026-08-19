declare module 'node-forge/lib/pki' {
  import type forge from 'node-forge';

  const pki: typeof forge.pki;
  export default pki;
}

declare module 'node-forge/lib/sha256' {
  import type forge from 'node-forge';

  const sha256: typeof forge.md.sha256;
  export default sha256;
}
