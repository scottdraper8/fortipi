# Evidence-governed testing
Full corpus reviewed: Evidence Governed Agentic Reverse Engineering pp.1–18; Behavioral Testing Overhaul Agent Protocol §§0–36; Interrogating the Codebase pp.1–30.
Original documents: local .agent-docs/tmp/reference/. Review relevant sections when designing consequential claims.

Derive oracles from requirements and documented contracts before implementation.
Separate observations (what ran), oracles (why expected), and sensitivity (which plausible defect the check catches).
Do not infer correctness from test count, coverage percentage or mocks matching implementation.
Use focused local checks where sufficient; use real storage/runtime/transport when their semantics determine the claim.
Disclose substitutions and their omitted semantics. Keep unverified claims explicit.

Prioritize: persist-before-acknowledgment, durable recovery, idempotent message submission, uncertain side-effect reconciliation,
duplicate dispatch prevention, fencing stale workers, revision-conflict rejection, credential separation, revocation,
filesystem traversal/symlink/secret exclusions, reconnect cursor ordering/resync, and public API compatibility.
Verify the TUI against a deployed endpoint and a minimal non-TypeScript client against the same contract.
Challenge critical checks with a few reversible faults/mutations tied to plausible wrong implementations.
Record exact commands/revision/environment, observations, independent oracle, sensitivity and limitations in one compact claim/evidence table.
Release QA independently reproduces consequential checks at the release revision and reports failures/skips/unsupported surfaces.
Use deterministic seeds and minimized counterexamples where property/fuzz testing earns its cost.

References: Evidence §§3–6,8,18.2; Protocol §§1–2,10,14–17,20–23,27–28,31; Comprehension §§4–8,10,14.1.
