import { Workspace, type WorkspaceRegisteredBackend } from "@cloudflare/computer";
import type * as D from "../boundary/dto.js";
import { same } from "./authority.js";
import { requireThat } from "./errors.js";
import { checkedManifest, manifestDigest } from "./manifest.js";
import type { Mutex } from "./mutex.js";
import type { State } from "./state.js";
import { hashStream, limitedStream } from "./streams.js";

/** A disposable child only. Authority/local objects never instantiate this class. */
export class ComputerStore {
  private computer: Workspace | undefined;
  private readers = 0;
  private drain: (() => void)[] = [];
  runtimePinned = false;
  readonly state: State;
  readonly mutex: Mutex;
  readonly policy: D.InfrastructurePolicy;
  constructor(state: State, mutex: Mutex, policy: D.InfrastructurePolicy) {
    this.state = state;
    this.mutex = mutex;
    this.policy = policy;
  }
  workspace(backends: WorkspaceRegisteredBackend[] = []): Workspace {
    this.computer ??= new Workspace({
      storage: this.state.storage,
      backends,
      output: {
        maxLines: 256,
        maxBytes: this.policy.bounds.inlineTailBytes,
        dir: "/.fortipi/output",
        keep: 2,
      },
    });
    return this.computer;
  }
  current(): D.StoreState {
    const state = this.state.get<D.StoreState>("child");
    requireThat(state, "not_found", "Child is not initialized");
    return state;
  }
  writable(): D.StoreState {
    const state = this.current();
    requireThat(
      state.state === "writable" && !this.runtimePinned && Date.now() < state.allocation.deadline,
      "conflict",
      "Child is sealed, expired, active or retired",
    );
    requireThat(
      this.state.bytes <
        Math.min(
          state.allocation.reservedBytes,
          this.policy.bounds.objectBytes * (1 - this.policy.bounds.headroomFraction),
        ),
      "quota_exceeded",
      "Child physical storage bound reached",
    );
    return state;
  }
  async initialize(allocation: D.StoreAllocation): Promise<D.StoreState> {
    return this.mutex.run(async () => {
      const existing = this.state.get<D.StoreState>("child");
      if (existing) {
        requireThat(same(existing.allocation, allocation), "conflict", "Permanent role mismatch");
        requireThat(
          existing.state !== "retiring" && existing.state !== "deleted",
          "conflict",
          "Retired child",
        );
        return existing;
      }
      const state: D.StoreState = { allocation, state: "writable", source: "child", version: 1 };
      this.state.put("child", state);
      const ws = this.workspace();
      await ws.fs.mkdir("/.fortipi/blobs", { recursive: true });
      await ws.fs.mkdir("/.fortipi/staging", { recursive: true });
      await ws.fs.mkdir("/workspace", { recursive: true });
      return state;
    });
  }
  async writeChunk(index: number, bytes: Uint8Array, sha256: string): Promise<void> {
    await this.mutex.run(async () => {
      this.writable();
      const key = `chunk:${index}`;
      const existing = this.state.get<{ size: number; sha256: string }>(key);
      if (existing) {
        requireThat(
          existing.size === bytes.length && existing.sha256 === sha256,
          "conflict",
          "Chunk identity changed",
        );
        return;
      }
      const path = `/.fortipi/staging/chunk-${index}`;
      // A failed write has no completion marker and is never accepted on retry.
      await this.workspace().fs.writeFile(path, bytes, { exclusive: true, mode: 420 });
      requireThat(
        (await hashStream(
          await this.workspace().fs.readFile(path),
          bytes.length,
          Date.now() + 30_000,
        )) === sha256,
        "invalid_request",
        "Stored chunk mismatch",
      );
      this.state.put(key, { size: bytes.length, sha256 });
    });
  }
  async writeBlob(
    entry: Extract<D.ManifestEntry, { type: "file" }>,
    stream: ReadableStream<Uint8Array>,
  ): Promise<void> {
    await this.mutex.run(async () => {
      this.writable();
      const ws = this.workspace();
      const path = `/.fortipi/blobs/${entry.sha256}`;
      const complete = this.state.get<{ size: number }>(`blob:${entry.sha256}`);
      if (complete) {
        await stream.cancel();
        requireThat(
          complete.size === entry.size &&
            (await hashStream(await ws.fs.readFile(path), entry.size, Date.now() + 30_000)) ===
              entry.sha256,
          "conflict",
          "Existing blob is not complete",
        );
        return;
      }
      const temporary = `/.fortipi/staging/${crypto.randomUUID()}`;
      requireThat(
        this.state.bytes + entry.size * 2 + 65536 <= this.current().allocation.reservedBytes,
        "quota_exceeded",
        "Complete-copy reservation cannot cover this file",
      );
      await ws.fs.writeFile(temporary, limitedStream(stream, entry.size, Date.now() + 30_000), {
        exclusive: true,
        mode: entry.mode,
      });
      requireThat(
        (await hashStream(await ws.fs.readFile(temporary), entry.size, Date.now() + 30_000)) ===
          entry.sha256,
        "invalid_request",
        "Full file hash or length mismatch",
      );
      await ws.fs.writeFile(path, await ws.fs.readFile(temporary), {
        exclusive: true,
        mode: entry.mode,
      });
      this.state.put(`blob:${entry.sha256}`, { size: entry.size });
    });
  }
  async assemble(
    entry: Extract<D.ManifestEntry, { type: "file" }>,
    chunks: number[],
  ): Promise<void> {
    if (this.state.get<{ size: number }>(`blob:${entry.sha256}`)?.size === entry.size) return;
    // Read small complete chunks before entering writeBlob's FIFO. These are immutable staging files.
    const ws = this.workspace();
    for (const index of chunks)
      requireThat(this.state.get(`chunk:${index}`), "conflict", "Missing completed upload chunk");
    let current: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        for (;;) {
          if (!current) {
            const index = chunks[offset++];
            if (index === undefined) {
              controller.close();
              return;
            }
            current = (await ws.fs.readFile(`/.fortipi/staging/chunk-${index}`)).getReader();
          }
          const next = await current.read();
          if (!next.done) {
            controller.enqueue(next.value);
            return;
          }
          current.releaseLock();
          current = undefined;
        }
      },
      cancel: async () => {
        await current?.cancel();
        current?.releaseLock();
      },
    });
    await this.writeBlob(entry, stream);
  }
  async configure(backends: WorkspaceRegisteredBackend[]): Promise<Workspace> {
    return this.mutex.run(async () => {
      this.writable();
      await this.computer?.close();
      this.computer = undefined;
      return this.workspace(backends);
    });
  }
  async materialize(entry: D.ManifestEntry, stream?: ReadableStream<Uint8Array>): Promise<void> {
    await this.mutex.run(async () => {
      this.writable();
      const ws = this.workspace();
      const path = `/workspace/${entry.path}`;
      if (entry.type === "directory") {
        await ws.fs.mkdir(path, { recursive: true });
        return;
      }
      requireThat(stream, "invalid_request", "Missing materialization bytes");
      const parent = path.slice(0, path.lastIndexOf("/"));
      await ws.fs.mkdir(parent, { recursive: true });
      await ws.fs.writeFile(path, limitedStream(stream, entry.size, Date.now() + 30_000), {
        exclusive: true,
        mode: entry.mode,
      });
      requireThat(
        (await hashStream(await ws.fs.readFile(path), entry.size, Date.now() + 30_000)) ===
          entry.sha256,
        "invalid_request",
        "Scratch materialization hash mismatch",
      );
    });
  }
  async snapshot(): Promise<D.Manifest> {
    return this.mutex.run(async () => {
      requireThat(!this.runtimePinned, "conflict", "Runtime has not quiesced");
      const ws = this.workspace();
      const entries: D.ManifestEntry[] = [];
      const visit = async (directory: string): Promise<void> => {
        const children = await ws.fs.readdir(`/workspace${directory ? `/${directory}` : ""}`);
        requireThat(
          entries.length + children.length <= this.policy.bounds.manifestEntries,
          "quota_exceeded",
          "Scratch entry bound exceeded",
        );
        for (const child of children) {
          const path = directory ? `${directory}/${child.name}` : child.name;
          const stat = await ws.fs.lstat(`/workspace/${path}`);
          requireThat(
            !stat.isSymbolicLink && (stat.isFile || stat.isDirectory),
            "invalid_request",
            "Links and special files cannot be published",
          );
          if (stat.isDirectory) {
            entries.push({ path, type: "directory", mode: 493 });
            await visit(path);
          } else {
            requireThat(
              stat.size <= this.policy.bounds.fileBytes &&
                ((stat.mode & 0o7777) === 420 || (stat.mode & 0o7777) === 493),
              "invalid_request",
              "Invalid scratch mode or size",
            );
            const sha256 = await hashStream(
              await ws.fs.readFile(`/workspace/${path}`),
              stat.size,
              Date.now() + 30_000,
            );
            entries.push({
              path,
              type: "file",
              mode: (stat.mode & 0o7777) === 493 ? 493 : 420,
              size: stat.size,
              sha256,
            });
          }
        }
      };
      await visit("");
      return checkedManifest({ version: 1, entries }, this.policy);
    });
  }
  async artifact(path: string, offset: number, size: number): Promise<ReadableStream<Uint8Array>> {
    const saved = this.state.get<{
      result: {
        truncated?: {
          stdout?: { status: string; path?: string; totalBytes: number };
          stderr?: { status: string; path?: string; totalBytes: number };
        };
      };
    }>("scratch-result");
    const proof = [saved?.result.truncated?.stdout, saved?.result.truncated?.stderr].find(
      (entry) => entry?.status === "saved" && entry.path === path,
    );
    requireThat(
      proof &&
        path.startsWith("/.fortipi/output/") &&
        !path.split("/").includes("..") &&
        !this.runtimePinned &&
        offset >= 0 &&
        size >= 0 &&
        offset + size <= proof.totalBytes,
      "unauthorized",
      "Artifact membership or range mismatch",
    );
    const data = await this.mutex.run(async () => {
      const stat = await this.workspace().fs.lstat(path);
      requireThat(
        stat.isFile &&
          !stat.isSymbolicLink &&
          stat.size === proof.totalBytes &&
          this.readers < Math.min(4, this.policy.bounds.transferConcurrency),
        "conflict",
        "Artifact changed or stream bound reached",
      );
      const stream = await this.workspace().fs.readFile(path, {
        byteOffset: offset,
        byteLength: size,
      });
      this.readers++;
      return stream;
    });
    // Each pull enters the same FIFO as disposal and metadata. The authority pins this child.
    const reader = data.getReader();
    let done = false;
    const finish = async () => {
      if (!done) {
        done = true;
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        this.readers--;
        if (this.readers === 0) for (const resolve of this.drain.splice(0)) resolve();
      }
    };
    const timer = setTimeout(() => {
      void finish();
    }, 30_000);
    return new ReadableStream({
      pull: (controller) =>
        this.mutex.run(async () => {
          try {
            requireThat(!done, "interrupted", "Artifact read expired");
            const next = await reader.read();
            if (next.done) {
              clearTimeout(timer);
              await finish();
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            clearTimeout(timer);
            await finish();
            controller.error(error);
          }
        }),
      cancel: async () => {
        clearTimeout(timer);
        await this.mutex.run(finish);
      },
    });
  }
  async seal(input: D.StoreSeal, manifest: D.Manifest): Promise<D.SealedStore> {
    const checked = checkedManifest(manifest, this.policy);
    const hash = await manifestDigest(checked);
    return this.mutex.run(async () => {
      const prior = this.state.get<D.SealedStore>("seal");
      if (prior) {
        requireThat(
          prior.manifestHash === input.manifestHash && prior.uploadId === input.uploadId,
          "conflict",
          "Seal changed",
        );
        return prior;
      }
      const state = this.writable();
      requireThat(
        state.allocation.role === "revision-store" &&
          state.allocation.uploadId === input.uploadId &&
          state.version === input.expectedVersion &&
          hash === input.manifestHash,
        "conflict",
        "Seal identity mismatch",
      );
      const ws = this.workspace();
      for (const entry of checked.entries)
        if (entry.type === "file") {
          const stat = await ws.fs.lstat(`/.fortipi/blobs/${entry.sha256}`);
          requireThat(
            stat.isFile &&
              !stat.isSymbolicLink &&
              stat.size === entry.size &&
              (await hashStream(
                await ws.fs.readFile(`/.fortipi/blobs/${entry.sha256}`),
                entry.size,
                Date.now() + 30_000,
              )) === entry.sha256,
            "invalid_request",
            "Incomplete snapshot bytes",
          );
        }
      const seal: D.SealedStore = {
        allocationId: input.allocationId,
        childId: input.childId,
        authorityId: input.authorityId,
        workspaceId: input.workspaceId,
        uploadId: input.uploadId,
        manifestHash: hash,
        sealedAt: Date.now(),
        stageId: crypto.randomUUID(),
      };
      this.state.transaction(() => {
        this.state.put("manifest", checked);
        this.state.put("seal", seal);
        this.state.put("child", {
          ...state,
          state: "sealed",
          version: state.version + 1,
          manifestHash: hash,
          measuredBytes: this.state.bytes,
        });
      });
      return seal;
    });
  }
  async read(
    entry: Extract<D.ManifestEntry, { type: "file" }>,
    scratch = false,
  ): Promise<ReadableStream<Uint8Array>> {
    const reader = await this.mutex.run(async () => {
      const state = this.current();
      requireThat(
        (state.state === "sealed" || scratch) &&
          !this.runtimePinned &&
          state.state !== "retiring" &&
          state.state !== "deleted",
        "conflict",
        "Child is not readable",
      );
      const manifest = this.state.get<D.Manifest>("manifest");
      requireThat(
        scratch || manifest?.entries.some((item) => same(item, entry)),
        "unauthorized",
        "File is not in sealed manifest",
      );
      const path = scratch ? `/workspace/${entry.path}` : `/.fortipi/blobs/${entry.sha256}`;
      const stat = await this.workspace().fs.lstat(path);
      requireThat(
        stat.isFile && !stat.isSymbolicLink && stat.size === entry.size,
        "conflict",
        "Stored file changed",
      );
      requireThat(
        this.readers < Math.min(4, this.policy.bounds.transferConcurrency),
        "quota_exceeded",
        "Concurrent read bound reached",
      );
      this.readers++;
      return (await this.workspace().fs.readFile(path)).getReader();
    });
    let closed = false;
    const finish = async () => {
      if (closed) return;
      closed = true;
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      this.readers--;
      if (this.readers === 0) for (const resolve of this.drain.splice(0)) resolve();
    };
    const timer = setTimeout(() => {
      void finish();
    }, 30_000);
    return new ReadableStream({
      pull: (controller) =>
        this.mutex.run(async () => {
          try {
            requireThat(!closed, "interrupted", "Read expired");
            const next = await reader.read();
            if (next.done) {
              clearTimeout(timer);
              await finish();
              controller.close();
            } else controller.enqueue(next.value);
          } catch (error) {
            clearTimeout(timer);
            await finish();
            controller.error(error);
          }
        }),
      cancel: async () => {
        clearTimeout(timer);
        await this.mutex.run(finish);
      },
    });
  }
  async dispose(): Promise<void> {
    requireThat(!this.runtimePinned, "conflict", "Runtime has not quiesced");
    if (this.readers) await new Promise<void>((resolve) => this.drain.push(resolve));
    await this.mutex.run(async () => {
      await this.computer?.close();
      this.computer = undefined;
      await this.state.storage.deleteAll();
    });
  }
}
