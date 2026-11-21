# Independent Python public-wire example

This is a Python 3.15.2 standard-library client for public FortiPi protocol 1.0 /
schema 1.0.0. It uses no Node/browser SDK, private Pi API, pip package or service
implementation. Peer checks exercise interoperability mechanics; they do not prove
compatibility with a deployed service, provider, image or release candidate.

`Client(endpoint, token, timeout=30)` takes only the caller's application credential.
HTTP discovery/spec requests carry no credential. Authenticated requests stay on
the selected origin; redirects are rejected. HTTPS uses the system trust store
and verifies the hostname. Plain HTTP needs `allow_loopback_http=True` and exactly
localhost, 127.0.0.1 or ::1. There is no insecure TLS option.

Import `Client`, `Subscription`, `Checkpoint` and `WireError` from `client.py`.
Importing does not read credentials, open a connection or run the CLI. Call
`discover()` to obtain the actual protocol DTO and load the advertised public
schemas plus OpenAPI into memory. `client.openapi` and `client.schemas.documents`
expose those actual documents. The bounded validator supports the keyword subset
used by the fifteen current public schemas; it is not a general JSON Schema SDK.

Module methods return the actual DTOs:

| Method | Public operation |
| --- | --- |
| `agents(**query)` | listAgents |
| `create_agent(request_id, name, model)` | createAgent; canonically admin-audience |
| `conversations(agent_id, **query)` | listConversations |
| `create(agent_id, request_id, title=None)` | createConversation; omitted title stays omitted |
| `snapshot(conversation_id)` | getConversation; also reopens its consistent projection |
| `send(conversation_id, client_request_id, content, expected_revision=None)` | submitMessage |
| `replay(conversation_id, after, through=None)` | replayEvents; returns a page without applying a cursor |

There is no automatic mutation retry. Reuse the original request ID and identical
input explicitly after reconciling an uncertain reply. Client-role flows select
an already provisioned agent: agent creation can be denied by its canonical
admin-audience contract. Do not give this example an administrator credential to
work around missing client grants. The trusted parent provisions resources and
sufficient explicit client grants separately.

`Subscription(client, agent_id, conversation_id, on_snapshot=..., on_event=...,
checkpoint=None)` obtains a fresh native one-use ticket, applies a snapshot or
checks the previous identity scope, catches up bounded HTTP replay and subscribes
over [RFC6455](https://www.rfc-editor.org/rfc/rfc6455). `next()` returns a validated event or `None` on close/boundary EOF.
Unknown valid durable/volatile types remain generic DTOs. Malformed known types
cannot use the future-event fallback. `wait_completion(task_id)` requires the
actual durable task.completed DTO; an admission receipt or volatile delta is not
completion. UTF8, accept verification, fresh client masking, fragmented-message
bounds, ping/pong, close codes and truncated frames are checked.

The cursor advances only after `on_event` returns successfully for the next
contiguous durable event. Volatile events never move it. Keep `subscription.checkpoint`
together with your already applied projection; callbacks must atomically persist
application state and its cursor if durable restart is required. This example's
checkpoint is in memory, not a durable projection database. Close the subscription,
let another client act, then pass that checkpoint to a new subscription. Changed
origin/conversation/deployment/principal/credential scope refuses resume. Recent
duplicate proofs are bounded; an older unproven duplicate requires resynchronization.

Each message/frame is bounded by validated public protocol limits; replay is at
most 64 pages per catch-up and JSON nesting at most 128. The synchronous interface
has one reader, no background reconnect or automatic side-effect replay. HTTP and
socket operations have finite deadlines (DNS resolution remains OS-managed).
`Client.cancel()` interrupts HTTP and is checked at socket reads within 250ms;
KeyboardInterrupt exits130. Always close subscriptions in finally. An EOF before
completion is reported as missing completion, never success.

For a future trusted TypeScript runner or a user, the CLI accepts JSON lines:

```sh
python3 -I -B examples/python-client/client.py --endpoint https://your-worker.example
```

The parent must supply **only this client's token** in inherited
`FORTIPI_CLIENT_TOKEN`, with a fresh allowlisted child environment. There are no
token argv options, default auth-file searches, request/ticket/body logs or provider,
Cloudflare/npm credential ports. Do not put tokens in shell history. Use
`--allow-loopback-http` only for an explicit local peer/runtime.

| Input `op` | Additional non-secret fields / output metadata |
| --- | --- |
| `discover` | protocol/schema versions, schema count |
| `agents`, `conversations` | optional `query`; conversations needs `agentId`; IDs/page token |
| `create` | `agentId`, stable `requestId`, optional `title`; created IDs |
| `create-agent` | privileged canonical route; `requestId`, `name`, `model`; no admin fallback |
| `snapshot` | `conversationId`; cursor/message count, no message text |
| `send` | `conversationId`, `clientRequestId`, `content`, optional `expectedRevision`; admission DTO |
| `subscribe` | `agentId`, `conversationId`, optional `resume:true`; applied cursor/replay count |
| `next`, `completion` | completion needs `taskId`; event type/durability/cursor, no payload |
| `disconnect` | retain the in-memory applied checkpoint |
| `replay` | while disconnected: page counts and `applied:false`; does not advance cursor |
| `close` | close the process; stdin EOF also cleans up |

Errors produce one redacted `{ok:false,error:CODE}` line and nonzero exit. Output
never includes a bearer, ticket, URL, request body or event payload. The CLI is a
small public-flow adapter, not a test oracle or full chat UI.

Run the independent TypeScript peer checks after normal frozen installs and public
contract emits:

```sh
node --test tests/clients/python-wire.test.ts
```

Those checks launch actual isolated Python processes with synthetic role keys,
handwritten RFC/request expectations and the actual generated public documents.
Full thread10 must repeat the flow against the real service/release revision.
The current root test selector does not include tests/clients: the parent must
integrate this explicit command into its foundation/CI handoff.
