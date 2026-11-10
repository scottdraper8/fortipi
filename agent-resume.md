# Resume FortiPi
Goal active: v0.1.0 completes only after actual Cloudflare deployment and verification.
Read .agent-docs/initial-prompt.md after compaction, then AGENTS.md; source hashes in .agent-docs/source-integrity.sha256.
Canonical proposals: .agent-docs/reference/; full testing corpus: .agent-docs/tmp/reference/; concise policy: .agent-docs/testing-policy.md.
Repo created/pushed: https://github.com/scottdraper8/fortipi (main). User grants full local/GitHub access; actual credentials are the manual step.
User will directly enter secrets. Exact instructions: .agent-docs/access-setup.md. Last name-only check: production/npm-release secrets and NPM_SCOPE all absent.
Production needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN. npm-release needs NPM_TOKEN + variable NPM_SCOPE. No credential helper or extra model key.
Deployment/publication gate: check environment OR repository secret names and NPM_SCOPE; dispatch Access preflight; never read secret values. Set namespace before packaging.
Release choice: independently installable npm packages + GitHub Releases; Cloudflare service; Workers AI first smoke proof. OIDC requires later interactive trust after first packages exist.
Original prompt/proposals/LICENSE committed. GitHub secret scanning/push protection/security fixes enabled; environments restricted to main/v*; default Actions read-only.
unstale init ran but no manifests yet and coverage service unavailable: rerun/configure automatic integration after deps exist.
Runner repairs complete: .agent-docs/tmp/tools/big-build/REPAIR.md; 40 fixtures passed; parent fixed irrelevant Codex quota cache gating for xai.
NATIVE CODEX HANDOFF: Pi script session 31749 is terminal after intentional Pi QA termination (exit 143), not a real quota failure. Do not restart the Pi launcher.
Phase 0 complete and original architect draft/threads retained in .agent-docs/tmp/big-build/fortipi-v0-1-0/. Draft has 13 threads and needs corrections.
Native Phase 1 QA running: Bacon 01a1c7b6-6040-7ac2-9218-388448e91514. Owns phase1/qa-review-native.md, master-plan-approved.md, threads-approved.json. Poll actual agent handle.
Next: inspect approved-copy corrections + DAG/ownership locally, reconcile canonical plan/threads, then use native Planner->QA, isolated Builder->Enforcer, Broad QA + two Deep QAs. Keep artifacts in the same phase paths.
Critical QA fixes: usable installed CLI deployment assets/no GitHub requirement; external model config; one-use browser WS tickets; bootstrap cannot read GitHub secret values or gh-secret-set with default GITHUB_TOKEN; published package imports/names must match; correct license metadata; meaningful deployed TUI/interop/fault proof; actual optional Linux adapter.
Source implementation can proceed after plan review while external secrets are pending. Deployment/publication require named CF/npm secrets, namespace and masked preflight. No application/deployment yet.
Local Node 26.13.0 and pnpm 12.18.0 verified: .agent-docs/tmp/toolchain/bin; prepend canonical PATH in worktrees. pnpm 12 uses a verified native binary, not the old CJS entry.
Parent fidelity guards in copied architect/QA prompts preserve FortiPi eventSeq/replay, atomic staged workspace commits, browser tickets and correct non-SPDX license metadata despite narrower research recommendations.
