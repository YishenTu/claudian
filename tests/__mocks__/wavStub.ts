// Returned in place of any `*.wav` import during Jest runs.
// In production builds esbuild's `dataurl` loader emits a real base64 URL.
export default 'data:audio/wav;base64,';
