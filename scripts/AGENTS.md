# Build constraints

- Keep both npm and Bun lockfiles consistent and run `npm run check:lockfile` after dependency edits. Bundle-critical packages require exact parity across both lockfiles; `runtimeDependencyParity.mjs` owns that inventory.
- Use package test commands: the Jest wrapper supplies the Node local-storage option. Targeted Jest omits the architecture/config checks included in `npm run test`.
- Community Plugin installation does not fetch arbitrary chunks or vendor files. Preserve a self-contained distributable and avoid artifact references resembling self-update behavior. Production verification includes `check:performance`; its artifact/startup budgets are authoritative, not optional timing advice.
- Electron has browser timers alongside Node modules. Preserve desktop `ws`/Markdown resolution, SDK import-meta adaptation, and renderer-safe timer guards; headless Node success cannot prove renderer compatibility.
- Locale JSON and `sql.js/dist/sql-wasm.wasm` imports participate in compressed bundling. Import changes require the compression round-trip/dependency-envelope tests, not just TypeScript checks.
- Pierre upgrades/replacements require `src/features/collab/detail/AGENTS.md`. Use CI's affected-path rules for additional macOS/Windows Collab and Pi launch checks rather than assuming Linux tests suffice.
