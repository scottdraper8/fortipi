# Releasing FortiPi

Only the parent operator dispatches release/deploy workflows. Source tooling passing is not a published or deployed release. Required evidence remains unavailable until the actual producers run successfully at the final source, version, scope and image. `fortipi-ci-test` is permanently nonpublishable.

Use the pinned Node/pnpm toolchain and normal frozen installs. Build the real Worker, asset tree and five public packages, then generate notices; do not copy dependency trees, fabricate assets, change embedded Worker bytes or repack retained archives. The qualified image context, source kit, metadata and original legal material must be present. Old image inputs may exercise source packaging while final image/security acceptance remains blocked.

## Immutable candidate and evidence

`node scripts/prepare-release.ts candidate --version VERSION --commit-sha FULL_SHA --scope SCOPE` requires a clean committed checkout. Its stdout is only `{schemaVersion:1,candidateManifestPath,candidateSha256}`; progress goes to stderr. The ignored destination is `.agent-docs/tmp/release/VERSION/SHA/SCOPE/`. Normal build, notices, typing, schema, pins, licenses, compatibility watch, tests and hooks run before packing. A failed prerequisite fails preparation. The command never invokes the successor evidence runner recursively.

The manifest inventories exact saved files, each actual archive and entry, SHA-256 and SHA512-SRI, source/lock/policy/publication map, asset manifest and image/source-kit identities. The GitHub artifact archive digest is a separate identity. Never edit a retained candidate. A scope, version or byte change requires a new candidate and affected proofs.

The `Release` dispatch accepts `candidate` or `publish`, version, full commit SHA, normalized scope, exact `vVERSION`, and confirmation `OPERATION vVERSION FULL_SHA SCOPE`. The image input is the qualified producer descriptor `{sourceCommit,metadataSha256,runId,runAttempt,artifactId,artifactDigest}`. It must identify real successful rootful/rootless jobs and actual downloaded metadata. Context recreation uses that exact source and verifies its kit hash; runtime facts are not relabeled.

For publish, `candidate` is the immutable `ArtifactReference`:

```json
{
  "runId": 1,
  "runAttempt": 1,
  "artifactId": 1,
  "artifactName": "candidate-FULL_SHA-SCOPE-1-1",
  "artifactDigest": "sha256:ARCHIVE_SHA256",
  "candidateSha256": "MANIFEST_SHA256"
}
```

Numbers and hashes above are structural examples, not proof. `evidence` is an array of `{kind,artifact:ArtifactReference}` for integrated, native, access, live and independent receipts. API validation checks canonical repository, exact SHA, workflow bytes, current completed successful attempt, required jobs, artifact lineage/expiry/time window, ZIP digest and exact payload. PR/fork, superseded, skipped, missing, unavailable or mismatched results fail. Candidate/integrated/native/access ages are at most 24 hours; live/independent at most six hours; current readiness at most 15 minutes; future timestamps have a one-minute tolerance. Historical publishing attempts have separate recovery semantics and cannot satisfy behavioral gates.

Evidence10 supplies the import-safe runner and real fixtures. The sole process interface is:

```sh
node tests/clients/run-evidence.ts local --candidate PATH --fixture tests/clients/fixtures/local.json --out DIR
node tests/clients/run-evidence.ts native --candidate PATH --fixture tests/clients/fixtures/local.json --out DIR
node tests/clients/run-evidence.ts live --candidate PATH --deployment PATH --fixture tests/clients/fixtures/LIVE_DESCRIPTOR.json --out DIR
```

Missing runner/fixture or missing required rows fails. The runner writes `gate.json` plus inventoried claim-result files using exported version-1 types in `scripts/verify-release-gates.ts`. Each claim result supplies its own observations, oracle, executed sensitivity and limits. Three real native OS jobs are aggregated; labels do not substitute for native execution. CI/access producers must retain their canonical receipts before release gates can qualify them.

## Protected targets and credentials

`Deploy and independently verify` accepts one nonsecret target with `schemaVersion:1`, `accountBindingSha256`, optional `slot`, `backend`, and validated `operator`; Linux adds the actual `containerApplicationId`. Paid selection requires explicit `paidAuthorized:true` and paid capabilities. Slot is only `production` (default) or `paid-validation`; each selects its own existing protected environment secrets. Production stays Free by default. Free omits both Loader and Containers; selecting a slot never changes a subscription.

The target operator's deployment must omit `accountId`. Compute the public account hash outside these artifacts; the actual `CLOUDFLARE_ACCOUNT_ID` remains a job-only secret. Controllers compare its SHA-256 before Cloudflare requests or passing it privately to Wrangler. Only hash bindings enter receipts, configuration or artifacts. Do not include keys, tokens, raw IDs, secret references containing values, credential-bearing URLs or auth responses in dispatch data. Never dump the environment or read auth files.

The actual retained CLI installs outside checkout before deployment credentials are exposed. Supported installed `prepare` and `deploy --bootstrap existing --non-interactive --json` preserve the existing `FORTIPI_ADMIN_TOKEN` stdin path. Only the deploy child receives the CF role and preserved admin token. Evidence children receive the application admin role only; owner10 creates/revokes least-privilege clients/executors. npm and GitHub roles are absent from those children.

Live observation requires the final actual Worker version, active deployment with 100% traffic, exact prepared/runtime configuration, supported binding/export settings, asset manifest, configuration version and selected image digest. `verify` requires the original exact CLI receipt retained in a trusted live artifact and runs separately without redeployment. No local restart, API fixture, dry-build or metadata-only check proves platform recovery or live deployment.

Publication still requires separate Free, cloud-JS and Linux target rows. These may use different account hashes and protected slots. `targets` is exactly three `{target,previous:{artifactId,path}}` descriptors pointing to actual retained live CLI receipts. Readiness runs one target per protected job, before publication and again before finalization. These read-only observations never refresh older behavioral evidence. Until the user decides the paid scope and provides the applicable account, required paid rows remain unavailable; no upgrade or scope waiver is implicit.

## Publication and recovery

`npm-release` requires protected `NPM_SCOPE` matching the candidate and `NPM_TOKEN`. Their absence is a hard failure. No helper collects credentials. Only the isolated publisher receives npm auth and the OIDC request channel. Publication uses pinned pnpm on the exact retained tarballs, dependency order contract → client → TUI → CLI → executor, scripts disabled, public access, provenance and a bounded availability wait. There is no repack, force, batch upload or blind retry.

The journal is synced before each upload effect. Accepted-but-unavailable and unknown outcomes remain incomplete. Read-only reconciliation downloads the existing registry archive and compares both hashes. A different archive stops; a 404 after intent never permits another upload. The workflow always attempts to retain the redacted journal, including on failure.

To resume, provide `journal` as the exact ArtifactReference for the latest started publisher's retained publication artifact. Its failed/superseded attempt may be historical recovery evidence only after exact source/API/archive checks. Without that journal, a prior publisher means reconciliation only: matching registry bytes can settle existing versions, but missing versions cannot be uploaded. Missing history/access also fails. Parent review is required to resolve an unrecoverable uncertainty; never erase the journal to retry.

A fresh registry-resolved npm consumer installs exact versions with scripts disabled and runs the pinned Node-bundled `npm audit signatures --json --include-attestations`. Each of five actual verified bundles must bind the retained archive, source, workflow, run attempt and certificate identity. Historical matching versions retain their actual publishing lineage. Token plus provenance is not npm trusted publishing. Distribution evidence runs again; upload acceptance alone proves none of its runtime claims.

Only finalization receives GitHub contents-write. It rechecks current targets and all older proof ages, then creates/verifies the exact tag, reconciles a draft release and downloads/hashes existing assets before reuse. Tags never move and assets never overwrite. Another gate check follows uploads before making the draft public. A partial npm publication, draft, tag or uncertain deployment remains incomplete; no rollback is claimed. No live operation is authorized merely by these source checks.
