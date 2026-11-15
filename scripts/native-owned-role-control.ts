// Explicit control only: not part of the ordinary test-file inventory or processHarness.
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { processHarness } from "../apps/worker/test/agent/process-harness.ts";
import {
  observeOwnedRuntimeRoles,
  ownedProcStat,
  ownedSocketFacts,
  ownedSocketPid,
} from "./owned-runtime-roles.ts";

test("one verified front owner may bind IPv4 and IPv6 loopback without accepting foreign listeners", () => {
  const v4 = 'LISTEN 0 4096 127.0.0.1:12345 0.0.0.0:* users:(("private",pid=101,fd=12))\n';
  const v6 = 'LISTEN 0 4096 [::1]:12345 [::]:* users:(("private",pid=101,fd=13))\n';
  const targets = new Set([101, 102]);
  for (const text of [v4, v4 + v6, v6 + v4])
    assert.equal(ownedSocketPid(text, 12345, targets), 101);
  for (const text of [
    v6,
    v4 + v4,
    v4 + v6 + v4,
    v4 + v6.replace("pid=101", "pid=102"),
    v4 + v6.replace("pid=101", "pid=103"),
    v4 + v6.replace("[::1]", "[::]"),
    v4 + v6.replace("[::1]", "[::ffff:127.0.0.1]"),
    v4 + v6.replace(":12345", ":12346"),
    v4 + v6.replace("[::]:*", "0.0.0.0:*"),
    v4.replace("127.0.0.1", "0.0.0.0"),
  ])
    assert.throws(() => ownedSocketPid(text, 12345, targets));
  assert.throws(() => ownedSocketPid(v4 + v6, 12345, new Set([102])));
});

test("constructed ss facts distinguish failures and private forms without granting ownership", () => {
  const targets = new Set([101, 102]),
    owned = new Set([99, 101, 102]);
  const privateName = "synthetic-private-socket-canary";
  const row = (address: string, owners = `("${privateName}",pid=101,fd=12)`, prefix = "") =>
    `${prefix}LISTEN 0 4096 ${address}:12345 *:*${owners ? ` users:(${owners})` : ""}\n`;
  const facts = (text: string) =>
    ownedSocketFacts({ tool: "ok", closed: true, text }, 12345, targets, owned, "first");
  const base = {
    sample: "first",
    tool: "ok",
    closed: true,
    listeners: "one",
    layout: "plain",
    address: "ipv4-loopback",
    owner: "target",
    addressForms: ["ipv4-loopback"],
  };
  assert.deepEqual(facts(row("127.0.0.1")), base);
  for (const [text, change] of [
    [row("[::ffff:127.0.0.1]"), { address: "ipv6-mapped" }],
    [row("[::ffff:7f00:1]"), { address: "ipv6-mapped" }],
    [row("[::1]"), { address: "ipv6-loopback" }],
    [row("0.0.0.0"), { address: "other" }],
    [row("127.0.0.1", undefined, "tcp "), { layout: "netid" }],
    [row("127.0.0.1", `("${privateName}",pid=99,fd=12)`), { owner: "owned-other" }],
    [row("127.0.0.1", `("${privateName}",pid=103,fd=12)`), { owner: "foreign" }],
    [
      row("127.0.0.1", `("${privateName}",pid=101,fd=12),("${privateName}",pid=102,fd=13)`),
      { owner: "multiple" },
    ],
    [row("127.0.0.1", ""), { owner: "unreadable" }],
    [row("127.0.0.1") + row("127.0.0.1"), { listeners: "multiple" }],
    [
      row("127.0.0.1") + row("[::1]", undefined, "tcp "),
      { listeners: "multiple", layout: "mixed", address: "mixed" },
    ],
  ] as const) {
    const result = facts(text);
    const address = "address" in change ? change.address : base.address;
    const addressForms = address === "mixed" ? ["ipv4-loopback", "ipv6-loopback"] : [address];
    assert.deepEqual(result, { ...base, ...change, addressForms });
    assert.throws(
      () => ownedSocketPid(text, 12345, targets),
      "Classification must not relax the role gate",
    );
    assert.ok(!JSON.stringify(result).includes(privateName));
    assert.ok(!JSON.stringify(result).includes("12345"));
    assert.ok(!JSON.stringify(result).includes("101"));
  }
  assert.deepEqual(facts(""), {
    ...base,
    listeners: "none",
    layout: "none",
    address: "none",
    owner: "none",
    addressForms: [],
  });
  const unreadable = {
    ...base,
    listeners: "unreadable",
    layout: "unreadable",
    address: "unreadable",
    owner: "unreadable",
    addressForms: [],
  };
  for (const text of [privateName, "x".repeat(8193), row("127.0.0.1").replace(":12345", ":12346")])
    assert.deepEqual(facts(text), unreadable);
  for (const tool of ["timeout", "error", "output-limit", "cleanup-unconfirmed"] as const) {
    const closed = tool !== "cleanup-unconfirmed";
    assert.deepEqual(
      ownedSocketFacts({ tool, closed, text: row("127.0.0.1") }, 12345, targets, owned, "second"),
      { ...unreadable, sample: "second", tool, closed },
    );
  }
});

test("owned-role pure parsers reject ambiguity, foreign owners and out-of-bounds data", async () => {
  const fields = Array<string>(50).fill("0");
  fields[0] = "S";
  fields[1] = "99";
  fields[2] = fields[3] = "99";
  fields[11] = "7";
  fields[12] = "3";
  fields[19] = "500";
  const row = `101 (private ) name) ${fields.join(" ")}\n`;
  assert.deepEqual(ownedProcStat(row), {
    pid: 101,
    parent: 99,
    group: 99,
    session: 99,
    start: 500n,
    ticks: 10n,
    state: "S",
  });
  for (const invalid of [
    "",
    "x".repeat(4097),
    row.replace(" S ", " Z "),
    row.replace(" 7 ", " -7 "),
  ])
    assert.throws(() => ownedProcStat(invalid));
  const socket = 'LISTEN 0 4096 127.0.0.1:12345 0.0.0.0:* users:(("private-name",pid=101,fd=12))\n';
  assert.equal(ownedSocketPid(socket, 12345, new Set([101, 102])), 101);
  for (const invalid of [
    socket + socket,
    "x".repeat(8193),
    socket.replace("127.0.0.1", "0.0.0.0"),
    socket.replace("pid=101", "pid=103"),
    socket.replace("fd=12", 'fd=12),("other",pid=102,fd=13'),
  ])
    assert.throws(() => ownedSocketPid(invalid, 12345, new Set([101, 102])));
  assert.throws(() => ownedSocketPid(socket, 12346, new Set([101, 102])));
  assert.throws(() => ownedSocketPid(socket, 65536, new Set([101, 102])));
  let started = false;
  const unavailable = await observeOwnedRuntimeRoles(new ChildProcess(), 12345, "baseline", () => {
    started = true;
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.stage, process.platform === "linux" ? "owner" : "unsupported");
  assert.equal(unavailable.roles, null);
  assert.equal(started, false, "Unsupported/unowned targets must not start work");
});

test("owned private busy worker earns user-role CPU ticks only on Linux", {
  timeout: 45000,
  skip: process.platform !== "linux" && process.platform !== "darwin",
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "fortipi-owned-role-"));
  let owned: ChildProcess | undefined, closed: Promise<unknown> | undefined;
  let h: Awaited<ReturnType<typeof processHarness>> | undefined;
  let forced = false,
    cleanup = false;
  const capture = (message: unknown) => {
    const child = (message as { process?: unknown } | null)?.process;
    if (!(child instanceof ChildProcess)) return;
    child.once("spawn", () => {
      if (child.spawnfile !== process.execPath) return;
      assert.ok(owned === undefined, "Exactly one directly owned harness Node child");
      owned = child;
      closed = once(child, "close");
    });
  };
  const kill = () => {
    if (!owned?.pid) return;
    forced = true;
    try {
      process.kill(-owned.pid, "SIGKILL");
    } catch {
      owned.kill("SIGKILL");
    }
  };
  const guard = setTimeout(kill, 35000);
  guard.unref();
  const request = new AbortController();
  const requestTimer = setTimeout(() => request.abort(), 30000);
  subscribe("child_process", capture);
  try {
    const worker = fileURLToPath(
      new URL("../apps/worker/test/agent/runtime-worker.ts", import.meta.url),
    );
    const main = join(directory, "worker.ts");
    await writeFile(
      main,
      `export * from ${JSON.stringify(worker)};
import worker from ${JSON.stringify(worker)};
let release;
export default {fetch(request,env,ctx) {
  const path=new URL(request.url).pathname;
  if(path === '/__test/owned-role-release' && release) {release();return new Response('released');}
  if(path !== '/__test/owned-role-busy') return worker.fetch(request,env,ctx);
  const gate=new Promise(resolve=>{release=resolve;});
  const encoder=new TextEncoder();
  const body=new ReadableStream({start(controller) {
    controller.enqueue(encoder.encode('entered\\n'));
    const timer=setTimeout(()=>controller.error(new Error('control gate deadline')),5000);
    ctx.waitUntil(gate.then(()=>{
      clearTimeout(timer);
      let value=1;
      for(let i=0;i<536870912;i++)value=(Math.imul(value^i,1664525)+1013904223)|0;
      controller.enqueue(encoder.encode('done:'+value+'\\n'));controller.close();
    }));
  }});
  return new Response(body,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store'}});
}};
`,
      { flag: "wx", mode: 0o600 },
    );
    h = await processHarness(main);
    assert.ok(owned?.pid && closed);
    const origin = new URL(h.origin);
    assert.equal(origin.protocol, "http:");
    assert.equal(origin.hostname, "127.0.0.1");
    const port = Number(origin.port);
    const healthy = await fetch(`${h.origin}/__test/ping`, {
      signal: request.signal,
      redirect: "error",
    });
    assert.equal(healthy.status, 200);
    assert.ok((await healthy.text()) === "ready", "Fixed healthy worker response");
    const baseline = await observeOwnedRuntimeRoles(owned, port, "baseline");
    t.diagnostic(JSON.stringify(baseline));
    if (process.platform === "linux") assert.equal(baseline.status, "available");
    else assert.equal(baseline.stage, "unsupported");
    const response = await fetch(`${h.origin}/__test/owned-role-busy`, {
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
      redirect: "error",
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const entry = await reader.read();
    assert.equal(entry.done, false);
    assert.ok(
      Buffer.from(entry.value ?? []).toString() === "entered\n",
      "Actual streamed entry precedes sampling",
    );
    let released: Promise<boolean> | undefined;
    const release = () => {
      released = fetch(`${origin.origin}/__test/owned-role-release`, {
        signal: request.signal,
        redirect: "error",
      })
        .then(async (response) => response.status === 200 && (await response.text()) === "released")
        .catch(() => false);
    };
    if (process.platform !== "linux") release();
    const busy = await observeOwnedRuntimeRoles(owned, port, "busy", release);
    t.diagnostic(JSON.stringify(busy));
    if (process.platform === "linux") assert.equal(busy.status, "available");
    let witness = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      witness += Buffer.from(chunk.value).toString();
      assert.ok(witness.length <= 64);
    }
    assert.ok(witness === "done:-1073741823\n", "Witness of the fixed finite computation");
    assert.equal(await released, true, "Actual control release acknowledged");
    assert.ok(
      [baseline, busy].every((record) => Buffer.byteLength(`# ${JSON.stringify(record)}\n`) <= 512),
    );
    if (process.platform === "linux") {
      assert.equal(busy.status, "available");
      assert.ok(baseline.roles && busy.roles);
      const user = busy.roles.find((row) => row.role === "user"),
        proxy = busy.roles.find((row) => row.role === "proxy");
      const idle = baseline.roles.find((row) => row.role === "user");
      assert.ok(user && proxy && idle);
      assert.ok(
        user.ticks > 0 && user.ticks > proxy.ticks && user.ticks > idle.ticks,
        "User isolate CPU must increase beyond both proxy and healthy baseline",
      );
    } else assert.equal(busy.stage, "unsupported");
    assert.equal(forced, false);
  } finally {
    request.abort();
    clearTimeout(requestTimer);
    const forceClose = setTimeout(kill, 2000);
    try {
      await h?.close();
      await closed;
      if (owned?.pid) {
        for (let i = 0; i < 20; i++) {
          try {
            process.kill(-owned.pid, 0);
          } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, "ESRCH", "Owned group probe");
            cleanup = true;
            break;
          }
          if (i === 9) kill();
          await pause(50);
        }
        assert.ok(cleanup, "Owned process group must have no remaining members");
      }
      assert.equal(forced, false, "Finite healthy control must close without emergency kill");
    } finally {
      clearTimeout(forceClose);
      clearTimeout(guard);
      unsubscribe("child_process", capture);
      await rm(directory, { recursive: true, force: true });
      t.diagnostic(
        JSON.stringify({
          diagnostic: "owned-role-control",
          host: process.platform === "linux" ? "linux" : "unsupported",
          cleanup: cleanup ? "closed" : "unconfirmed",
          nativeFrames: "unproven",
        }),
      );
    }
  }
});
