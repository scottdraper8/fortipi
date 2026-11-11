# Security and credentials

ControlPlane is a plain SQLite Durable Object, addressed only as
`CONTROL_PLANE.getByName("control")`. Workspace authorities use
`WORKSPACES.getByName(workspaceId)`. Public IDs are identifiers, not authority.
The Worker constructs authenticated RPC contexts and strips incoming internal
authority headers. `contractVersion` is a prototype getter returning `"1.0"`;
callers await the property on the actual platform stub.

## Application authority

Application admin, client and executor tokens are independent random 256-bit
credentials. Durable application rows contain SHA-256 verifiers, IDs, roles,
grants, expiry and generations; no retrievable application token. Verification
compares fixed-length digests with `timingSafeEqual`, including an unknown-ID
dummy comparison. Admin routes require the admin audience plus explicit grants.
Role alone grants no conversation or tool access. Executors cannot acquire a
client stream or use application/administration operations.

Delegation checks every resource/action/tool/target and expiry against the
issuer. Rotation publishes replacement issuance and old-identity invalidation
in one SQLite transaction. Issuance material is returned once. An operator must
keep an independently usable administrator when rotating its own credential.
Never log credential responses, authorization headers, provider responses or
complete request URLs. Audit records contain only bounded IDs, actions and
decisions. Authentication, status polling and executor heartbeats write no
last-used/audit rows.

`FORTIPI_ADMIN_TOKEN` is the application bootstrap, not a deployment or model
credential. Its fingerprint resolves to the same durable identity on redeploy.
Its revocation tombstone survives re-uploading that same secret. CI retains only
this application bootstrap. Trusted evidence issues short-lived, explicitly
scoped application/executor credentials and revokes them in cleanup. Pending
revocation is incomplete cleanup. Runtime receives no Cloudflare deployment or
npm publication credentials.

## Tickets and sockets

Tickets are opaque, hash-only, audience/resource/Origin-bound and one-use. The
default lifetime is 30 seconds, with a 60-second ceiling. Expiry equality rejects.
Ticket authentication needs no existing bearer. Consumption and destination
registration share one transaction, before upgrade. Failed upgrades spend their
ticket. A browser Origin must match the mint request's validated Origin; native
mode omits Origin. The Worker checks same-origin or its explicit HTTPS allowlist
before supplying `CredentialProof.origin`. Preflight is unauthenticated and
bounded; there is no wildcard credential CORS. Proxies must redact ticket query
strings from access/error logs.

An executor's application credential generation, execution generation and socket
connection epoch are separate. Reconnect increments only the epoch. Restoring a
lost execution ledger requires explicit new-generation authorization. The
upgrade and registration transactions recheck current credential authority;
registration also rechecks the executor generation and connection epoch after
asynchronous alarm scheduling, so a pending registration cannot restore a revoked
generation or superseded connection. The platform owns WebSockets and hibernation;
there is no Agents socket protocol or
second scheduler. Attachments contain nonsecret identity/scope/epoch metadata.
The negotiated heartbeat frame contains dynamic identity/time fields, so the
handler validates it rather than inventing a static auto-response. Each
authenticated current-epoch heartbeat records only the observed server timestamp
in the existing nonsecret socket attachment and its volatile liveness cache.
The attachment survives hibernation; no SQL row, history/event, audit, counter,
version or alarm is written by the heartbeat. This narrow correctness exception
to the original volatile-only plan retains the actual 45-second freshness bound.
A coalesced alarm records semantic offline transitions; observed offline
notification may be later. On wake, routing uses the retained observed heartbeat,
never a fabricated fresh timestamp or an old connected flag. See
[Cloudflare attachment semantics](https://developers.cloudflare.com/durable-objects/best-practices/websockets/#extended-methods).

## Dispatch, local files and delivery

ControlPlane persists target reservations and all agent/workspace recipients
before issuing authority for lease acquisition. It validates canonical operation
and assignment identities, stores dispatch intent, then durably claims the
first send before calling `socket.send`. Concurrent duplicates observe that
claim. Lost acknowledgments, disconnects and restart permit query of the same
execution, never another assign or a target switch. Cancellation retries retain
one identity and report actual disposition/possible external effects.
Intent and assignment require `jobs.dispatch`; cancellation requires `jobs.cancel`
over the retained agent, conversation, workspace, tool and target together.
Query requires `jobs.read`. Mutation authority does not grant public job reads,
and a retained intent or send receipt cannot bypass current credential/executor
floors.

Public writers use explicit acquire, renew and release lease routes under
`workspace.write`. Their durable business request binds its body and the first
derived private input before authority RPC. Lost acknowledgments reuse that
input and actual returned receipt, including chosen expiry and fence. Computer
holders name the logical workspace/version; private records retain target kind
so an unrelated executor ID cannot become its revocation subject. Public release
returns only leaseId/released and retains the private tombstone proof internally.
A pending release closes authority locally before RPC. Renewal uses the original
operation deadline and current credential/grant expiry, independently of the
first-acquisition admission cutoff. There is no automatic renewal scheduler.

Executor frames are validated against fixed trusted schemas compiled at module
activation. Sender credential, execution generation, connection epoch and the
stored assignment are checked before durable acceptance. Bounded output/results
are deduplicated by execution/type/sequence and payload digest. A transport ack
means receipt, not workspace publication or Pi success. Receiver acknowledgments
must match the original durable delivery ID/sequence.
The executor-facing output/result ACK identifies the executor's original outgoing
request ID and sequence only after persistence; the control-plane inbox keeps its
separate durable downstream receipt ID for delivery and repair.
Source facts retain stable IDs until the receiving agent returns its actual persisted event ID/sequence;
ControlPlane never invents a replay coordinate. Late prepared results can be
quarantined for authorized reconciliation without replacing an accepted outcome.

Local operations use prepare → authority intent → one claimed apply → observe →
metadata commit → receipt delivery. Only the returned preparation and authority
intent authorize apply. A missing apply acknowledgment resumes observe. Receipt
delivery verifies the actual authority receipt and retries only that receipt.
Observe and receipt recovery can use a historical lease under current read
authority; they cannot initiate new filesystem effects. The native daemon owns
root pins, local policy and its journal. Remote approval does not broaden that
policy or provide OS confinement. Local import must establish a retained,
explicitly approved revision before any retained snapshot is available.
An explicit successful local lease renewal forwards only the stored preparation
with the actual renewed lease. The same preparation and original authority intent
must be acknowledged; renewal cannot repeat apply or change staged metadata.

Local bytes use two simultaneously active HTTP requests. The executor routes are
`/v1/executor/transfers/{transferId}/input/chunks/{chunkIndex}` (GET),
`.../output/chunks/{chunkIndex}` (PUT), and
`/v1/executor/transfers/{transferId}` (GET status). Each includes `attemptId`.
Public input GET supplies only `attemptId`, as the canonical TransferQuery
requires; its expected chunk length/hash come from the retained descriptor/grid.
Producer PUT supplies and must match the explicit length/hash tuple before any
bytes are exposed. The service forwards the other peer
to `/internal/transfers/{transferId}/peer/chunks/{chunkIndex}` with an authenticated
`X-Fortipi-Context` envelope, after stripping that header from public requests.
This envelope is private Worker-to-DO transport, never a public credential.

A local read first returns metadata without starting a producer. ControlPlane
requires the owner's actual chunk inventory, then matches its grid, hashes,
file size and retained manifest membership before opening a descriptor. The same
operation with that exact descriptor starts the producer. Chunk grids are
negotiated integers up to 256 KiB, with at most 256 hashes; empty files use an
empty inventory and have no chunk PUT. Neither a different grid nor an
interrupted descriptor can authorize a producer. Metadata and local RPC bodies
are bounded before durable admission.
The executor registers five validated numeric transfer bounds. Keyed generation
resolution returns null when no current-generation observation exists. Every
transfer opening and byte operation rechecks current bounds; registration does
not promise remaining space, online availability or a future configuration.

The relay verifies one transient chunk buffer before exposure, honors consumer
backpressure and requires independent recipient hash verification. Limits are
256 KiB/chunk, two matched chunks/transfer, four/install or lower configured
policy; rendezvous/idle 10 seconds, chunk total 30 seconds and descriptor lifetime
at most 60 seconds and within lease/deadline. Revoke and delivered abort events
interrupt the entire attempt. Restart requires a new attempt. Completed PUT repeats only its recorded chunk receipt; completed
GET requires a new authorized attempt because vanished RAM cannot replay bytes.
No local bytes enter SQLite, R2, Computer, WebSocket JSON, logs or facts.

Native output metadata is indexed by opaque artifact ID in the same transaction
as its validated prepared-result acknowledgment. The actual retained dispatch,
reservation/execution ID, original binding/base, explicit stream, size and hash
grid must match. Membership is immutable and bounded to sixteen artifacts and
the current effective output/storage limits. Cross-job reuse conflicts. The
metadata survives inbox acknowledgment; exact retries after original credential
revocation retain the original transport receipt.
Native artifact endpoints may retain one matching original `revision` query on
the exact workspace/artifact path. Index validation rejects mismatched, duplicate,
extra, fragment, absolute or cross-scope endpoints and stores the original
reference unchanged; it does not rewrite endpoint strings, digests or hashes.
An authenticated current publisher can retain bounded evidence for a historical
execution generation in private quarantine. That acknowledgment never creates a
public artifact index, authorizes historical bytes, or starts another process.
Existing index entries remain subject to current executor floors.

An absent cloud artifact delegates privately to
`GET /internal/artifacts/{workspaceId}/{artifactId}` with the existing
`X-Fortipi-Context` JSON envelope. CP first validates the incoming Workspace
registration against the current caller credential. After lookup it checks
`artifacts.read` over the actual indexed agent, conversation, workspace and
executor, then registers that exact scope under the same current identity and
recipient. A minimal incoming Workspace registration is sufficient; no missing
grant is added. Missing metadata returns unavailable/404 without registering a
guessed scope. Repeated matching scopes reuse their actual registration.

Output descriptors retain the original job/execution, operation digest,
binding/base and exact artifact/stream, with the current reader credential and
no historical lease. Current reader and executor floors, grants, retention and
registered limits are checked during streaming. An expired or revoked original
job credential does not prevent a different authorized reader from retrieving
retained output. Explicit `revision` must equal the indexed original revision;
query duplicates, changed streams and unauthorized owner scopes fail closed.
Descriptor expiry uses a current covering reader grant; an expired redundant
grant cannot shorten another valid grant. Every fragment still rechecks current
authority and limits.

Full output is verified incrementally. A bounded range uses a full verification
pass to calculate the selected-body hash, followed by a fresh full-source
descriptor that drains all chunks while emitting the selected bytes. There is
no offset field or whole-file cloud buffer. The final fragment is retained until
the whole-source and selected-body checks complete. Responses use a
`FixedLengthStream` so their actual byte length survives Worker transport;
[Cloudflare documents this requirement](https://developers.cloudflare.com/workers/runtime-apis/response/).

Every transfer open records its request ID, transfer/attempt IDs and connection epoch
before send. Existing `transfer.status` replies must correlate exactly with that
current executor channel. Every zero-length purpose remains waiting until a matching owner
`verified` reply reports zero bytes and no chunks after checking its actual
retained source or durable staged consumer file. Metadata alone cannot manufacture availability.
Missing proof interrupts the attempt within ten seconds; a late proof cannot
revive it. Nonempty producer status never replaces actual HTTP chunk receipts or
receiver whole-file verification. Reopening the runtime interrupts incomplete
attempts and requires a fresh descriptor; it never reassigns execution. The
native collector currently emits no reference for an empty output stream; the
generic zero-reference path is exercised using an explicitly retained file.

Nonempty local-stage opens return before byte transfer. Their final to-executor
producer PUT, including an exact receipt retry, waits at most ten seconds for the
same-open consumer status after all actual GET chunks finish and the consumer
verifies the whole file and durably persists verified_blob. GET reaches EOF
normally so this proof can finish. Duplicate PUTs share the existing bounded wait;
duplicate statuses preserve the same receipt. Current grants, expiry, executor
generation and connection epoch are checked again after the wait. From-executor
producer PUTs return after actual chunk verification without waiting for the
producer's later status, avoiding a circular dependency.

Terminal delivery verifies private authoritative proofs before recording its
command. The Agent path is `POST /__fortipi/terminal-proof/{jobId}` with
`X-Fortipi-Context: <current registered Agent AuthContext JSON>`. The Workspace
path is exactly `POST /__fortipi/terminal-proof` with
`x-fortipi-workspace-context: {"auth": <current registered Workspace AuthContext>}`.
Both consume existing `JobCommitted` JSON bounded to 64 KiB and return the same
validated JSON with status 200 and `Cache-Control: no-store`; failures use the
existing redacted error body/status. CP bounds waits/bodies, compares the exact
reply and rechecks current authority after awaits before persisting the command.

Agent registration carries `jobs.dispatch` for the actual job scopes. Workspace
registration separately carries the actual selected workspace operation action
and original workspace/agent/conversation/target scopes, with no tool projection.
Committed evidence requires original reserved write authority and current write
authority. Unchanged-base proof needs an original reserved read/write operation
and current read or write authority. Separate grants are supported; no combined
read/write/dispatch grant or public `jobs.read`/`conversations.read` prerequisite
is introduced. A replacement credential may prove immutable historical evidence
without refreshing the old job lease or rewriting hashes. Source5 must implement
the Agent's actual known-job/owner/floor/dispatch checks and authoritative terminal
version plus exact durable `job.state.changed` event sequence. CP fixture proofs
do not establish that future implementation. Public routers must enforce each
route's audience even when an action such as `artifacts.read` is shared by
application and admin routes, and must strip all internal authority headers.

Explicit job lease notifications compare against CP's retained current renewal,
not the original assignment's expiry. Version advancement and its durable command
receipt share one transaction. Exact retries preserve the receipt; older receipts
cannot regress or resend over a newer renewal. New updates cannot revive an
expired retained lease, exceed the wire/deadline/current authority bound or bypass
the original credential floor. These are forwarding checks; the notification is
still required to originate from the actual private Workspace renewal result.

The local Wrangler proxy did not propagate an unmatched GET disconnect within
500 ms, including with explicit signal forwarding and the documented
`enable_request_signal`/`request_signal_passthrough` flags. Actual HTTP tests
prove settlement by the ten-second rendezvous deadline; they do not prove
immediate disconnect cleanup. Deployment configuration and forwarding must
preserve incoming signals; [Cloudflare's compatibility rules](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)
describe both flags. Managed integration and deployed cancellation remain
separate evidence requirements.

## Revocation and infrastructure pressure

The first revocation transaction changes durable status/generation before
fanout. Registration either precedes that transaction and enters its immutable
cutoff or is denied. Credential and executor subjects are distinct. Registered
recipient records/floors are retained after reservation release. Fanout pages are
bounded and acknowledgments must match subject, recipient, revocation ID and a
persisted minimum floor. A closed socket, successful send, timeout or unreachable
recipient cannot complete revocation. Empty-recipient completion is valid.

One existing alarm drains due work in bounded turns. Delivery/backoff state is
durable, retries are idempotent, and attempted assign is never a drain action.
No cross-DO instantaneous revocation or recall of in-flight network bytes is
promised. AgentSession and WorkspaceObject must order their own persisted floors
with attach/lease/result/commit and check expiry on outbound subscription delivery.

Capacity reservations retain identity across retry/restart and count outstanding
claims pessimistically. A failed/uncertain write does not release capacity.
Settlement requires measured bytes under internal authority and is idempotent;
consumed bytes remain charged. Physical SQLite size and reserved usage preserve
completion/revoke/repair headroom. Existing history/receipts are not evicted to
admit new work. Unknown/free defaults are conservative; paid account status alone
does not raise bounds or provision Loader/Containers. Account-wide remaining
capacity is unknown without authoritative telemetry. There is no quota poller,
deployment credential in runtime, or model-provider token/hour/week budget.
Request-rate admission uses bounded volatile per-incarnation minute windows;
durable reservation accounting survives process death. Health and usage expose
actual outstanding slot/storage claims and overdue repair work, without a
shared-account remaining-capacity assertion.
Application admission preserves the configured fraction for repair attempts.
The alarm has both a per-turn and per-minute repair bound; an exhausted local
window persists its next eligible minute and rearms there, preserving pending
work instead of repeatedly waking against an exhausted window.
Validated recipient quota refusals retain pressure and their actual known reset,
retry time and retry-after advice. Durable per-row eligibility prevents duplicate
wakes from advancing a retry. Storage refusal has no invented reset and removes
the task's timed due date until confirmed reclamation or a new configuration
permits repair. Matching configuration/settlement retries do not clear that hold.
These are local policy/receiver observations, not account-wide quota telemetry.

## Provider authentication

Workers AI remains a separate binding. Standard API keys use configured server
secretRefs. OAuth supports OpenAI ChatGPT (`openai`), Anthropic (`anthropic`) and
the distinct OAuth-only Codex provider (`openai-codex`). CLI interactive login
uses public Pi Models with an in-memory store; it never harvests ambient Pi auth
files. ControlPlane imports narrow public Models/provider exports and installs
Worker-safe refresh/toAuth adapters, leaving Node callback-server login in CLI.

GET/PUT/DELETE `/v1/admin/models/{providerId}/auth` require their explicit
`models.auth.status/write/delete` grants. PUT is write-only and versioned, with
at most 64 KiB encoded canonical body and 16 KiB each for access/refresh strings.
The registry bounds provider fields and preserves OpenAI issued clientId/scopes
and Codex account binding. Status, tombstones and mutation receipts contain no
credential. Public export/backup must exclude provider-auth rows.

The dedicated optional `FORTIPI_MODEL_AUTH_KEY` is a preserved independent
256-bit AES-GCM key (64 hex digits or standard base64). Missing/wrong key denies
OAuth; bootstrap rotation never derives or replaces it. Each ciphertext has a
fresh 96-bit nonce and AAD binding deployment/provider/format/key ID/generation/
version. Complete credentials exist in plaintext only transiently during trusted
resolution. Each provider has its own promise chain covering the entire async
modifier and durable publication. Undefined from Pi `modify` means unchanged;
only delete removes the credential. Ingest/logout share that chain and publish
their idempotency receipt in the ciphertext transaction. Generation/version CAS
and a final caller check prevent stale publication after logout/revocation.

A durable refresh-intent marker precedes token exchange. Caller cancellation
does not release an active refresh's store lock or discard its persisted result.
An orphaned/failed exchange requires reauthentication instead of blindly retrying
a possibly consumed rotating refresh token. Fixed HTTPS token endpoints use a
real Worker Request with manual redirects and reject every 3xx, bound responses
and sanitize errors. Private resolution returns only
request auth for the configured model factory. No public credential retrieval,
ambient file lookup, provider agent loop or universal OAuth compatibility claim
exists. Synthetic refresh tests do not establish a live provider subscription.

Refresh protocol adaptation follows the pinned Pi AI 1.5.2 OpenAI ChatGPT,
Anthropic and Codex OAuth implementations, Copyright (c) 2025 Mario Zechner,
[MIT](https://github.com/earendil-works/pi/blob/v1.5.2/LICENSE). Distribution must
retain the complete upstream MIT notice supplied by the repository license gate.

## Reproducible evidence and limits

Run from the worktree with the canonical Node26.13.0/pnpm12.18.0 toolchain first:

```sh
node packages/fortipi-contract/scripts/generate.ts --check
pnpm exec tsc -p packages/fortipi-contract/tsconfig.json
pnpm exec tsc -p apps/worker/tsconfig.json --noEmit
pnpm exec tsc -p tsconfig.tools.json --noEmit
node --test apps/worker/test/control/*.test.ts
node apps/worker/test/control/sensitivity.ts
```

| Requirement oracle                                                | Actual local observation                                                                                                                                                                                                       | Sensitivity / limit                                                                                                                                            |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One ticket has one consumed identity/registration                 | Concurrent ticket-only redemption admits one; audience/Origin/destination/expiry/spent retry reject                                                                                                                            | Disposable removal of consumption fails the independent single-redemption assertion; restored copy passes                                                      |
| Revoke cannot complete before every matching floor acknowledgment | Real recipient storage writes a floor, drops its ack; CP denies immediately and stays pending, then completes after matching retry                                                                                             | Disposable premature-completion mutation fails the pending assertion; restored copy passes. Recipient fixtures prove CP orchestration, not sibling enforcement |
| Attempts cannot turn ambiguity into another assign                | Actual WebSocket registration/heartbeat and concurrent assign; one assign frame, then query/unknown and no second assign                                                                                                       | Frame counts are transport evidence, not native process-start proof                                                                                            |
| Semantic facts repair a lost acknowledgment                       | Persisted recipient event coordinates survive dropped ack; retry retains source identity and appends no second event                                                                                                           | Controlled SQLite/KV recipient fixture; actual AgentSession event projection remains integration evidence                                                      |
| Capacity cannot over-admit or partially acknowledge               | Competing final-slot requests, exact settlement and actual SQLite trigger refusal mid-transaction                                                                                                                              | Trigger abort substitutes storage refusal, not Cloudflare account exhaustion                                                                                   |
| Local bytes need a live peer and verified content                 | Two real HTTP requests rendezvous; independent Node SHA-256 matches delivered bytes; unmatched producer is not acked; completed GET cannot replay                                                                              | Local HTTP fixture explicitly forwards synthetic HTTPS internally; production TLS, real local daemon and network disconnect matrix remain integration gates    |
| OAuth persistence precedes resolution and survives process death  | Actual workerd Models.getAuth and all three adapters use synthetic token transports; serialized refresh/CAS, key/AAD/tamper rejection; abrupt Wrangler/workerd kill/reopen decrypts complete credential with no second refresh | Synthetic credentials/transport; no external account, live provider or deployment claim                                                                        |
| Bootstrap and reservations survive abrupt restart                 | Real `wrangler dev --local --persist-to` process tree is killed, same config/object/state reopens with committed canary, same reservation and revoked bootstrap                                                                | A local process restart is not deployed platform eviction; createTestHarness reset is not used as persistence proof                                            |

The canonical phase3 thread-4 build report records final revision, exact commands,
all-file hook failures/skips and remaining blockers. Release still requires real
AgentSession/Workspace floors and application replay, native executor start/local
policy/import evidence, browser/public-client transport, selected Cloudflare
capabilities and deployed release verification. No test count or green mock
substitutes for those observations.
