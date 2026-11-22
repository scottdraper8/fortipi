import { DurableObject } from "cloudflare:workers";
import { Workspace } from "@cloudflare/computer";
import { codemode } from "../../src/backends/codemode.js";
import type { Env } from "../../src/boundary/env.js";

export { WorkspaceProxy } from "@cloudflare/computer";

interface RangeEnv extends Env {
  RANGES: DurableObjectNamespace<ComputerRangesProbe>;
}

const reads = `
import { open, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
export default async function () {
  const file = await open("./data.bin");
  const size = (await file.stat()).size;
  const guarded = new Uint8Array(16).fill(165);
  const range = await file.read(guarded, 3, 9, 524283);
  const tail = new Uint8Array(8).fill(165);
  const short = await file.read(tail, 0, 8, size - 3);
  const eof = await file.read(new Uint8Array(1), 0, 1, size + 11);
  const empty = await open("empty.bin");
  const emptyRead = await empty.read(new Uint8Array(1));
  await empty.close();
  let wholeFileError = "";
  try { await readFile("data.bin"); } catch (error) { wholeFileError = error.message; }
  const window = [];
  for await (const chunk of createReadStream("/workspace/data.bin", {
    start: 65533, end: 65541, highWaterMark: 3,
  })) window.push(...chunk);

  const reusable = await open("data.bin");
  const reader = reusable.createReadStream({ highWaterMark: 19, autoClose: false }).getReader();
  const first = await reader.read();
  await reader.cancel();
  const cancelledDone = (await reader.read()).done;
  reader.releaseLock();
  const continuation = new Uint8Array(3);
  const continued = await reusable.read(continuation);
  await reusable.close();

  const closing = file.createReadStream({ highWaterMark: 11 }).getReader();
  await closing.read();
  await closing.cancel();
  closing.releaseLock();
  let closedCode = "";
  try { await file.read(new Uint8Array(1)); } catch (error) { closedCode = error.code; }
  await file.close();
  return {
    size, guarded: Array.from(guarded), rangeBytes: range.bytesRead,
    tail: Array.from(tail), tailBytes: short.bytesRead, eofBytes: eof.bytesRead,
    emptyBytes: emptyRead.bytesRead, wholeFileError, window,
    first: Array.from(first.value), cancelledDone,
    continuation: Array.from(continuation), continuedBytes: continued.bytesRead, closedCode,
  };
}`;

const roots = `
import { open } from "node:fs/promises";
import { createReadStream } from "node:fs";
export default async function () {
  const results = [];
  for (const path of ["/outside.bin", "../outside.bin", "/workspace/../outside.bin", "escape"]) {
    let opened = "", streamed = "", file, reader;
    try {
      file = await open(path);
      await file.read(new Uint8Array(1));
    } catch (error) { opened = error.message; }
    finally { await file?.close(); }
    try {
      reader = createReadStream(path, { highWaterMark: 1 }).getReader();
      await reader.read();
    } catch (error) { streamed = error.message; }
    finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    results.push({ path, opened, streamed });
  }
  return results;
}`;

const bulk = `
import { open } from "node:fs/promises";
export default async function () {
  const file = await open("data.bin");
  const buffer = new Uint8Array(130048);
  const counts = [], hashes = [];
  let message = "";
  try {
    for (let index = 0; index < 2; index++) {
      counts.push((await file.read(buffer, 0, buffer.length, 65520)).bytesRead);
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer));
      hashes.push(Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""));
    }
    try { await file.read(new Uint8Array(1), 0, 1, 0); }
    catch (error) { message = error.message; }
  } finally { await file.close(); }
  return { counts, hashes, message };
}`;

function budgetSource(eof: boolean): string {
  return `
import { open } from "node:fs/promises";
export default async function () {
  const file = await open("data.bin");
  const position = ${eof ? "(await file.stat()).size + 1" : "0"};
  const buffer = new Uint8Array(1).fill(165);
  let reads = 0, received = 0, sum = 0, message = "";
  try {
    for (; reads < 129; reads++) {
      const { bytesRead } = await file.read(buffer, 0, 1, position);
      received += bytesRead;
      if (bytesRead) sum += buffer[0];
    }
  } catch (error) { message = error.message; }
  finally { await file.close(); }
  return { reads, received, sum, lastByte: buffer[0], message };
}`;
}

const sources: Record<string, string> = {
  reads,
  roots,
  bulk,
  tiny: budgetSource(false),
  eof: budgetSource(true),
};

/** Real SQLite + Loader, using the production adapter without replacing any backend option. */
export class ComputerRangesProbe extends DurableObject<RangeEnv> {
  override async fetch(request: Request): Promise<Response> {
    const scenario = new URL(request.url).pathname.slice(1);
    const source = sources[scenario];
    if (request.method !== "POST" || !request.body || !source)
      return new Response(null, { status: 400 });
    const config = this.env.FORTIPI_CONFIG;
    if (!("execution" in config) || config.execution.kind !== "cloud-js")
      throw new Error("Range fixture requires configured cloud-js");
    const workspace = new Workspace({
      storage: this.ctx.storage,
      backends: [codemode(this.env, "range-test", config.execution)],
    });
    try {
      await workspace.fs.mkdir("/workspace", { recursive: true });
      // Only the Node caller generates these bytes; the worker never recreates its oracle.
      await workspace.fs.writeFile("/workspace/data.bin", request.body);
      await workspace.fs.writeFile("/workspace/empty.bin", "");
      await workspace.fs.writeFile("/outside.bin", "existing-outside-canary");
      await workspace.fs.symlink("/outside.bin", "/workspace/escape");
      const handle = await workspace.runtime.exec(source, {
        id: scenario,
        backend: config.execution.backendId,
        cwd: "/workspace",
        encoding: "utf8",
        onInterrupt: "fail",
        sync: "wait",
      });
      return Response.json({
        result: await handle.result(),
        outside: await workspace.fs.readFile("/outside.bin", "utf8"),
        escapeIsLink: (await workspace.fs.lstat("/workspace/escape")).isSymbolicLink,
      });
    } finally {
      await workspace.close();
    }
  }
}

export default {
  fetch(request: Request, env: RangeEnv) {
    return env.RANGES.getByName(new URL(request.url).pathname).fetch(request);
  },
};
