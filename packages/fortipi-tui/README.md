# FortiPi TUI

An ordinary application client using the public SDK/contract and pinned Pi TUI.
Install the published TUI independently, then connect to an existing deployment.
The process holds application credentials only. Operator Cloudflare/GitHub/model
provider setup belongs to the CLI and server; a local executor is optional.

```sh
fortipi-tui --profile work --conversation conversation_id --no-animation
fortipi-tui --profile work --smoke
```

Node 26.13 or later is required. `--help` documents the installed-bin interface.
There are no token/secret arguments. The renderer uses static progress labels;
`--no-animation` preserves all controls and focus behavior.

Profiles live outside the checkout at:

- macOS: `~/Library/Application Support/FortiPi/profiles.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/fortipi/profiles.json`
- Windows: `%LOCALAPPDATA%/FortiPi/profiles.json`

Create a protected directory/profile file through operator tooling or an editor
that preserves restrictive permissions. Each credential file is independently
scoped to its normalized deployment origin:

```json
{
  "version": 1,
  "profiles": [
    {
      "name": "work",
      "endpoint": "https://agent.example",
      "credentialFile": "/absolute/protected/application.json"
    }
  ]
}
```

The referenced protected file has shape
`{ "version": 1, "endpoint": "https://agent.example", "role": "client", "token": "APPLICATION_CREDENTIAL" }`.
Optional profile fields: `agentId`, `conversationId`, `allowLoopbackHttp` (explicit
unencrypted loopback development only). Never put a deployment/operator/executor/
model-provider credential there. The TUI validates directory/file ownership and
0700/0600-style restrictions on POSIX, rejects links/hard links, bounds reads,
and checks the file opened is the one inspected. Windows uses protected ACLs with
only the current SID, SYSTEM and Administrators allowed. Unsafe files fail closed.
No application credential is passed to clipboard helpers or emitted in diagnostics.
The exported controller also accepts an application-owned SDK credential provider
for memory-only embedding; no ambient provider credential files are read.

Tab/Shift-Tab cycle composer, list and transcript. Arrows/Enter choose items,
Escape dismisses/stops search, and PageUp/PageDown page output. Ctrl-C and signals
restore terminal modes. Automatic URL opening is disabled. Remote terminal
controls/OSC links/bidi overrides are stripped. Copy uses the compiled pinned
clipboard helper in a separate process, killed after 500 ms; unavailable clipboard
support leaves selectable text and a visible fallback.

| Commands                                                                                       | Behavior                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/agents [search]`, `/conversations [search]`, `/more`                                         | Authorized paginated title/ID search, progress and cancellable continuation                                                               |
| `/new [title]`, `/open ID`, `/profiles`                                                        | Create, reopen and switch selections; stale requests are cancelled/ignored                                                                |
| ordinary text, `/steer text`, `/retry`, `/discard-intent`                                      | Send or explicit steer; retry retains the uncertain intent identity; busy keeps input                                                     |
| `/task [ID]`, `/cancel [ID]`, `/resume ID continuation`, `/tool ID`                            | Task/control receipts and expanded tool/target/trust context                                                                              |
| `/approvals [ID]`, `/approve`, `/reject`                                                       | Full agent/principal/arguments/digest/capabilities/target/trust/workspace/base/policy/grant/expiry context; refetch before exact decision |
| `/reconcile [jobID]`                                                                           | Full canonical job evidence, versions, effects and dispositions                                                                           |
| `/ack-unknown reason`, `/ack-failed reason`, `/discard-staging reason`                         | Explicit reconciliation, never automatic rerun                                                                                            |
| `/accept-result reason`, `/new-job newJobID authorizationID reason`                            | Require existing result/receipt, or a separate explicit new-job authorization                                                             |
| `/workspace ID`, `/diff workspaceID revision otherRevision`, `/read workspaceID revision path` | Provider/revision/availability, sync/conflict state, qualified diffs and bounded read preview                                             |
| `/transaction workspaceID JSON`, `/artifact ID [destination]`                                  | Authorized canonical revision transaction; verified artifact preview or new exclusive 0600 destination file                               |
| `/ids`, `/copy`, `/status`, `/help`                                                            | Selectable identities, bounded optional copy, infrastructure capabilities/limits and help                                                 |
| `/disconnect`, `/reconnect`, `/resnapshot`, `/quit`                                            | Retain applied projection for live reconnect, explicitly resnapshot, exit                                                                 |

Connection state remains independent of task state. Offline/reconnecting/stale
views do not claim task failure. Waiting distinguishes model, cloud tool, device,
human approval, local policy and reconciliation/conflict. Streamed output remains
uncommitted; a result pending commit is not a workspace success. Cancellation
acknowledges durable intent and reports possible external effects, without rollback.
Approval does not enable native host trust: the operator must explicitly choose/
configure the local executor and its policy. Sharing the TUI host grants no authority.
Storage pressure reports reclamation/configuration; finite rate limits back off
without ticket storms. Free/unknown optional cloud capabilities stay unavailable.
Provider reauthentication is an operator action, without requesting provider secrets
or introducing hourly/weekly/token model budgets.

The authenticated ticket supplies displayed principal/deployment and credential
generation/grantVersion; the TUI rejects operator/executor roles. Reconnect retains
the matching scope and applied projection, and authority changes resnapshot. A
process restart always snapshots. Reopen restores pending task/job/approval/tool/
artifact metadata by bounded public replay through that snapshot's fixed cursor,
without replaying its messages into the screen or advancing a different cursor.

`--smoke` has a 120-second overall deadline and uses the **same controller** as
keyboard actions. It negotiates, selects/creates, subscribes by ticket, sends,
requires committed assistant and terminal task completion, saves/disconnects its
cursor, runs a second ordinary client's activity to completion while disconnected,
then reconnects and compares ordered applied IDs against stored replay and final
snapshot. It inspects/cancels a smoke-owned already-terminal task and requires the
canonical disposition. Failure/missing grants/timeout exits nonzero. Output contains
only phases and IDs. Smoke creates real conversation activity; use a suitable agent.

The optional inherited `FORTIPI_TUI_OBSERVE_FD` (descriptor >=3) emits bounded
redacted view/focus/connection/cursor/applied-ID observations. It cannot issue
commands. Owner10/parent should independently install the actual tarball into an
empty consumer, run smoke against the persistent Worker and deployed endpoint,
then launch the binary in a real PTY: browse/select/create, type/send, switch focus,
disconnect/reconnect, and inspect an approval or reconciliation context/action.
Assert real screen cells, keyboard effects, public stored state and terminal cleanup;
passive observations are synchronization only. Repeat browser/default SDK and the
independent Python client against that same deployment.

Local tests use actual compiled public packages and Pi renderer. The smoke fixture
is an in-memory HTTP/WebSocket service using native fetch/WebSocket, with synthetic
credentials/answers and no durable backend/model loop. The terminal component
fixture records renderer output and is **not PTY evidence**. POSIX permission and
clipboard timeout checks run on real local files/processes. Windows ACL behavior,
installed packs, genuine Worker recovery, browser Origin enforcement and deployed/
PTY acceptance require the respective real environments. A fixture pass never
substitutes for those release gates.
