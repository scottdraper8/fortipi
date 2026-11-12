# FortiPi CLI

Management CLI with a build-time producer for the genuine Worker bundle, contracts,
templates, image-source context and original notices. Node 26.13.1 is required.
Missing producer inputs fail packaging; modified or incomplete installed assets
fail before preparation/deployment. Cloud deployment, actual native Windows ACLs
and independent installed offline qualification remain separate release gates.

After compiling the repository, `node packages/fortipi-cli/dist/bin.js --help` lists the current interface. Every command has `--help`; errors go to stderr with codes 1 (failure/uncertainty), 2 (input), 3 (setup prerequisite), 4 (version conflict), or 130 (cancelled). Results are bounded JSON. Credentials are never command arguments or JSON results.

Start from [the canonical example](templates/operator-config.example.json), replace its deployment and device selections, then run:

```sh
fortipi init --from operator-source.json --config operator.json --non-interactive
fortipi config validate --config operator.json --json
```

For guided configuration and setup from an attached terminal:

```sh
fortipi init --config operator.json
fortipi setup --config operator.json --directory prepared --profile production --json
```

`setup` also offers initialization when the config is missing. It confirms the
initial workspace, agent and exact credential grants before account changes, then
uses the same Wrangler login, prepare, deploy and provider-auth commands. The new
credential goes directly to a separate protected profile. It never starts model
work, installs an executor or enables paid services implicitly. A disconnected
selected device or unavailable model remains pending.

Re-run the same setup command to observe readiness or continue acknowledged
steps. Stable operation IDs and the confirmed plan are saved before effects;
unknown outcomes stop with `setup-uncertain`, without another deployment or token
issue. Noninteractive fresh setup fails when choices are missing. See the
[recovery details](../../docs/operator-guide.md).

Infrastructure failures include curated resource, measurement kind, limits, supplied reset/retry times and operator action on stderr. Remote messages, free-text reasons and resource identifiers are omitted. Unknown measurements and absent resets stay unknown; storage errors do not imply a daily reset.

`models list` keeps the pinned local catalog in `items`. With an existing selected
application profile it also observes the deployed protocol's redacted model
metadata in `deployed.items`. The provider filter applies to both catalogs.
`deployed.state` distinguishes `observed`, `not-configured` and `unavailable`;
unavailability does not erase the local catalog or imply provider readiness.

`executors bind --input PATH` binds a separately registered local executor/root
to a logical workspace using the original `WorkspaceBindingCreate` DTO. Adding
`--id WORKSPACE_ID` uses the complete original `WorkspaceBindingPatch`, including
CAS and acknowledged revision/manifest import. `config.kind` must be `local`;
executor/root IDs belong in `config`, never `--id`. This is the local-only alias of
`workspaces bind`, with the same authority/grant checks. It does not register an
executor, bind a host path or change local consent.

`runtime` follows the shipped `Configuration` schema. Workspace, execution, routing and models are independent selections. Free/unknown defaults use the contract's conservative bounds. Paid Loader/Containers require explicit canonical capability declarations; local validation does not prove Cloudflare account entitlement. The example requires a separately registered, authorized native executor and does not grant native shell permission.

Management uses an exact-origin protected application profile, selected with `--profile NAME`. Inputs to mutations are non-secret canonical DTO files. Credential issuance reserves and syncs its protected output before contacting the authority; stdout contains metadata only. A lost response leaves its request ID for recovery. Never remint blindly. Revocation may return durable `pending` and must be queried until complete.

Pi OAuth uses only the public supported OpenAI, Anthropic and separate OpenAI Codex factories, in memory. Browser/copy/device instructions require an attached interactive terminal. OAuth output is write-only to the application authority; provider credentials are never saved locally. API keys are entered through pinned Wrangler, using its prompt or inherited protected stdin. Unknown existing model-auth encryption keys are preserved.

`fortipi prepare --config operator.json --directory NEW_DIRECTORY --json` creates
a fresh verified directory. When replacing a prepared installation, add
`--previous-directory PRIOR_PREPARED_DIRECTORY`; its bound deployment identity,
configuration and declaration history must verify. Removing an existing paid
capability or changing/removing its migration history requires explicit repair.
That local receipt does not attest the migrations actually applied in Cloudflare.

Free defaults contain neither Loader nor Containers. Local capability declarations
cannot establish account entitlement. Dry-run uploads no secrets and returns a
build result only after actual emitted Worker bytes match the prepared manifest;
it is not a rollout receipt. Native Windows ACL, actual Cloudflare
and live-provider gates remain open. [Operator details](../../docs/operator-guide.md).

Build and installed verification (maintainers):

```sh
pnpm run build
node --test --test-concurrency=1 packages/fortipi-cli/test/*.test.ts
node packages/fortipi-cli/test/install-harness.ts /absolute/fresh-distribution-directory
```

Packaging requires the complete original image context and its matching
`apps/worker/dist/container/sources-and-notices.tar`. The archive hash must equal
the actual image metadata's `sourceKitSha256`; its strict member inventory,
source revision, recipe, package freeze and every context byte must match.
Recreating a kit from a newer checkout does not qualify the earlier image.
The provenance countercase temporarily changes a generated context member and
restores it; run the asset suites serially.

The harness uses actual CLI/contract packs and a bounded localhost registry serving
only reviewed cached public archives, with no upstream fallback or workspace links.
It runs a strict installed consumer, makes node_modules read-only, and invokes the
installed prepare command. It records absent outer publication notices truthfully;
release tooling owns their generation. It never treats local preparation as an
offline Wrangler proof.

The copied `consumer/offline-consumer.ts` must run separately with its
`distribution.json` under a different nonroot Linux UID, genuinely empty OS home,
inaccessible checkout and an offline network namespace. It refuses before home or
application inspection when the identity is unsuitable. No HOME override, patched
Wrangler or authentication file inspection is an isolation boundary.
