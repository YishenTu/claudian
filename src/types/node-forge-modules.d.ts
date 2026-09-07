declare module 'node-forge/lib/sha256' {
  import type forge from 'node-forge';

  const sha256: typeof forge.md.sha256;
  export default sha256;
}

declare module 'node-forge/lib/asn1' {
  import type forge from 'node-forge';

  const asn1: typeof forge.asn1;
  export default asn1;
}

declare module 'node-forge/lib/pem' {
  import type forge from 'node-forge';

  const pem: typeof forge.pem;
  export default pem;
}

declare module 'node-forge/lib/x509' {
  import type forge from 'node-forge';

  const pki: typeof forge.pki;
  export default pki;
}
