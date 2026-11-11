import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ExecutionIdentity, ExecutorFrame, PreparedResult } from "fortipi-contract/executor";
import { canonicalJson } from "fortipi-contract/executor";
import type { Limits } from "./config.js";
import { privateWrite, secureDirectory } from "./config.js";
import type { Ledger } from "./ledger.js";
import { hash } from "./policy.js";
import { inventoryFor } from "./workspace/manifest.js";

export class Output {
  ledger: Ledger;
  identity: ExecutionIdentity;
  limits: Limits;
  frameBytes: number;
  decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
  constructor(ledger: Ledger, identity: ExecutionIdentity, limits: Limits, frameBytes = 16384) {
    this.ledger = ledger;
    this.identity = identity;
    this.limits = limits;
    this.frameBytes = frameBytes;
  }
  append(stream: "stdout" | "stderr", data: Uint8Array): void {
    this.text(stream, this.decoders[stream].write(Buffer.from(data)));
  }
  finish(): void {
    this.text("stdout", this.decoders.stdout.end());
    this.text("stderr", this.decoders.stderr.end());
  }
  private text(stream: "stdout" | "stderr", text: string): void {
    const row = this.ledger.existing(this.identity);
    if (!row) throw new Error("output missing execution ledger");
    const overhead = Buffer.byteLength(
      canonicalJson({
        type: "job.output",
        requestId: "0".repeat(36),
        payload: {
          identity: row.assignment.identity,
          sequence: Number.MAX_SAFE_INTEGER,
          stream,
          text: "",
        },
      }),
    );
    const maximum = this.frameBytes - overhead;
    if (maximum < 6) {
      row.truncated = true;
      this.ledger.put(row);
      return;
    }
    let chunk = "",
      encoded = 0,
      bytes = 0;
    const emit = () => {
      if (!chunk) return;
      this.ledger.transaction(() => {
        const latest = this.ledger.existing(this.identity);
        if (!latest) throw new Error("output ledger lost");
        if (latest.outputBytes + bytes > this.limits.outputBytesPerJob) {
          latest.truncated = true;
          this.ledger.put(latest);
          return;
        }
        latest.sequence++;
        if (!Number.isSafeInteger(latest.sequence)) throw new Error("sequence exhausted");
        const value: ExecutorFrame = {
          type: "job.output",
          requestId: randomUUID(),
          payload: {
            identity: latest.assignment.identity,
            sequence: latest.sequence,
            stream,
            text: chunk,
          },
        };
        // Tiny writes still store a full identity/envelope plus SQLite indexes. Count those
        // bytes before writing, retaining the same completion/repair reserve as admission.
        this.ledger.capacity(Buffer.byteLength(canonicalJson(value)) * 2 + 8192, true);
        latest.outputBytes += bytes;
        this.ledger.enqueue(this.identity.jobId, "output", latest.sequence, value);
        this.ledger.put(latest);
      });
    };
    // Code points prevent UTF-8 splits; JSON escapes can expand, so cap actual encoded frame text too.
    for (const point of text) {
      const n = Buffer.byteLength(canonicalJson(point)) - 2;
      if (
        encoded + n > maximum ||
        bytes + Buffer.byteLength(point) > this.limits.outputBytesPerJob - row.outputBytes
      ) {
        emit();
        chunk = "";
        bytes = 0;
        encoded = 0;
      }
      chunk += point;
      encoded += n;
      bytes += Buffer.byteLength(point);
    }
    emit();
  }
  async result(
    state: PreparedResult["state"],
    directory: string,
    possibleExternalEffects: boolean,
  ): Promise<PreparedResult> {
    const row = this.ledger.existing(this.identity);
    if (!row) throw new Error("result missing execution ledger");
    if (row.result) return row.result;
    await secureDirectory(directory);
    const artifacts: PreparedResult["output"]["artifacts"] = [];
    let tail = "";
    for (const stream of ["stdout", "stderr"] as const) {
      const pages = this.ledger.db
        .prepare("SELECT data FROM outbox WHERE job=? AND kind='output' ORDER BY sequence")
        .iterate(this.identity.jobId);
      const pieces: Buffer[] = [];
      let bytes = 0;
      for (const value of pages) {
        const f = JSON.parse(value.data as string) as Extract<
          ExecutorFrame,
          { type: "job.output" }
        >;
        if (f.payload.stream !== stream) continue;
        const chunk = Buffer.from(f.payload.text);
        const tailBytes = Buffer.from(tail + f.payload.text);
        let start = Math.max(0, tailBytes.length - this.limits.inlineTailBytes);
        while (start < tailBytes.length && ((tailBytes[start] as number) & 0xc0) === 0x80) start++;
        tail = tailBytes.subarray(start).toString("utf8");
        if (bytes < this.limits.artifactBytes) {
          const part = chunk.subarray(0, this.limits.artifactBytes - bytes);
          pieces.push(part);
          bytes += part.length;
        }
      }
      if (bytes) {
        const artifactId = randomUUID(),
          data = Buffer.concat(pieces, bytes);
        await privateWrite(join(directory, artifactId), data, undefined, true);
        const reference: PreparedResult["output"]["artifacts"][number] = {
          workspaceId: row.assignment.workspaceId,
          revision: this.identity.baseRevision,
          sha256: hash(data),
          size: bytes,
          chunks: inventoryFor(data, this.limits.chunkBytes),
          artifactId,
          endpoint: `/v1/workspaces/${row.assignment.workspaceId}/artifacts/${artifactId}?revision=${encodeURIComponent(this.identity.baseRevision)}`,
          owner: { kind: "local", executorId: this.identity.lease.executorId },
        };
        artifacts.push(reference);
      }
    }
    const result: PreparedResult = {
      identity: row.assignment.identity,
      sequence: row.sequence + 1,
      state,
      output: {
        tail,
        artifacts,
        truncated: row.truncated || row.outputBytes > this.limits.artifactBytes,
      },
      possibleExternalEffects,
    };
    return result;
  }
}
