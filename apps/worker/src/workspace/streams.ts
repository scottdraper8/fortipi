import { createHash } from "node:crypto";
import { requireThat } from "./errors.js";

export const chunkBytes = 256 * 1024;
/** Preserve the runtime's known-length body through authorization/range transforms. */
export function fixedLengthStream(
  source: ReadableStream<Uint8Array>,
  length: number,
): ReadableStream<Uint8Array> {
  requireThat(
    Number.isSafeInteger(length) && length >= 0,
    "invalid_request",
    "Invalid stream length",
  );
  return source.pipeThrough(new FixedLengthStream(length));
}
export async function hashInventory(
  stream: ReadableStream<Uint8Array>,
  size: number,
  grid: number,
  deadline: number,
): Promise<{ sha256: string; chunks: { chunkBytes: number; chunkHashes: string[] } }> {
  requireThat(
    Number.isSafeInteger(grid) &&
      grid >= 1 &&
      grid <= chunkBytes &&
      size >= 0 &&
      Math.ceil(size / grid) <= 256,
    "invalid_request",
    "Incompatible range chunk inventory",
  );
  const reader = stream.getReader();
  const timer = setTimeout(
    () => {
      void reader.cancel();
    },
    Math.max(1, Math.min(30_000, deadline - Date.now())),
  );
  const whole = createHash("sha256");
  let chunk = createHash("sha256");
  const hashes: string[] = [];
  let offset = 0;
  let total = 0;
  try {
    for (;;) {
      requireThat(Date.now() < deadline, "interrupted", "Inventory deadline exceeded");
      const next = await reader.read();
      if (next.done) break;
      total += next.value.length;
      requireThat(total <= size, "invalid_request", "Inventory exceeds declared length");
      whole.update(next.value);
      for (let start = 0; start < next.value.length; ) {
        const length = Math.min(grid - offset, next.value.length - start);
        chunk.update(next.value.subarray(start, start + length));
        start += length;
        offset += length;
        if (offset === grid) {
          hashes.push(chunk.digest("hex"));
          chunk = createHash("sha256");
          offset = 0;
        }
      }
    }
    requireThat(total === size, "interrupted", "Inventory stream truncated");
    if (offset) hashes.push(chunk.digest("hex"));
    return { sha256: whole.digest("hex"), chunks: { chunkBytes: grid, chunkHashes: hashes } };
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function hashStream(
  stream: ReadableStream<Uint8Array>,
  size: number,
  deadline: number,
): Promise<string> {
  const reader = stream.getReader();
  const hash = createHash("sha256");
  const timer = setTimeout(
    () => {
      void reader.cancel();
    },
    Math.max(1, Math.min(30_000, deadline - Date.now())),
  );
  let length = 0;
  try {
    for (;;) {
      requireThat(Date.now() < deadline, "interrupted", "Byte stream deadline exceeded");
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      requireThat(length <= size, "payload_too_large", "Byte stream exceeds declared length");
      hash.update(value);
    }
    requireThat(length === size, "invalid_request", "Truncated byte stream");
    return hash.digest("hex");
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function limitedStream(
  source: ReadableStream<Uint8Array>,
  size: number,
  deadline: number,
  exactLength = true,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let seen = 0;
  let closed = false;
  const finish = async () => {
    if (!closed) {
      closed = true;
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  let fail: (error: Error) => void = () => {};
  const timer = setTimeout(
    () => {
      fail(new Error("Stream deadline exceeded"));
      void finish();
    },
    Math.max(1, Math.min(30_000, deadline - Date.now())),
  );
  return new ReadableStream({
    start(controller) {
      fail = (error) => controller.error(error);
    },
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          requireThat(!exactLength || seen === size, "invalid_request", "Truncated file stream");
          clearTimeout(timer);
          await finish();
          controller.close();
        } else {
          seen += next.value.length;
          requireThat(
            seen <= size && Date.now() < deadline,
            "payload_too_large",
            "File stream length or deadline exceeded",
          );
          controller.enqueue(next.value);
        }
      } catch (error) {
        clearTimeout(timer);
        await finish();
        controller.error(error);
      }
    },
    async cancel() {
      clearTimeout(timer);
      await finish();
    },
  });
}
export function sliceStream(
  source: ReadableStream<Uint8Array>,
  start: number,
  length: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let offset = 0;
  let remaining = length;
  return new ReadableStream({
    async pull(controller) {
      try {
        while (remaining > 0) {
          const next = await reader.read();
          requireThat(!next.done, "interrupted", "Truncated ranged stream");
          const skip = Math.max(0, start - offset);
          offset += next.value.length;
          if (skip >= next.value.length) continue;
          const bytes = next.value.subarray(skip, Math.min(next.value.length, skip + remaining));
          remaining -= bytes.length;
          controller.enqueue(bytes);
          return;
        }
        await reader.cancel();
        reader.releaseLock();
        controller.close();
      } catch (error) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel() {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    },
  });
}
export async function boundedBytes(
  stream: ReadableStream<Uint8Array>,
  size: number,
  sha256: string,
  deadline: number,
): Promise<Uint8Array> {
  requireThat(
    Number.isSafeInteger(size) && size >= 0 && size <= chunkBytes,
    "payload_too_large",
    "Invalid chunk length",
  );
  const result = new Uint8Array(size);
  const reader = stream.getReader();
  const timer = setTimeout(
    () => {
      void reader.cancel();
    },
    Math.max(1, Math.min(30_000, deadline - Date.now())),
  );
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      requireThat(
        Date.now() < deadline && length + next.value.length <= size,
        "invalid_request",
        "Chunk deadline or length mismatch",
      );
      result.set(next.value, length);
      length += next.value.length;
    }
    requireThat(
      length === size && createHash("sha256").update(result).digest("hex") === sha256,
      "invalid_request",
      "Chunk hash or length mismatch",
    );
    return result;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}
