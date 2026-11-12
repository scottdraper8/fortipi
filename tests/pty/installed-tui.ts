import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { FortiPiClient } from "../../packages/fortipi-client/dist/node.js";
import type {
  ConversationProjection,
  DurableEvent,
} from "../../packages/fortipi-contract/dist/index.js";
import { execute } from "../../scripts/prepare-release.ts";
import type { PublicRole } from "../clients/python.ts";
import type { Installed } from "../distribution/install.ts";
import { terminal } from "./terminal.ts";

async function until(read: () => Promise<boolean>, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await read()) return;
    await new Promise<void>((accept) => setTimeout(accept, 25));
  }
  throw new Error("Installed TUI public outcome did not commit before deadline");
}
/** Public normal-profile flow only; own protected temporary application role. */
export async function tuiProfile(installed: Installed, role: PublicRole) {
  const home = await realpath(await mkdtemp(resolve(tmpdir(), "fortipi-evidence-tui-")));
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      TERM: "xterm-256color",
      HOME: home,
      LOCALAPPDATA: resolve(home, "local"),
      ...(process.platform === "win32"
        ? {
            SystemRoot: process.env.SystemRoot,
            USERPROFILE: home,
            APPDATA: resolve(home, "roaming"),
          }
        : {}),
    };
    const name = `@${installed.candidate.scope}/fortipi-tui`;
    const entry = installed.resolveExport(name);
    const module = (await import(
      pathToFileURL(entry).href
    )) as typeof import("../../packages/fortipi-tui/dist/index.js");
    const executor = (await import(
      pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-executor`)).href
    )) as typeof import("../../packages/fortipi-executor/dist/index.js");
    const platform = executor.adapter();
    await platform.protect(home, true);
    await platform.verifyProtection(home, true);
    const discovery = await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {profilePath} from ${JSON.stringify(pathToFileURL(entry).href)}; console.log(profilePath());`,
      ],
      home,
      env,
      15000,
    );
    assert.ok(discovery.code === 0 && !discovery.timedOut);
    const profilePath = discovery.stdout.trim();
    assert.ok(
      isAbsolute(profilePath) && profilePath.startsWith(`${home}${sep}`),
      "Product profile must stay in the fresh isolated home",
    );
    const privateDirectory = resolve(home, "roles");
    await mkdir(privateDirectory, { mode: 0o700 });
    await platform.protect(privateDirectory, true);
    const credentialFile = resolve(privateDirectory, "client.json");
    const file = await open(credentialFile, "wx", 0o600);
    try {
      await platform.protect(credentialFile, false);
      await file.writeFile(
        JSON.stringify({ version: 1, endpoint: role.endpoint, role: "client", token: role.token }),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await platform.verifyProtection(credentialFile, false);
    assert.equal(await module.applicationCredential(credentialFile, role.endpoint), role.token);
    await module.saveProfiles(
      {
        version: 1,
        profiles: [
          {
            name: "evidence",
            endpoint: role.endpoint,
            credentialFile,
            agentId: role.agentId,
            conversationId: role.conversationId,
            allowLoopbackHttp: new URL(role.endpoint).protocol === "http:",
          },
        ],
      },
      profilePath,
    );
    const bin = installed.bins["fortipi-tui"];
    assert.ok(bin, "Actual installed TUI bin required");
    return {
      home,
      env,
      bin,
      profilePath,
      credentialFile,
      dispose: () => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }),
    };
  } catch (error) {
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    throw error;
  }
}
export async function smokeTui(installed: Installed, role: PublicRole) {
  const profile = await tuiProfile(installed, role);
  try {
    const result = await execute(
      process.execPath,
      [profile.bin, "--profile", "evidence", "--no-animation", "--smoke"],
      profile.home,
      profile.env,
      135000,
    );
    assert.ok(
      result.code === 0 && !result.timedOut,
      "Actual installed TUI controller smoke failed",
    );
    assert.ok(!result.stdout.includes(role.token));
    const phases = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { phase: string });
    assert.deepEqual(
      phases.map((p) => p.phase),
      ["discovery", "subscribed", "offline", "passed"],
    );
    return {
      installedTui: true,
      controllerSmoke: true,
      actualNativeFetchAndTickets: true,
      committedCompletionAndOfflineReplay: true,
      protectedEphemeralClientFile: true,
    };
  } finally {
    await profile.dispose();
  }
}
export interface TuiJob {
  jobId: string;
  approvalId: string;
  assertRejectedWithoutProcessStart(): Promise<void>;
}
export async function keyboardTui(
  installed: Installed,
  role: PublicRole,
  client: FortiPiClient,
  job: TuiJob,
) {
  const profile = await tuiProfile(installed, role);
  const pty = terminal(
    process.execPath,
    [profile.bin, "--profile", "evidence", "--no-animation"],
    profile.home,
    profile.env,
  );
  try {
    await pty.wait(
      (s) => s.includes("FortiPi") && s.includes("online") && s.includes("focus composer"),
    );
    // Resolve the seeded real job before requesting another model turn. This
    // respects the actual one-slot policy; it never changes admission limits.
    const shownApproval = await client.approvals.get(job.approvalId);
    pty.write(`/approvals ${job.approvalId}\r`);
    await pty.wait((s) => s.includes("approvals") && s.includes("focus transcript"));
    // The real product follows the end of long details. Read the actual current
    // cells while paging upward; an off-screen ID is not a terminal failure.
    let approvalCells = await pty.currentScreen();
    for (
      let page = 0;
      page < 12 && !approvalCells.replaceAll("\n", "").includes(job.approvalId);
      page++
    ) {
      const previous = await pty.currentScreen();
      pty.write("\u001b[5~");
      await pty.wait((s) => s !== previous);
      approvalCells += `\n${await pty.currentScreen()}`;
    }
    assert.ok(
      approvalCells.replaceAll("\n", "").includes(job.approvalId),
      "Current approval context must identify the actual public job",
    );
    assert.ok(
      approvalCells.includes(shownApproval.operation.operationDigest),
      "Full approval digest must be visible before a decision",
    );
    assert.ok(approvalCells.includes(shownApproval.operation.tool));
    pty.write("\t");
    await pty.wait((s) => s.includes("focus composer"));
    pty.write("/reject\r");
    await job.assertRejectedWithoutProcessStart();
    pty.write("/quit\r");
    await pty.exit();
    return {
      installedTui: true,
      actualPty: true,
      platform: process.platform,
      screenCells: true,
      realJobId: job.jobId,
      actualApprovalId: job.approvalId,
      fullPublicApprovalDigestVisible: true,
      keyboardRejectAndZeroStarts: true,
      protectedEphemeralClientFile: true,
    };
  } finally {
    await pty.dispose();
    await profile.dispose();
  }
}
/** Plain conversation model fixture is independent of the two-response seeded
 * tool fixture. Both use actual installed bins, keys and the public contract. */
export async function keyboardConversationTui(
  installed: Installed,
  role: PublicRole,
  client: FortiPiClient,
  authorizeCreated: (title: string) => Promise<PublicRole>,
) {
  const profile = await tuiProfile(installed, role);
  const pty = terminal(
    process.execPath,
    [profile.bin, "--profile", "evidence", "--no-animation"],
    profile.home,
    profile.env,
  );
  const events: DurableEvent[] = [];
  const observer = client.conversations.subscribe(role.conversationId, {
    agentId: role.agentId,
    maxReconnects: 0,
    onSnapshot() {},
    onEvent(event) {
      if (event.durability === "durable") events.push(event);
    },
  });
  let before: ConversationProjection | undefined;
  try {
    await observer.ready;
    await pty.wait(
      (s) => s.includes("FortiPi") && s.includes("online") && s.includes("focus composer"),
    );
    const title = "seed1010-pty-created";
    pty.write(`/new ${title}\r`);
    const createdRole = await authorizeCreated(title),
      createdConversationId = createdRole.conversationId;
    assert.equal(createdRole.endpoint, role.endpoint);
    assert.equal(createdRole.agentId, role.agentId);
    assert.notEqual(createdConversationId, role.conversationId);
    await pty.wait((s) => s.includes("unauthorized") && s.includes("focus composer"));
    // A new ID is outside the original exact grant. The trusted coordinator
    // publicly issues a role for that ID before any authorized reopen. Only the
    // minimal application token replaces this own protected ephemeral file.
    const token = createdRole.token;
    const sdk = (await import(
      pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-client/node`))
        .href
    )) as typeof import("../../packages/fortipi-client/dist/node.js");
    const newlyAuthorized = new sdk.FortiPiClient({
      endpoint: role.endpoint,
      credentials: async () => token,
      allowLoopbackHttp: new URL(role.endpoint).protocol === "http:",
    });
    assert.equal(
      (await newlyAuthorized.conversations.get(createdConversationId)).conversation.conversationId,
      createdConversationId,
    );
    const executor = (await import(
      pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-executor`)).href
    )) as typeof import("../../packages/fortipi-executor/dist/index.js");
    await executor.privateWrite(
      profile.credentialFile,
      JSON.stringify({ version: 1, endpoint: role.endpoint, role: "client", token }),
    );
    await executor.adapter().verifyProtection(profile.credentialFile, false);
    await pty.wait((s) => s.includes("focus composer"));
    // The HTTP client deliberately caches a still-valid role until401. Normal
    // profile selection creates a new client after the explicit role change.
    pty.write("/profiles\r");
    await pty.wait((s) => s.includes(" | profiles | focus list") && s.includes("evidence"));
    pty.write("\r");
    await pty.wait((s) => s.includes(" | agents | focus list"));
    pty.write("\t");
    await pty.wait((s) => s.includes("focus transcript"));
    pty.write("\t");
    await pty.wait((s) => s.includes("focus composer"));
    pty.write(`/open ${createdConversationId} ${role.agentId}\r`);
    try {
      await pty.wait((s) => s.includes("online") && s.includes(" | conversation | focus composer"));
    } catch {
      const screen = await pty.currentScreen();
      const shown = (await import(
        pathToFileURL(installed.resolveExport(`@${installed.candidate.scope}/fortipi-tui`)).href
      )) as typeof import("../../packages/fortipi-tui/dist/index.js");
      assert.fail(
        `Created-conversation reopen incomplete: ${JSON.stringify({
          protectedRoleReplaced:
            (await shown.applicationCredential(profile.credentialFile, role.endpoint)) === token,
          unauthorized: screen.includes("unauthorized"),
          invalidCredential: screen.includes("credential"),
          connectionOffline: screen.includes("offline"),
          composerFocused: screen.includes("focus composer"),
          connecting: screen.includes("connecting"),
          accessRemoved: screen.includes("access-removed"),
          conversationView: screen.includes(" | conversation |"),
          intentVisible: screen.includes("/open"),
        })}`,
      );
    }
    pty.write("/ids\r");
    await pty.wait((s) => s.replaceAll("\n", "").includes(createdConversationId!));
    pty.write("\t");
    await pty.wait((s) => s.includes("focus composer"));
    pty.write(`/open ${role.conversationId} ${role.agentId}\r`);
    await pty.wait((s) => s.includes(" | conversation | focus composer") && s.includes("online"));
    // Populate the actual list and select through arrow/Enter handling.
    const selected = await client.conversations.get(role.conversationId);
    assert.match(selected.conversation.title, /^[A-Za-z0-9 _-]{1,100}$/);
    pty.write(`/conversations ${selected.conversation.title}\r`);
    await pty.wait(
      (s) => s.includes("conversations") && s.includes("focus list") && s.includes("1 matches"),
    );
    pty.write("\u001b[B\u001b[A\r");
    await pty.wait((s) => s.includes(" | conversation | focus composer") && s.includes("online"));
    pty.write("\t");
    await pty.wait((s) => s.includes("focus list"));
    pty.write("\t");
    await pty.wait((s) => s.includes("focus transcript"));
    pty.write("\t");
    await pty.wait((s) => s.includes("focus composer"));
    pty.resize(88, 28);
    pty.resize(130, 40);
    before = await client.conversations.get(role.conversationId);
    const cursorBefore = before.lastEventSeq;
    pty.write("seed1010-pty-keys\r");
    try {
      await until(async () => {
        const projection = await client.conversations.get(role.conversationId);
        if (
          projection.messages.some(
            (message) => message.role === "user" && message.content === "seed1010-pty-keys",
          )
        )
          assert.ok(
            !["failed", "interrupted"].includes(projection.conversation.taskState.state),
            "The actual keyboard task failed before committed completion",
          );
        return events.some(
          (event) => event.eventSeq > cursorBefore && event.type === "task.completed",
        );
      });
    } catch {
      const projection = await client.conversations.get(role.conversationId),
        screen = await pty.currentScreen();
      assert.fail(
        `Keyboard completion unavailable: ${JSON.stringify({
          publicUserCommitted: projection.messages.some(
            (message) => message.role === "user" && message.content === "seed1010-pty-keys",
          ),
          publicTaskState: projection.conversation.taskState.state,
          composerFocused: screen.includes("focus composer"),
          intentStillVisible: screen.includes("seed1010-pty-keys"),
          online: screen.includes("online"),
          newEventTypes: events
            .filter((event) => event.eventSeq > cursorBefore)
            .map((event) => event.type),
        })}`,
      );
    }
    const after = await client.conversations.get(role.conversationId);
    assert.equal(
      after.messages.filter((m) => m.role === "user" && m.content === "seed1010-pty-keys").length,
      1,
    );
    const created = events.filter(
      (event) => event.eventSeq > cursorBefore && event.type === "task.completed",
    );
    assert.equal(created.length, 1);
    assert.ok(created[0]!.taskId);
    assert.equal((await client.tasks.get(created[0]!.taskId!)).status.state, "completed");
    await pty.wait((s) => s.includes("seed1010-pty-keys") && s.includes("assistant"));
    pty.write("/disconnect\r");
    await pty.wait((s) => s.includes("offline"));
    const cursor = after.lastEventSeq;
    const offline = await client.conversations.send(role.conversationId, {
      clientRequestId: crypto.randomUUID(),
      content: "seed1010-pty-offline",
      busyBehavior: "followUp",
    });
    await until(async () =>
      events.some((event) => event.type === "task.completed" && event.taskId === offline.taskId),
    );
    pty.write("/reconnect\r");
    await pty.wait((s) => s.includes("online") && s.includes("seed1010-pty-offline"));
    const restored = await client.conversations.get(role.conversationId);
    assert.ok(restored.lastEventSeq > cursor);
    assert.equal(
      restored.messages.filter((m) => m.role === "user" && m.content === "seed1010-pty-offline")
        .length,
      1,
    );
    const visible = await pty.currentScreen();
    const ownTasks = new Set([created[0]!.taskId, offline.taskId]);
    const ownFinalIds = new Set(
      events
        .filter(
          (event) =>
            event.type === "message.completed" && !!event.taskId && ownTasks.has(event.taskId),
        )
        .map((event) => (event.payload as { messageId: string }).messageId),
    );
    assert.equal(
      ownFinalIds.size,
      2,
      "Both actual keyboard/offline tasks require their own canonical assistant identities",
    );
    for (const message of restored.messages.filter(
      (message) => message.role === "assistant" && ownFinalIds.has(message.messageId),
    ))
      assert.equal(
        visible.split(message.messageId).length - 1,
        1,
        "Each final assistant identity must render once in the current screen",
      );
    const screenSha256 = await pty.screenDigest();
    pty.write("/quit\r");
    await pty.exit();
    return {
      installedTui: true,
      actualPty: true,
      platform: process.platform,
      screenCells: true,
      focusAndResize: true,
      keyboardCreatedConversationId: createdConversationId,
      ungrantedNewConversationDenied: true,
      exactCreatedConversationGrantIssued: true,
      keyboardProfileReloadAfterRoleChange: true,
      keyboardListSelection: true,
      actualTaskId: created[0]!.taskId,
      keyboardSendCommitted: true,
      noDuplicateFinalScreenIdentities: true,
      offlineTaskId: offline.taskId,
      offlineResume: true,
      screenSha256,
      protectedEphemeralClientFile: true,
    };
  } finally {
    observer.close();
    await observer.done.catch(() => {});
    await pty.dispose();
    await profile.dispose();
  }
}
