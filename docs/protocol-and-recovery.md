# Protocol and recovery

The generated catalog defines the public operations and schemas. The router independently enforces administrator audiences, including operations that share `artifacts.read` with application routes. Byte requests preserve streaming, Range and cancellation through the owning authority. Public internal-path selectors and arbitrary RPC upgrades are rejected.

## Conversation admission

The application records a stable intent and capacity reservation before invoking Pi. The Pi operation ID is stable across retries and process replacement. Recovery queries the supported committed submission before deciding whether an input still needs admission. A timeout does not establish rejection.

The accepted receipt binds operation, message, task and original event sequence. An identical retry returns that receipt before checking the current conversation revision. A changed payload under the same idempotency key conflicts. A committed Pi input can precede the receipt; an application mapping barrier prevents it from acquiring a second public message identity during projection.

Creation and fork intents identify their actual Pi allocation with an application document written by the supported creation hook. Recovery scans bounded pages for that provenance. It does not create another conversation merely because an allocation response was lost. Fork history must come from the actual committed source prefix.

## Application log and wake recovery

Committed Pi entries and submission outcomes drive the application projection. Stream deltas and commit hints are advisory. Source identity, canonical messages, task mappings, admission receipts and terminal attestations survive replay-window reclamation. Snapshot and replay reads use a consistent application transaction; expired cursors require resynchronization.

Application repair uses a fixed registered Lifecycle job type and persisted generation-specific job IDs. A successor is armed before its predecessor is retired. App state revalidates ownership after awaits; an older Lifecycle outcome can finish only its old row. Ordinary continuation uses the supported `rescheduleAt` outcome. Dirty notifications coalesce. PiHarness retains ownership of its separate task wake mechanism.

The pinned Lifecycle same-ID replacement primitive loses a newer wake in the reproduced stale-retry race. Production repair avoids that primitive. The pinned Pi delayed-publication rejection issue is reproduced in strict Node children; calibrated actual workerd checks preserve rejection without an uncaught failure, including task-runtime child waits. These diagnostics do not imply an upstream fix was adopted.

## Dispatch and cancellation

A tool's durable Pi task identity maps to one job and immutable argument digest. Child creation and its document reference share one `api.commit`. Human approval precedes target reservation and lease acquisition; executor consent remains independent. Before dispatch, the application retains the exact execution, reservation, lease, generation and fence.

After a dispatch attempt, recovery queries the existing execution. Absence or a lost response does not authorize another start. Prepared results remain pending until staging and the authoritative receipt, or verified unchanged-base evidence, have been checked. A lost commit response requires recovery of the matching retained authority fact and exact receipt. It cannot promote a different job, base, target or stale lease.

An actual pending native consent observation carries its exact execution identity and approval operation. The Agent projects it onto the existing local-policy wait only while the same durable version remains eligible. A current-incarnation allowed assignment still materializing its snapshot reports preparing; the Agent clears the wait to dispatch_attempted/task-running without asserting that a process started. A delayed response cannot regress running, prepared-result, terminal or newer-version state. Unknown remains reconciliation. The five executor-only assigned-job snapshot/upload routes forward to ControlPlane; application workspace reads retain their original audience and grants.

Lease renewal preserves the original assignment, digests and fence. Successful authoritative renewal responses are retained by exact version and expiry; queries project the latest observation. Results may reference only the original lease or an exactly retained renewal. An unknown version or altered expiry, fence, generation, target or digest fails validation. Historical observations do not authorize a new commit: Workspace still checks its current authority and revision CAS.

Changed native commits require the complete bounded manifest and its canonical hash correlated with the actual prepared result, operation, execution, base, preparation and intent. A known retained receipt is recovered before any fresh observation. The existing native receipt call returns a persisted TransportAck bound to the commit ID and observation sequence; it precedes Agent finalization and the executor terminal notification.

Completed job state, terminal evidence and the exact terminal event sequence are committed before the private Agent terminal-proof response. ControlPlane verifies the Agent and Workspace authorities before forwarding the executor notification. Only the reviewed outbound notification paths may let ControlPlane derive a current connection epoch; provided epochs and ingress remain strict. Deferred attempts cannot silently rebind to another connection.

The private Agent proof checks the full current local grant, including the actual tool, before reading proof and after awaiting the exact committed event. It adds no recursive ControlPlane authorization call. Public requests cannot select the private proof path.

Cancellation records intent before aborting Pi or asking a backend to stop. Possible external effects remain visible. Lease release and capacity settlement have persisted repair records; failed notification delivery does not erase them. Settlement preserves the original reservation registration and actor context. Unknown byte usage retains the full recorded reservation and releases its admission slot without reporting measured bytes. Current per-operation metadata estimates do not bound total Pi/application SQLite storage across the installation; that accounting gate remains open.

Reconciliation retains a separate durable intent and deduplicated `job.reconciled` event while preserving the original terminal disposition and consumed Pi outcome. Accept-result verifies the actual retained Workspace receipt; staging-discarded requires actual successful abort of an unattempted retained upload. Uncertain native effects remain unsupported and quarantined. A fresh-job authorizationId is a caller-chosen business key, grants nothing and binds server-side to one current covering grant, the old version and a fresh operation. Omitted newJobId is allocated durably before asynchronous work. One public Harness.commit creates the existing dispatch child and its document reference. Matching crash retries recover the same child; changed base, authority or payload cannot silently retarget it. Started cancellation and upload-abort lost acknowledgments remain qualification gaps.

The wrapper remains `replay: unsafe` in the current source. Disposable candidate-safe builds have proved child-reference recovery and detected duplicate children when atomic attachment is deliberately split. Real executor process, receipt and fencing proofs are still required before enabling safe replay in the product.

## Authority and models

Resource calls require a current registered authority, exact scope and local revocation floors. Owner checks repeat after external awaits. A stream ticket is atomically consumed and registered by ControlPlane; the Agent receives canonical `X-Fortipi-Context` and `X-Fortipi-Socket` headers on a query-free internal request. Each command intersects the ticket scope with current grants. Hibernating attachments contain bounded IDs, generations and cursors; full nonsecret registered authority remains in application storage. Original authentication time and credential expiry are preserved.

The Agent reads its full persisted model selection after readiness through the private ControlPlane fetch. It validates the existing ModelConfig schema and configures the actual Pi session. Startup reads only local persisted selection and installs supported provider factories. The ControlPlane remains the OAuth refresh and credential persistence authority. Provider credentials are excluded from application events and exports.

## Infrastructure pressure and qualification

Free defaults and explicit paid capabilities come from InfrastructurePolicy. New work reserves capacity before effects. Actual Free tests cover ordinary non-admin scoped admission and settlement, conversation completion after ingress pressure, and the initial six-request journey. One actual active native job retains query, renewal, lease-update delivery, facts, result delivery, receipt and terminal closure while the principal ingress meter is full. That case does not establish cloud/paid completion or full platform fit.

Storage uses conservative operational admission watermarks, actual public databaseSize observations and pending-growth reservations. The private sampling contract does not turn cumulative object totals into per-job measurements or claim account-wide remaining capacity. Missing/stale samples retain unknown holds and stop new growth. Agent samples precede new capacity reservations at shared queued barriers. Lost replies retain the observation identity and timestamp; only matching completed CP-consumed claims preceding that barrier can be covered. Samples use ordinary admission, so request pressure can delay new growth without consuming retained-business repair headroom. The actual100KiB answer case now records the measured Agent total in CP while keeping the allocation floor estimated. Aggregate prospective growth, fork/export bounds and maximum admitted completion qualification remain open. The rejected raw outer transaction erased acknowledged competing app/Lifecycle writes and is retained only as test counterevidence.

Every Agent registry uses the same actor controller for bounded encoded provider output, event work, queued bytes and concurrent provider lanes. Cancellation cannot free an uncooperative provider's lane without public result closure. A run's four-tool-round limit uses supported Pi configuration and survives reopen. These controls bound infrastructure work rather than provider usage; small progress chunks can reach work pressure before an otherwise valid final answer size.

Actual local process recovery establishes survival of a committed canary, allocation provenance and one accepted Pi input across abrupt death. The sensitivity command builds disposable outputs, removes stable admission identity or splits child-reference persistence, and requires actual duplicate inputs or children. It does not count a compiler failure or timeout as detection.

Release qualification still requires every public operation, aggregate export/backup bytes, native changed manifests, actual executor process recovery, live provider answers and deployed client interoperability. Local faux-model, SQLite, Inspector and bundle-size results are limited to the behaviors they execute.
