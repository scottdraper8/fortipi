# Accepted session steering
- User explicitly requested a goal; completion requires deployment. Goal created and active.
- User granted full local/GitHub access. No repeated permission prompts for ordinary task work.
- Manual input means API keys/credentials. User will put them directly in GitHub secrets.
- Do not implement extra credential entry helpers.
- Derived release choice: npm for independently distributable TS packages, GitHub Releases for release artifacts, Cloudflare for service.
- Derived first deployed model test: Workers AI binding, avoiding a separate provider credential. Preserve configurable external providers.
- User questioned Pi-based delegation; remaining big-build phases now use native Codex subagents, preserving roles, artifacts, QA gates and isolated builder worktrees. Completed Pi research/architect draft retained; Pi QA intentionally stopped for handoff.
- Finished-product setup: CLI -> supported Cloudflare/Wrangler sign-in -> model/workspace/executor configuration -> deploy. GitHub is our CI path, not an end-user prerequisite. Workers AI needs no separate model key; external providers use supported provider credentials stored server-side. TUI/executors use separate scoped app credentials.
- User prefers the product and maintained tooling in the same language: TypeScript for all owned scripts/automation as well as all product packages. Retain only the deliberate isolated non-TypeScript protocol client proof and third-party pre-commit.
