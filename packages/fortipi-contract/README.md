# FortiPi contract

Protocol **1.0**, schema **1.0.0**. Package versions are independent. The fifteen
[JSON Schema 2020-12 documents](./schemas/common.schema.json) are authoritative;
[OpenAPI 3.1](./openapi.yaml) describes all 74 HTTP operations, their exact
path/query/body, success/error statuses, audience, grant action, and byte limits.
`src/route-catalog.ts` owns route allocation, not handlers. OpenAPI uses JSON syntax
(valid YAML 1.2), so the same bytes can serve `/v1/openapi.json`.

The five `/v1/executor/jobs/{jobId}` transfer operations use executor credentials
and the exact execution ID, assignment digest and current connection epoch.
The server derives the workspace, binding, leased base and original registered
owner from the retained attempted assignment. Its one current owner grant must
cover dispatch, the reserved actions, tool and all resources. These routes grant
access only to that execution's Computer working copy; they do not grant general
workspace reads or allow the executor to commit the canonical revision.

An existing native assignment awaiting local consent returns the closed
`waiting_for_local_policy` observation with its exact approval operation. This is
FortiPi's own wire state. It does not alter a model SDK, prove that restarting is
safe, or turn an unknown execution into a pending one. Consumers validate the
operation and current identity, preserve the lease/deadline, and reject delayed
waiting responses that would regress a newer running, result or terminal state.
After local approval, the current native incarnation reports `preparing` while
that durable assignment is queued or its working copy is being materialized,
before the winning start claim. This state carries the same exact operation;
it neither claims a running child nor permits replay after a crash. An uncertain
claim still reports unknown. Cloud adapters reject both native preparation and
local-consent observations.

Generate with `node packages/fortipi-contract/scripts/generate.ts`, then run the
same command with `--check`. Generation resolves only local allowlisted schema
IDs, bundles them before invoking the pinned schema compiler, and emits four
artifacts without network access, timestamps, or source-schema changes. Check
mode compares every output and never rewrites it. TypeScript uses the foundation
Biome formatter; OpenAPI uses compact JSON. No second formatting library is invoked.

Import `fortipi-contract` for resource DTOs, schemas, routes and generated
`OperationRequest<K>` / `OperationResponse<K>`. Each request has exactly
`{operationId,path,query,body}`; an absent body is `undefined`. Byte-route PUT
metadata has no JSON body: the octet stream travels through the owning object's
`fetch(Request)`, never a hidden RPC field. HTTP byte successes are bytes, and
101/204 have no body. Private workspace reads return `ByteReference` instead.
`ChunkInventory` carries only an announced `chunkBytes` grid and at most 256
actual chunk hashes; its grid fits negotiated/local caps and hash count equals
`ceil(size/chunkBytes)`. Zero-byte files have an empty hash list and no PUT.
Local reads first use the existing read request without transfers to return
`ByteReference.chunks` computed from retained owner bytes. Only then does the
authority allocate a scoped descriptor and repeat that correlated read with
transfers to start the producer. These requests retain the operation scope but
have distinct body-bound request/correlation identities. Metadata is not a
canonical byte copy or a substitute for checking current bytes and authority.

`AdminOperation.artifacts` uses closed `AdminArtifactReference` records with the
actual agent/conversations or workspace/revision scope and an exact admin byte
route. Agent exports need no workspace identity. Download through the existing
`getAdminArtifact` operation; workspace `ByteReference` helpers retain their own
route checks. Private export producers receive the actual `exports.create` or
`backups.create` action. Descriptors confer no authority: the owner checks current
grants, endpoint/ID correlation, measured size/hash and immutable retained bytes.

`UploadBegin.blobs` supplies one `{sha256,chunks}` plan for every distinct
declared put, including puts superseded by later ordered mutations. Local
uploads require it (explicit `[]` when no put); Computer uploads may omit it.
`validateUploadBlobs(input,{required})` checks exact coverage, shared-hash size
consistency, the chunk inventory and the complete 1 MiB control-body cap.
Puts sharing a SHA must agree on size even when optional Computer plans are absent.
`validateChunkInventory(chunks,size)` supplements exact schema parsing; actors
also enforce real limits/floors and verify file SHA, chunk SHA and length before
forwarding/applying. Plans use sizes from puts rather than assuming every put
survives in the final manifest. Duplicate/extra/missing plans reject. No new
endpoint, transfer descriptor shape, file bytes in metadata or hash recipe is
introduced; older calls without these optional fields retain their encoding.

Responses discriminate status and semantic error code; conflict reasons and
429/503 retry details remain typed. Lists default to 100 and allow 1–100 items;
opaque page tokens bind principal, resource, filter and view, never authority.

`fortipi-contract/client` exposes client commands/events and the complete client
schema dependency registry. `fortipi-contract/executor` exposes executor frames,
shared DTOs and its complete schema dependency registry, without client commands
or client routes. All entrypoints are portable and have no runtime dependencies,
Ajv, Node, Pi, Worker or server imports. Consumers own validators: register the
trusted schema registry with Ajv 2020 at module startup and reuse validators.
Workers must compile only fixed schemas at startup; downstream workerd startup
and post-activation evidence remains required. TypeScript represents structural
unions; schema validation and the named portable helpers enforce numeric/string
bounds and constraints beyond the type system.

## Identity, state and receipts

IDs are opaque 1–128 ASCII letters/digits/underscore/hyphen. Revision, SHA-256 and
fence have separate named schemas/types; hashes are lowercase 64-hex, fences are
positive canonical decimal strings. Sequences/generations/timestamps are safe
nonnegative integers (durable eventSeq starts at 1); timestamps are UTC ms.
`incrementSafe` fails at exhaustion. Credential generation, executor execution
generation, socket connectionEpoch, bindingVersion and leaseVersion are distinct
fields. Reconnection changes only connectionEpoch; lost executor ledger needs a
new explicitly authorized execution generation.

Canonical JSON sorts object keys by UTF-16 code-unit order, preserves array order,
uses JSON string/number encoding and maps -0 to 0. It rejects nonfinite numbers,
lone surrogates, accessors, cycles and non-JSON values. SHA-256 input is UTF-8 of
`fortipi:<domain>:v1\n` followed by canonical JSON. Domains are `manifest`,
`operation`, `assignment`, `commit`, `local-stage`, `local-intent`, `workspace-lease`; they are not interchangeable. Manifest hashing
sorts normalized paths by UTF-8 bytes and hashes `{version:1,entries:[...]}`.
Files carry path/type/mode(420 or493)/size/hash; directories carry path/type/mode493.
No timestamps, native roots or secrets enter a manifest digest.

`OperationDigestInput` binds deployment/agent/conversation/tool/arguments,
workspace/base, selected target, policy/grant versions and deadline.
`AssignmentDigestInput` adds execution/reservation/lease IDs, fence and executor
generation. `CommitDigestInput` binds commit/upload/operation/job/workspace/base,
manifest, immutable lease identity, and either sealed store or local observation.
Lease expiry/renewal version and socket epoch are excluded. Reusing an ID with a
changed immutable digest conflicts. A stable job mapping is persisted once from
Pi task identity and operation digest.

Digest helpers project their named preimages even when a structurally typed input
contains a complete renewed lease. Native local commits may omit uploadId: their
preparation and observation identify the effect without inventing an upload.
Computer commit digests require the actual upload and immutable seal.

An `applied` local observation may include `postManifest`, the complete retained
manifest for that operation. Legacy hash-only observations remain valid, but a
changed native result cannot commit without the complete matching manifest.
Other observation states forbid this field. The executor revalidates the root,
current authority and actual hash; the service verifies the manifest digest and
operation/base/execution/intent correlation before workspace commit validation.
Existing manifest and complete-frame limits still apply; oversized observations
fail closed without truncation or replay. Closed older validators reject the new
field, so consumers must qualify the same contract revision together.

Every wire Assignment requires closed `operationContext` with exactly deploymentId,
agentId, conversationId and safe nonnegative policyVersion. Private ExecutionRequest
requires that same context type, including for cloud backends. After exact schema
parsing, `operationForAssignment` reconstructs OperationDigestInput from context,
tool/arguments/workspace, identity base/target/deadline, and the lease credential's
grantVersion. Principal identity is not part of this v1 preimage. Await
`validateAssignment` before ledger admission/spawn: it rejects incoherent job/lease/
workspace/base/executor-generation identity, backend wire targets and either wrong
digest. Lease renewal expiry/version remains excluded. Current grants/floors,
lease/deadline eligibility, bindingVersion/rootBindingId and approval/local-policy
correlation remain actor checks; hashes do not grant authority.

Job transitions are created → awaiting_approval/authorized → queued or
waiting_for_executor → leased → dispatch_attempted → running →
result_pending_commit → completed. Waiting for local policy, workspace conflict,
failed/cancelled/interrupted/expired/requires_reconciliation are explicit states.
Tasks distinguish model/cloud-tool/local-device/human/local-policy/reconciliation/
workspace-conflict/kept-input waits; client connection state is separate.
Approval binds exact arguments/digest, base, target/trust/capabilities, policy/grant
versions and expiry. Revalidate before dispatch; approval cannot broaden a grant
or the daemon's local policy. Cancellation first acknowledges durable intent and
later reports stopped/not-started/already-terminal/unknown with possible external
effects. No rollback is promised. Unsupported resume is 501 with supported
continuations. Reconciliation verifies existing results/receipts, acknowledges
failed/unknown effects, discards stale staging, or requests a separately authorized
new job. It cannot reuse a stale lease or invent success.

A persisted transport ack means receipt, a prepared result means staged outcome,
and `job.committed` means verified workspace receipt or unchanged-base evidence
plus durable terminal version/event cursor. Success finalization requires that
evidence. Persist dispatch intent before sending. After an uncertain send, query
that execution; do not assign another target. `not_started` requires durable proof
excluding late start. Query never contains start arguments. After a lost commit
ack, recover `getReceipt({workspaceId,commitId,commitDigest})` under current grants,
even if the historical lease expired; never rerun the side effect.

Fact ingestion returns `FactBatchAck.acks`, one persisted acknowledgment with the
recipient-assigned eventId/eventSeq per fact. Forward these actual coordinates to
the source outbox; callers cannot invent a cursor. Revoke responses discriminate
200/complete from 202/pending, and complete has no pending recipients.

## Authorization, events and tickets

Authenticate and authorize before existence, provider status or cursor disclosure.
Admin role adds no implicit conversation/tool authority. Grants enumerate agents,
conversations, workspaces, actions/tools and permitted executor/backend targets.
Every resource authority is durably registered before attach/acquire/use. Target
reservations persist agent/workspace recipients and credential authority before
lease acquisition or send. Releasing one retains a tombstone until delayed starts
are excluded. Credential and executor invalidation subjects have persisted floors
at each registered recipient. Revoke is 202 pending until every matching ack is
durable; only then is it 200 complete. Floors fence delayed attach/acquire, renew,
result, apply and commit. Internal recovery/fact/model contexts are narrowly scoped
and cannot be constructed from public headers. Entry strips internal headers.

Target requests name operationId and ownerKind. Job reservations require job,
agent and conversation identities and both recipient registrations; direct
workspace-operation reservations require workspace authority without a fabricated
Pi task. Only job reservations authorize execution preparation/dispatch. In private
ExecutorIdentity, generation is the credential generation; executorGeneration is
the separate execution generation.

Mint tickets with an authenticated HTTPS POST. Default TTL 30s, maximum60s.
Browser mode binds an exact allowlisted scheme/host/port and matching Origin;
native mode requires no Origin. Reject null/unlisted Origins. Explicit preflight
permits needed methods/headers, with `Vary: Origin`; no wildcard credential CORS.
Do not follow redirects with credentials or forward them across origins. Store
only ticket hash. Consumption atomically checks deployment/audience/expiry/current
generations/scope/Origin and registers the destination before upgrade. Exactly one
redemption wins; failed upgrade consumes it. Forward the resulting nonsecret
SocketIdentity once, then recheck local floors before attach and every command.
Redact ticket queries in all proxy/request logs; never use reusable URL bearers.

TicketReceipt now requires redacted `identity: TicketIdentity` with exactly
deploymentId, principalId, role (`admin|client|executor`), CredentialRef and
credentialExpiresAt (UTC ms or null). CP constructs it from the validated current
AuthContext, never by decoding or inferring an opaque bearer. TicketReceipt.expiresAt
still describes only the short ticket TTL. Identity has no grants, raw bearer,
token hash, email, provider secret or internal routing IDs. SDK/TUI cursor scope
binds origin, deployment, principal and credential generation/grantVersion; a new
ticket's TTL does not change credential expiry. No new identity endpoint is added.

Validate OriginMode structurally and use `validateBrowserOrigin` for canonical
HTTP(S) origin syntax, then check the exact configured allowlist and HTTP Origin.

Durable envelopes include deployment, protocol/schema versions, conversation,
event ID, contiguous eventSeq, timestamp, durability and typed payload. Snapshot
projection and lastEventSeq are read consistently. Replay preserves stored IDs and
captures `through` on page one; later pages keep that high-water. After below the
retained floor returns410; a future cursor returns400. Redaction uses a stable view,
never per-view sequence filtering. Unknown durable types with valid base envelopes
are delivered generically and advance only after application; every known type is
excluded from fallback so malformed known events fail. Volatile message deltas,
tool output progress and heartbeat omit eventSeq and never advance cursors. Final
text/tool results are durable. Client commands and executor frames reject unknown
types. All acknowledgements/errors correlate requestId and client operation frames
reuse the HTTP DTOs. Undefined body is omitted when serializing subscription input.

Replay/live buffering is at most1MiB or256 frames; overflow sends
`resync_required`, closes1013, and advances no cursor. Normal close1000;
revocation1008; invalid payload1007; oversized1009. Executor heartbeat15s and
three missed beats disconnect. Event retention, admitted receipts and idempotency
keys last the conversation lifetime within admitted capacity; reject new work
before exhaustion. Compaction/reset/forks cannot regenerate original envelopes.

## Public workspace byte leases

Ordinary public writers obtain a lease without a Pi job or hidden management call:

| Operation             | Route / input                                                                                                                                 | Success                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| acquireWorkspaceLease | POST `/v1/workspaces/{workspaceId}/leases`, WorkspaceLeaseAcquire `{requestId,operationId,bindingVersion,baseRevision,deadline}`              | 201 existing Lease narrowed to ownerKind workspace-operation, no jobId               |
| renewWorkspaceLease   | POST `/v1/workspaces/{workspaceId}/leases/{leaseId}/renew`, WorkspaceLeaseRenew `{requestId,lease}`                                           | 200 actual renewed workspace-operation Lease                                         |
| releaseWorkspaceLease | POST `/v1/workspaces/{workspaceId}/leases/{leaseId}/release`, WorkspaceLeaseRelease `{requestId,lease,reason}`, reason completed or cancelled | 200 closed WorkspaceLeaseReleaseReceipt `{leaseId,released}`; no private tombstoneId |

All three are authenticated control-owned `workspace.write` operations, no-store
on success/errors, with existing typed error/status conventions. Describe/select a
binding and base first, acquire, then supply that returned lease to existing upload,
snapshot or transaction routes. Renew/release carry stable business requestIds;
renew's expected version is lease.leaseVersion. Path workspaceId/leaseId must match
the body lease; `validateWorkspaceLeaseSubject` checks that structural correlation
and non-job ownership after schema parsing. Current credential subject, resource
access, grants, expiry and floors remain authority checks. No automatic renewal
scheduler or client UI control is added.

CP derives current authenticated credential, registered workspace recipient, target,
fence and lease expiry. It selects expiry once, at most30s and bounded by operation
deadline and current credential/grant expiry, and persists its pending derivation
before authority RPC. After current auth/floors, a matching receipt/pending retry is
recovered before current version/base reconsideration; never recalculate expiry,
allocate another reservation/fence or replace the original input. Changed payload
under the same ID conflicts. The operation deadline is from the original request,
not a new AuthContext/RPC deadline. Renewal also persists its derived private
expiresAt/input before RPC; retries cannot do now+TTL. Source3 durably recovers
exact requestId/body receipts before CAS after floors. An old receipt never revives
an expired, released or revoked lease. TargetReservation.expiresAt bounds only the
first acquisition; it is not the renewal ceiling for an existing lease. Renewal
requires a still-active lease with current fence, floors and expected version, and
is bounded by the original immutable operation deadline, now+30s, and current
credential and matching-grant expiry. Persist that derived expiry and complete
private input before RPC; matching business-request receipts precede CAS without
creating a new fence or reviving stale authority. Release's public receipt omits
the private tombstone ID.

Private TargetRequest's workspace-operation variant requires baseRevision; job
requests additionally require executionId from the actual stable ExecutionIdentity
persisted by Agent5 before CP reservation/effects. TargetReservation retains it.
CP reservation idempotency binds that ID; dispatch/prepare must match the retained
ID to the actual execution identity before effects. Source3 job local-stage
descriptors use the retained executionId/jobId with the full unchanged transfer
scope, without guessing or scanning. This applies to native/cloud/builtin job
scopes without authorizing a new execution/workspace matrix or late effects.
Public workspace-operation leases gain no job/execution fields, and existing job
digest recipes stay unchanged (assignmentDigest already binds executionId).
Private LeaseRenewal and LeaseRelease both require stable
requestId, never a fresh AuthContext.requestId. Other private renewal/release fields
remain, including server-derived expiresAt and internal release tombstone receipts.
CP exposes generated ApiMethod ports for the three operations; consumers implement
actual routing/persistence.

Computer's non-job target is exactly `{kind:"backend",backendId:binding.workspaceId,
generation:binding.bindingVersion}`: a logical workspace storage authority for byte
leases, not an execution backend or paid capability. It needs workspace.write on
the workspace, not an unrelated execution-backend grant. There is no backend registry,
extra counter, guessed generation or config.execution dependency. Local targets use
the actual binding executorId and keyed current executorGeneration. Job targets remain
actual execution targets. Actor lease storage must retain target.kind: an executor
revocation floor must not alias a logical backend ID. Credential/binding floors
continue to fence both kinds; the public Lease wire gains no target field.

`workspaceLeaseDigest(WorkspaceLeaseDigestInput)` hashes domain `workspace-lease`
with exactly `{deploymentId,operationId,workspaceId,bindingVersion,baseRevision,
target,credential,deadline}`. Target kind/id/generation and CredentialRef's three
fields are explicitly projected. No principal/agent/conversation IDs are invented;
role/grants/auth-context/expiry/connection observations are excluded. Existing job
operation/assignment/commit digest recipes are unchanged. LocalScope.operationDigest
comes from the actual stored non-job reservation digest, never a manifest hash.
Stage content remains separately bound by enclosing uploadId, normalized manifest
hash, ordered mutations and the owning request digest. Helpers/types do not prove
CP/writer durability, auth, fencing, revocation or idempotent replay.

ExecutorTransferLimits is a required closed numeric observation on executor.register
and ExecutorDescription: `{chunkBytes,fileBytes,snapshotBytes,artifactBytes,manifestEntries}`.
All are positive integers with ceilings262144/67108864/268435456/16777216/4096.
Source8 computes actual post-discovery/profile/server/grid values; file/artifact
must also fit chunkBytes*256. After exact schema validation,
`validateExecutorTransferLimits` checks that grid relation. No remaining/headroom or
stageBytes is reported; actual staging uses snapshotBytes. CP persists only validated
registration observations, not heartbeat writes. Keyed resolveExecutorGeneration
now also requires `transferLimits:ExecutorTransferLimits|null`; null is only absence
of a validated numeric observation and never permits a guessed default.

Source3 rejects missing/incompatible grids, per-file/aggregate bytes and entry counts
before begin allocation. CP rechecks current registered caps before transfer.open
and bytes; source8 rechecks live caps before each byte. Reads use the actual owner's
ByteReference grid. These observations do not guarantee remaining capacity, online
state or future configuration: a runtime backend may still decline after change,
preserving the old canonical pointer. No service, callback, lookup scan or capability
string substitutes for this numeric record; authority/floor/grant checks remain.

## Workspace boundaries and transient transfers

Read/list/stat/manifest require revision; diff requires both revisions, read a
normalized path and optional bounded single range. Committed blob/artifact routes
prove resource grant and manifest/job membership. No generic staged-hash reader
exists. Byte consumers verify declared length/hash; an initial200 never proves a
complete stream. Streaming failure errors/truncates after headers; final status is
in descriptors, not trailers. Invalid range416; offline local owner503; missing
historic local content409/revision_unavailable.

Binary PUT operation bodies are Uint8Array. Byte GET responses declare
Content-Length and X-Content-SHA256 for the exact response body; range responses
also declare Content-Range. A relay chunk GET has no Range support. The optional
read query object uses deepObject encoding (`range[start]`, `range[end]`); when a
Range header is also present it must describe the same range or return400.
Private bulk transport remains authenticated fetch, rather than JSON RPC.

The public upload flow is begin → chunk PUT → validate → commit. Validation
returns an opaque stageId; `UploadCommit` names that stage plus the original
operation/commit/upload, lease/base and manifest. The authority resolves the stage
to its own seal or local observation, computes commitDigest and checks all original
eligibility conditions. Exact retries return the original receipt. Public
WorkspaceTransaction uses the same UploadCommit plus explicit mutations. No caller
needs or supplies a child allocation. Private CommitInput and WorkspaceTransaction
retain full seal evidence. Private CommitReceipt carries that proof; wire
CommitReceipt carries only opaque storeRef.stageId for computer revisions. Use
`publicCommitReceipt` for HTTP, event and executor delivery, including nested job
evidence; schema validation rejects leaked child/allocation/authority fields.

Mutation.put is closed `{kind:"put",path,sha256,size,mode}`: uploadId is forbidden
on individual puts. Puts use the single enclosing upload/stage. UploadBegin allocates
that ID after receiving manifest/mutations, so initial input never predicts a server
ID; transactions use commit.uploadId and local preparation uses mode.uploadId.

Decode URL input exactly once (`decodeWorkspacePath`), then validate valid UTF-8,
NFC relative POSIX paths, ≤1024 encoded bytes. Reject empty/dot/dot-dot segments,
NUL/control/backslash/absolute/drive/UNC/ADS inputs, device names, trailing dot/space
aliases, case/normalization collisions and unsafe modes. `.fortipi`, `.git`,
node_modules, .cache, .next, dist/build/coverage, .env*, key/pem, .ssh/.aws,
.npmrc/.pnpmrc, credentials*.json and auth.json are excluded case-insensitively.
The manifest helper checks aliases, collisions, file ancestors, sizes and modes;
adapters must additionally reject links, junctions/reparse points, special files
and external hardlinks, check ancestors/replacement races without following links,
and repeat validation at snapshot/read/stage/materialization. Filtered omissions
never imply deletion: transactions use explicit put/delete/mkdir with staged data.
Native root checks do not establish OS confinement or eliminate host-writer races.

Reject Windows reserved characters and superscript COM/LPT device names as well
as ASCII device names, following [Microsoft's naming rules](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file).
Case-insensitive manifests reject inconsistent parent spelling too (`A/one` with
`a/two`); native adapters must still check their actual filesystem's alias rules.

Cloud upload seals immutable revision bytes. Authority atomically checks lease,
expiry, credential/executor floor, fence, holder and base, then publishes pointer,
receipt and recipient outbox; rejected staging/CAS preserves old pointer and bytes.
The same WORKSPACES class/namespace has permanent authority/revision-store/scratch
roles. Child IDs are server-derived, never public. Allocation and tombstone live
permanently in the authority registry. Exact repeats observe; incompatible repeats
conflict. Only revision-store can seal; scratch cannot publish. Retirement atomically
tombstones an unreferenced/unpinned child before deletion, mutually exclusive with
publication. Child checks the authority registry outside its mutex, never self-RPC.
Deletion confirms deallocation, clears cached Computer handles, and forbids reuse
or resurrection after deleteAll. Count unchanged copied bytes and scratch.

Revision-store allocations require uploadId; scratch allocations require jobId
and executionId. Sealed state requires manifestHash, and retiring/deleted states
retain tombstoneId. A private SealedStore also carries the opaque stageId used for
public receipt projection; this does not disclose the child lookup identity.

One FIFO covers child Computer I/O, metadata and lazy pulls. Do not await cross-object
calls while holding it, nest/self-acquire it, or hold it across long runtime waits.
Authority pins/intents, unlocks, calls child, then rechecks before CAS. Scratch keeps
an exclusive execution pin until runtime and sync quiesce. Container handleFetch
is a narrow active scratch/backend bootstrap lane with upstream auth checks, no
application SQL/filesystem/FIFO entry; never a broad raw Workspace/stub API.

Local mutations use prepare → persisted LocalCommitIntent → one journaled apply →
observe → metadata-only commit CAS → receipt delivery/ack. Preparation stages without
changing canonical paths and pins root identity/full pre-manifest. CP persists apply
send intent. Daemon durably claims once before touching files; native execution is
through job.assign, never spawned by workspace apply. Lost apply ack resumes observe,
not apply. Applied requires complete verified post-manifest and journal evidence;
partial/unknown/drift quarantines the root for reconciliation. Only prepare/apply/
commit need an unexpired lease. Observe/receipt lookup/receipt ack may use historical
lease identity under current recovery/read grants and cannot authorize new effects.
Metadata commit requires exact pending intent, observation, current floors, binding,
unexpired authority lease, fence and base. CAS failure cannot undo host bytes.
Lost commit ack recovers the matching receipt; lost receipt delivery retries only
receipt. Persist receipt before releasing root pin. Never rebuild a missing ledger,
repair a stale fence or repeat execution on retry. Retained local revision reads
verify complete manifest before/after; never read current bytes as history.

Only LocalPrepare's staged-change mode adds required `manifest:Manifest` and
`mutations:Mutation[]` alongside uploadId/stagedDigest/postManifestHash; native-execution
mode is unchanged. The daemon receives the complete proposed metadata before its
prepared acknowledgment. Omission never means deletion: deletes and mkdir are
explicit. `localStageDigest({uploadId,manifest,mutations})` hashes
`fortipi:local-stage:v1\n` plus canonical JSON of
`{uploadId,manifestHash:await manifestDigest(manifest),mutations}`. Array order is
preserved; existing operation/assignment/commit digest recipes are unchanged.
After exact schema parsing, `validateLocalStage(mode)` checks postManifestHash,
stagedDigest and final explicit put hash/size/mode, mkdir and delete metadata claims,
respecting later replacement/deletion. It does not apply mutations to a real base
or prove any filesystem effect. At write admission call `validateLocalLease` and
recheck operation/digest/base/lease/fence/binding/deadline and current actor authority.
Actors verify the real pre-manifest, apply-once ledger, complete post-manifest and
local bytes. Metadata contains no file bytes and creates no cloud byte store or
endpoint. Bound the complete encoded request/frame to 1MiB before effects; an
oversized proposal fails payload_too_large/413, never split or inferred deletion.
The metadata helper's byte check supplements the final transport-envelope cap.

LocalCommitIntent uses `intentDigest`, never a premature commitDigest. The portable
`localIntentDigest` named preimage is `{commitId,scope,preparationId,preManifestHash,
expectedPostManifestHash?}` in domain `local-intent`. Scope keeps every LocalScope
field; its lease excludes only leaseVersion/expiresAt. An absent expected post hash
is omitted. Renewals do not change intent identity. Final CommitReceipt.commitDigest
still uses the existing `commitDigest(local)` recipe, computed only after the actual
applied observation supplies observationSeq and postManifestHash. Recover receipts
with that final digest, never the intent digest; no digest proves local filesystem effects.

Private WorkspaceObjectRpc.applyBinding takes ResourceAuthContext and
`{requestId,binding:{workspaceId,bindingVersion,config},expectedVersion,import?,executor?}`.
Null expectedVersion means first initialization without prior authority; rebind
requires import. Executor identity/generation is required iff config is local and
must match its executorId. CP durably records the stable pending request and
registration before RPC. Authority checks registered credential floors, exact request
digest and durable CAS, recovering a matching prior acknowledgment before considering
the current version. CP publishes only the actual returned WorkspaceBinding revision/
manifest, never invented metadata. The existing retained LocalRead.snapshot supports
pending-binding validation; no new bootstrap route or service is added.

Private CP.resolveExecutorGeneration takes `{workspaceId,bindingVersion,executorId}`
and returns `{executorId,executorGeneration}` after validating binding/pending binding,
grants and the keyed current executor. Unknown/revoked fails. Local reads use this
authoritative execution generation, never socket epoch, a scan or default0. Private
instance naming is CONTROL_PLANE.getByName("control") and WORKSPACES.getByName(workspaceId)
for authorities; child names remain server-reserved. Runtime DO classes expose version
through a prototype getter, `get contractVersion(){return "1.0" as const}`, since
instance fields are not RPC-visible. Boundary interfaces describe the value;
consumers must implement the getter on their actual classes.

Local bytes use the three executor transfer routes, with mandatory nonsecret
attemptId. Derive relative chunk/status paths from route metadata and descriptor
IDs; no arbitrary URLs, redirects, bearer in descriptor, WS bytes or cloud canonical
copy. CP stores scope/status only and matches two active fetch requests by exact
attempt/chunk/direction/authorized peers. Bounded transient RAM validates a full
chunk before exposure; recipient verifies chunk/full-file hashes independently.
At most two matched chunks/transfer, four/install; rendezvous10s, idle10s, chunk30s,
descriptorTTL≤60s and ≤lease expiry/deadline. At most one producer/consumer claim;
competing claims409. Identical completed PUT returns stored chunk receipt only;
a completed GET needs a new authorized attempt because RAM cannot replay history.
Peer loss/revoke/expiry/restart cancels streams and requires new attempt after
reauthorization. Reads can restart immutable available content; writes resume
observed staging only, never apply again. Repeated status calls allocate nothing
and extend nothing. 204 acknowledges chunk delivery, never local apply/commit.

## Infrastructure and provider authentication

Wire ceilings: JSON1MiB; output frame16KiB; aggregate inline64KiB; artifact16MiB;
manifest512KiB/4096 entries; file64MiB; chunk256KiB; revision/upload256MiB; two
uploads/workspace with15min TTL. Lease default30s, renewal10s, job deadline≤24h;
RPC deadline≤30s, long execution returns observations. Effective values are the
minimum of these ceilings and validated infrastructure policy, never Free-tier
entitlements. `freeInfrastructurePolicy` matches foundation defaults: object128MiB,
install512MiB, 25% repair headroom; file4MiB, snapshot/staging16MiB, 512 entries,
8 retained revisions, workspace64MiB; inline32KiB, artifact1MiB, output/job8MiB;
conversation2000 events/8MiB; one active mutating job, four queued; requests30 per
principal/min and120/install/min, SQL pages100, transfer concurrency4.

Reserve capacity idempotently before admission/side effects, retain reservation
identity over restart, pessimistically count unknown bytes and release only proven
unused/deallocated capacity. Count history/Pi/index/outbox/scratch/copies and preserve
completion/revoke/repair headroom. Capacity blocks new work rather than evicting
admitted history/receipts/referenced revisions. Free/unknown has no Loader/Containers
binding. Explicit paid selection needs current available capability evidence and
deployment validation; paid alone raises no bounds. Missing capability is501 with
setup metadata. No automatic provisioning/fallback. quota_exceeded429 and
quota_paused503 carry typed InfrastructurePressure and bounded retry details/
Retry-After. Distinguish short rate limits. Storage has no daily reset; advertise
only known reset/retry times, bounded UTC reset jitter where applicable. Coalesce
backoff in existing recovery work, no new poller/alarm. Shared-account/provider
failures can precede typed responses. There are no FortiPi model-provider budgets.

Provider auth uses exactly GET/PUT/DELETE `/v1/admin/models/{providerId}/auth` with
operation IDs getProviderAuthStatus/putProviderAuth/deleteProviderAuth and explicit
models.auth.status/write/delete grants. Status returns only provider/version/
generation/state/updatedAt. PUT is write-only OAuth (≤64KiB body, access/refresh
≤16KiB each, explicit bounded providerFields validated by registry), expectedVersion:
null for first version; DELETE is versioned logout with retained tombstone.

After schema validation, `validateProviderAuthPut` enforces UTF-8 access/refresh
limits and the complete 64KiB canonical JSON body bound. The HTTP reader also caps
the actual encoded request body before parsing; the provider registry validates
extension fields. JSON Schema maxLength alone counts code points, not bytes.
Principal/provider/requestId+digest idempotency returns receipt only. All auth,
credential and transfer responses are no-store. No public credential retrieval or
credential-bearing backup/fact/log exists. Config uses secretRef or OAuth providerId;
Workers AI binding is separate. API-key paths remain supported and plug-and-play.

Private resolveProviderAuth accepts only resource-limited ModelResolutionContext
and returns the pinned Pi ModelAuth/ProviderEnv privately. CP owns the allowlisted
Pi CredentialStore read/list/modify/delete implementation and encrypted OAuth store;
serialize ingest/refresh/logout and persist refreshed AES-GCM ciphertext before
resolution. Use fresh nonce and provider/version AAD, separate preserved optional
FORTIPI_MODEL_AUTH_KEY, required for OAuth, independent of bootstrap rotation.
Generation/version CAS rejects stale refresh publication after logout. SecretRef
adapter implements the complete read-only store contract, explicitly rejecting writes,
fileExists false and scoped env resolution. No ambient ~/.pi files. External model
factories use the private port; runtime gets no deployment credentials. Real Pi
login/AuthInteraction is CLI-owned. Upstream refresh followed by death before local
persistence can require re-login; exactly-once OAuth is not claimed.

CredentialReceipt is a closed union: state issued requires the one-time raw token;
state already-issued carries the same credential reference/role/expiry metadata and
forbids token. RotationReceipt.replacement uses this same union. Identical issuance/
rotation retries retain status201 but never recover the token; CP never persists it.
The separate optional Env.FORTIPI_ALLOWED_ORIGINS is deployment-owned, at most16
exact HTTPS origins with no paths, null or wildcard. Owners5/7 validate this binding;
it does not add a field to public Configuration or replace request-time Origin checks.

## Evidence scope

Native output artifact references carry `outputSource: { stream: "stdout" | "stderr" }`,
the actual collector's stream. A local `artifactId` also requires `chunks` and
`owner.executorId`. Ordinary workspace-file and cloud-artifact references retain
their existing shape. No offset is added; output transfers still use the closed
`{ kind: "job-output", artifactId, stream }` content variant.

ControlPlane indexes each artifact by its opaque ID from a validated executor
prepared result and the actual persisted dispatch/reservation, atomically before
transport acknowledgment. Matching retries preserve the original metadata; changed
metadata or reuse across jobs conflicts. The bounded index survives inbox acknowledgment.
This stores metadata only and observes effective output/storage admission bounds.

Workspace serves cloud artifacts as before. For an absent cloud record, it forwards
the current validated, registered reader context through the existing private
ControlPlane `fetch` port: `GET /internal/artifacts/{workspaceId}/{artifactId}` with
the existing server-only `X-Fortipi-Context` JSON header. Preserve Range and explicitly
forward the abort signal. No public endpoint, RPC method, namespace or metadata-write
callback is added. Public routing must strip internal authority headers.

ControlPlane authorizes `artifacts.read` for the actual workspace, job owner scopes
and executor before lookup disclosure, and again during relay. It checks current
reader/executor generations and limits. It builds the existing output descriptor
from the indexed actual job/execution, original operation digest, binding/base,
hash/grid and stream. The descriptor uses the **current reader's** credential and
no historical lease. Native output reads therefore keep historical job identity
separate from current reader authority; mutable staging retains its original
credential/lease checks. The executor verifies the exact retained artifact member
and stream. No component may infer streams from UUIDs/order or rewrite old hashes.

Use the existing `transfer.status` reply after the executor verifies its actual
private artifact bytes, size, hash/grid and output source. Correlate the original
`transfer.open` request ID, transfer/attempt IDs and executor generation. A zero-byte
output attempt waits for this producer acknowledgment; an index entry alone must
not fabricate a successful empty response. Missing/corrupt bytes interrupt the
attempt. For nonempty output, producer status cannot replace relay verification
of actual chunks. Retain the bounded attempt timeout and restart interruption.

Owners must prove a different authorized reader and an expired job lease can read
retained output, while wrong stream/member/job, missing metadata, revoked authority,
changed caps and corrupt bytes fail closed without starting a process. This is a
contract handoff; schemas do not establish that behavior.

Run from the repository with the pinned Node26.13/pnpm12.18 toolchain on PATH:

```sh
node packages/fortipi-contract/scripts/generate.ts
node packages/fortipi-contract/scripts/generate.ts --check
pnpm exec tsc -p packages/fortipi-contract/tsconfig.json --noEmit
pnpm exec tsc -p apps/worker/tsconfig.json --noEmit
pnpm exec tsc -p tsconfig.tools.json --noEmit
node --test packages/fortipi-contract/test/schema.test.ts packages/fortipi-contract/test/wire.test.ts packages/fortipi-contract/test/compatibility.test.ts packages/fortipi-contract/test/generation.test.ts
```

Compile the contract once without `--noEmit` before running Node tests, which import
its real emitted portable exports. Public fixtures import all three entrypoints;
private fixtures consume the actual pinned RPC namespaces/stubs, Pi Models and
container interfaces. Remote contractVersion is a promise on a platform RPC stub.
Worker/tools use the parent's reviewed skipLibCheck configuration for pinned upstream
declaration conflicts; maintained .ts and negative consumers remain strictly checked.
Public package declarations retain full checks.

| Claim                    | Oracle / actual observation                                                                                                                                                             | Sensitivity / limit                                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Route/schema coverage    | Independently enumerated74 method/path pairs, exact generated matrices, every ref resolved by real strict Ajv2020; browser bundles resolve no dependencies                              | No HTTP handlers, network auth or deployment proved                                                                                                                                              |
| Schema/wire semantics    | Fixed valid/invalid config, grant, local, transfer, OAuth, event and boundary fixtures accept/reject as specified                                                                       | Temporal authority/CAS/no-follow/durability remain consumer obligations                                                                                                                          |
| Event compatibility      | Unknown durable cursor advances; malformed known/volatile-sequence frames reject                                                                                                        | Disposable schema mutation removes known-type exclusions; malformed-known oracle actually fails, restore passes                                                                                  |
| Deterministic generation | Real generator and --check compare all outputs without writes                                                                                                                           | Disposable declaration and OpenAPI drift each fail; regenerated/restored check passes                                                                                                            |
| Portable identity        | Independent Node SHA-256 bytes match canonical digest; sorted manifest relation holds                                                                                                   | Pure JSON/path checks do not prove filesystem or durable ledger behavior                                                                                                                         |
| Private signatures       | Complete reserve/acquire/intent/query/stage/commit/receipt/fact/finalize, revoke/local/store/model flows compile; negative missing identity/authority/evidence calls rejected           | No fake backend, process, database, OAuth transport or runtime persistence substituted as proof                                                                                                  |
| Enforced regressions     | Exact commit preimage SHA-256 oracle; renewal stays identical while fence/generation/observation changes differ; public commit uses only validation stage and projects private receipts | Disposable emitted-helper mutation hashes renewal again and fails the digest oracle; disposable receipt schema exposes private seal again and fails the public receipt oracle; both restore/pass |

The canonical phase3 thread-2 build report records exact source commit, commands,
hook failures/skips and observed limitations. Downstream owners must prove actual
Pi/workerd startup, storage fencing/start dedup/restart, relay/local lost-ack and
callback/GC races, OAuth encryption/refresh, paid Linux/Loader, three OS behavior,
installed clients and deployed interoperability. This tranche claims no full CI,
deployment, publication or runtime durability.
