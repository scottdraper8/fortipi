# FortiPi agent instructions

Read .agent-docs/initial-prompt.md and .agent-docs/tmp/big-build/fortipi-v0-1-0/agent-resume.md when starting or resuming after compaction.
The original prompt is immutable except user-authorized typo/lint/format corrections; retain until explicit removal authorization.
Design sources: .agent-docs/reference/fortipi-architecture.md and fortipi-client-interface-addendum.md.
Testing policy: .agent-docs/testing-policy.md; full corpus is local at .agent-docs/tmp/reference/.
Agents assigned architecture, security, integration or final QA must read the original prompt as well as their tranche plan.

Maintain a concise agent-resume.md before compaction. Link canonical plans and evidence; replace stale status rather than append a diary.
Keep generated big-build material under .agent-docs/tmp/big-build/. Do not copy logs into prompts or grow duplicate scratchpads.

Use Node 26.13.1 and pnpm 12.23.0. This session's authenticated local prefixes and guarded runner are recorded in the current resume note. Retain older binaries for historical source reproduction; do not replace shared binaries during active jobs.
Before Node/pnpm worktree commands, select the reviewed toolchain on PATH. Downloads remain ignored; pin CI/runtime tooling in the actual manifests.
Use TypeScript for the product and all repository-owned build/release/check tooling. Keep the deliberately independent non-TypeScript interoperability example isolated from the product/toolchain.

Goal: v0.1.0 is complete only after actual deployment and verification, including public-client interoperability.
Use the real Pi Durable runtime with Cloudflare PiHarness; do not replace its durable loop with a hand-built chat loop.
Separate application/client credentials, deployment credentials and executor credentials.
Respect Cloudflare plan limits with conservative Free defaults and explicit paid capability gates. Keep provider authentication plug-and-play; do not add model-provider usage budgets.
State, workspace and execution must remain independent; no blind replay of side effects, stale lease commits or stale workspace revision commits.
Release surfaces: npm packages, GitHub Releases, Cloudflare Worker/Durable Object deployment. Prefer npm OIDC after initial bootstrap.
Dependency and tooling versions must be verified current, exact-pinned and locked. Preserve required third-party notices and use Sustainable Use License 1.0.
Use tailored pre-commit, automatic unstale, SHA-pinned Actions with StepSecurity harden-runner, and security-only Dependabot.

User grants full local/GitHub access and autonomous implementation/release/deployment within this project.
Manual step is user entering actual credentials into GitHub secrets. Do not build credential collection helpers.
Never read, echo, log or persist secret values. Inspect GitHub secret names only; use keys solely within Actions jobs.
Do not print environment dumps, auth files or credential-bearing requests. Follow .agent-deny.
