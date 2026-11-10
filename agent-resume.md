# Resume FortiPi
Goal active: initial release v0.1.0; complete only after deployment and verification.
Read .agent-docs/initial-prompt.md after compaction, then AGENTS.md.
Sources: .agent-docs/reference/; testing corpus: .agent-docs/tmp/reference/; policy: .agent-docs/testing-policy.md.
Current step: repository/access preflight. GitHub scottdraper8 login verified. User enters secrets directly in GitHub.
Release channels selected: npm + GitHub Releases; Cloudflare Workers/Durable Objects service; Workers AI first smoke test.
Next: create GitHub repo/environments; provide exact secrets/scopes; verify names and auth via masked Actions preflight.
Then repair project-local big-build runner, initialize commit, explore verified upstream interfaces, and run architect/planner/builder/QA phases.
Installed runner supports Pi (available), default Claude (absent); use Homebrew Bash. Runner issues need fixes before launch.
Full testing corpus reviewed by Hilbert; concise policy preserved. No application implementation or deployment yet.
