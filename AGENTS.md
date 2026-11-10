# FortiPi agent instructions

Read .agent-docs/initial-prompt.md and agent-resume.md when starting or resuming after compaction.
The original prompt is immutable except user-authorized typo/lint/format corrections; retain until explicit removal authorization.
Design sources: .agent-docs/reference/fortipi-architecture.md and fortipi-client-interface-addendum.md.
Testing policy: .agent-docs/testing-policy.md; full corpus is local at .agent-docs/tmp/reference/.
Agents assigned architecture, security, integration or final QA must read the original prompt as well as their tranche plan.

Maintain a concise agent-resume.md before compaction. Link canonical plans and evidence; replace stale status rather than append a diary.
Keep generated big-build material under .agent-docs/tmp/big-build/. Do not copy logs into prompts or grow duplicate scratchpads.

Goal: v0.1.0 is complete only after actual deployment and verification, including public-client interoperability.
Use the real Pi Durable runtime with Cloudflare PiHarness; do not replace its durable loop with a hand-built chat loop.
Separate application/client credentials, deployment credentials and executor credentials.
State, workspace and execution must remain independent; no blind replay of side effects, stale lease commits or stale workspace revision commits.
Release surfaces: npm packages, GitHub Releases, Cloudflare Worker/Durable Object deployment. Prefer npm OIDC after initial bootstrap.
Dependency and tooling versions must be verified current, exact-pinned and locked. Preserve required third-party notices and use Sustainable Use License 1.0.
Use tailored pre-commit, automatic unstale, SHA-pinned Actions with StepSecurity harden-runner, and security-only Dependabot.

User grants full local/GitHub access and autonomous implementation/release/deployment within this project.
Manual step is user entering actual credentials into GitHub secrets. Do not build credential collection helpers.
Never read, echo, log or persist secret values. Inspect GitHub secret names only; use keys solely within Actions jobs.
Do not print environment dumps, auth files or credential-bearing requests. Follow .agent-deny.
