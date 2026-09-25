# Build constraints

- Keep both npm and Bun lockfiles consistent and run `npm run check:lockfile` after dependency edits. Bundle-critical packages require exact parity across both lockfiles; `runtimeDependencyParity.mjs` owns that inventory.
- Community Plugin installation does not fetch arbitrary chunks or vendor files. Preserve a self-contained distributable and avoid artifact references resembling self-update behavior. Run `check:performance` against the production build: artifact and eager-startup violations fail; timing thresholds report warnings or require review rather than failing the command.
- Electron has browser timers alongside Node modules. Preserve desktop `ws`/Markdown resolution, SDK import-meta adaptation, and renderer-safe timer guards; headless Node success cannot prove renderer compatibility.
- Locale JSON imports participate in compressed bundling. Import changes require the compression round-trip/dependency-envelope tests, not just TypeScript checks.
- Use CI's affected-path rules for additional macOS/Windows process and Pi launch checks rather than assuming Linux tests suffice.
