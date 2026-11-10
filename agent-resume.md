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
Use Homebrew Bash + AGENT_HARNESS=pi. Existing Pi configured defaults xai/grok-4.7/xhigh and OAuth readiness verified, without credential reads. Set all role model/provider defaults consistently.
Compact build directive: .agent-docs/tmp/build-description.txt. Verified upstream package archives/types and metadata: .agent-docs/tmp/upstream/.
RUNNING: exec session 31749, python3 .agent-docs/tmp/run-big-build.py --stop-after-phase 1. Three explorers active, then Architect + QA. Poll the actual handle; do not restart on observation timeout. Artifacts: .agent-docs/tmp/big-build/fortipi-v0-1-0/.
Next: review Phase 1 QA corrections and reconcile canonical master-plan/threads; then same launcher --stop-after-phase 2 for plans. Builders require source/scope/DAG review and tooling setup. No application/deployment yet; goal remains active.
