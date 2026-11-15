// Explicit Linux control; never an ordinary source-test filename.
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { once } from "node:events";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { beginNativeV8Profile, nativeV8Logs } from "./native-v8-profile.ts";

test("owned busy workerd writes native ticks before SIGKILL and decodes its known JS loop", {
  skip: process.platform !== "linux",
  timeout: 45000,
}, async () => {
  const from = createRequire(
    createRequire(new URL("../apps/worker/package.json", import.meta.url)).resolve("wrangler"),
  );
  const fromMf = createRequire(from.resolve("miniflare"));
  const binary = fromMf("workerd").default as string;
  const { Miniflare, Log, LogLevel } = from("miniflare") as {
    Miniflare: new (options: object) => { ready: Promise<URL>; dispose(): Promise<void> };
    Log: new (level: number) => object;
    LogLevel: { NONE: number };
  };
  const profile = await beginNativeV8Profile();
  const previousFlags = process.env.MINIFLARE_WORKERD_V8_FLAGS;
  process.env.MINIFLARE_WORKERD_V8_FLAGS = profile.flags;
  const children: { child: ChildProcess; closed: Promise<unknown> }[] = [];
  const capture = (value: unknown) => {
    const child = (value as { process?: unknown })?.process;
    if (child instanceof ChildProcess)
      child.once("spawn", () => {
        if (child.spawnfile === binary) children.push({ child, closed: once(child, "close") });
      });
  };
  // Same finite loop/control location as the independently verified Darwin proof.
  const source = `let release;export default {fetch(request,env,ctx){
const path=new URL(request.url).pathname;
if(path==='/release'){release();return new Response('released');}
if(path!=='/busy')return new Response('ready');
const gate=new Promise(resolve=>{release=resolve;});
return new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('entered\\n'));const timer=setTimeout(()=>c.error(new Error('gate deadline')),10000);ctx.waitUntil(gate.then(()=>{clearTimeout(timer);let value=1;for(let j=0;j<8;j++)for(let i=0;i<536870912;i++)value=(Math.imul(value^i,1664525)+1013904223)|0;c.enqueue(new TextEncoder().encode('done:'+value+'\\n'));c.close();}));}}),{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store'}});}};`;
  subscribe("child_process", capture);
  let mf: InstanceType<typeof Miniflare> | undefined;
  let completed = false;
  let completion: Promise<unknown> | undefined, release: Promise<unknown> | undefined;
  let beforeKillTicks = 0,
    afterKillTicks = 0,
    knownLoopSelfTicks = 0,
    passed = false;
  let stage = "startup";
  try {
    mf = new Miniflare({
      host: "127.0.0.1",
      port: 0,
      cf: false,
      enableDevRegistry: false,
      telemetry: { enabled: false },
      log: new Log(LogLevel.NONE),
      workers: [
        {
          config: {
            name: "fortipi-native-v8-control",
            compatibilityDate: "2026-11-10",
            compatibilityFlags: [
              "nodejs_compat",
              "enable_request_signal",
              "request_signal_passthrough",
            ],
            manifest: {
              mainModule: "worker.js",
              modulesRoot: "/",
              modules: { "worker.js": { type: "esm", contents: source } },
            },
          },
        },
      ],
    });
    const origin = await mf.ready;
    assert.equal(origin.hostname, "127.0.0.1");
    assert.equal(children.length, 1);
    const owned = children[0];
    assert.ok(owned?.child.pid);
    assert.equal(
      await (await fetch(origin, { signal: AbortSignal.timeout(3000) })).text(),
      "ready",
    );
    stage = "entered";
    const response = await fetch(new URL("/busy", origin), { signal: AbortSignal.timeout(15000) });
    assert.ok(response.body);
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "entered\n");
    completion = (async () => {
      try {
        while (!(await reader.read()).done) {}
        completed = true;
      } catch {
        /* Killed transport. */
      } finally {
        reader.releaseLock();
      }
    })();
    release = fetch(new URL("/release", origin), { signal: AbortSignal.timeout(15000) })
      .then((r) => r.text())
      .catch(() => null);
    await pause(1400);
    assert.equal(completed, false);
    stage = "before-kill";
    const before = await nativeV8Logs(profile.directory, owned.child.pid);
    beforeKillTicks = before.reduce((sum, log) => sum + log.ticks, 0);
    assert.ok(beforeKillTicks > 100, "Native ticks must exist while busy, before kill");
    assert.equal(owned.child.kill("SIGKILL"), true);
    await mf.dispose();
    await Promise.all(children.map((x) => x.closed));
    await Promise.all([completion, release]);
    assert.equal(completed, false);
    assert.equal(owned.child.signalCode, "SIGKILL");
    stage = "after-kill";
    const after = await nativeV8Logs(profile.directory, owned.child.pid);
    afterKillTicks = after.reduce((sum, log) => sum + log.ticks, 0);
    assert.ok(afterKillTicks >= beforeKillTicks);
    stage = "decode";
    const decoded = await profile.collect("control-after-kill", true);
    assert.ok(decoded.status === "available" || decoded.status === "partial");
    for (const log of decoded.selected)
      for (const frame of log.frames)
        if (frame.file === "worker.js" && frame.line === 6 && frame.column === 193)
          knownLoopSelfTicks += frame.selfTicks;
    assert.ok(knownLoopSelfTicks > 100);
    assert.ok(
      decoded.selected.some((log) =>
        log.frames.some(
          (frame) =>
            frame.file === "worker.js" &&
            frame.line === 6 &&
            frame.column === 193 &&
            frame.selfTicks > log.rawTicks / 2,
        ),
      ),
    );
    passed = true;
    stage = "complete";
  } catch {
    throw new Error("private-native-v8-control-failed");
  } finally {
    unsubscribe("child_process", capture);
    for (const { child } of children)
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await mf?.dispose().catch(() => {});
    await Promise.all(children.map((x) => x.closed));
    await Promise.allSettled([completion, release]);
    await rm(profile.directory, { recursive: true, force: true });
    if (previousFlags === undefined) delete process.env.MINIFLARE_WORKERD_V8_FLAGS;
    else process.env.MINIFLARE_WORKERD_V8_FLAGS = previousFlags;
    await mkdir(".agent-docs/tmp/native-v8-profile", { recursive: true, mode: 0o700 });
    await writeFile(
      ".agent-docs/tmp/native-v8-profile/control-proof.json",
      `${JSON.stringify({
        kind: "private-native-v8-control",
        passed,
        stage,
        beforeKillTicks,
        afterKillTicks,
        knownLoopSelfTicks,
        ownedChildren: children.length,
        closedChildren: children.filter(
          (x) => x.child.exitCode !== null || x.child.signalCode !== null,
        ).length,
      })}\n`,
      { mode: 0o600 },
    );
  }
});
