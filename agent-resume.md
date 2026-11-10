# Resume FortiPi
Goal active: v0.1.0 completes only after actual Cloudflare deployment and verification.
Read .agent-docs/initial-prompt.md after compaction, then AGENTS.md; source hashes in .agent-docs/source-integrity.sha256.
Canonical proposals: .agent-docs/reference/; full testing corpus: .agent-docs/tmp/reference/; concise policy: .agent-docs/testing-policy.md.
Repo created/pushed: https://github.com/scottdraper8/fortipi (main). User grants full local/GitHub access; actual credentials are the manual step.
User will directly enter secrets. Exact instructions: .agent-docs/access-setup.md. Last name-only check: production/npm-release secrets and NPM_SCOPE all absent.
Production needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN. npm-release needs NPM_TOKEN + variable NPM_SCOPE. No credential helper or extra model key.
Next gate: check secret names, dispatch Access preflight, verify masked results; do not read secret values. Set namespace from NPM_SCOPE before packaging.
Release choice: independently installable npm packages + GitHub Releases; Cloudflare service; Workers AI first smoke proof. OIDC requires later interactive trust after first packages exist.
Original prompt/proposals/LICENSE committed. GitHub secret scanning/push protection/security fixes enabled; environments restricted to main/v*; default Actions read-only.
unstale init ran but no manifests yet and coverage service unavailable: rerun/configure automatic integration after deps exist.
Project-local runner repairs in .agent-docs/tmp/tools/big-build/; repair agent Ptolemy 01a1c788-9ded-7843-bf4b-b1611e168ed6 may still be working. Check its final report before launch.
Use Homebrew Bash + AGENT_HARNESS=pi. Existing Pi configured defaults xai/grok-4.7/xhigh and OAuth readiness verified, without credential reads. Set all role model/provider defaults consistently.
Compact build directive: .agent-docs/tmp/build-description.txt. Verified upstream package archives/types and metadata: .agent-docs/tmp/upstream/.
Run repaired big-build fortipi-v0-1-0 with exploration (PiHarness/Computer lifecycle APIs, secure executor/snapshot semantics, package/release compliance), batch-size 2, two deep QAs, adequate call ceiling.
No application implementation, package publication or deployment yet. Keep goal active; validate deployed client/TUI and durability/security claims before completion.
