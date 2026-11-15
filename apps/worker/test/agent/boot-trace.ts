import type { Harness } from "@earendil-works/pi-durable";

export const bootStages = [
  "open",
  "opened",
  "open-failed",
  "resume",
  "resumed",
  "resume-failed",
  "wake",
  "observe",
  "publish",
  "host",
  "host-done",
  "host-failed",
  "pi",
  "pi-done",
  "pi-failed",
] as const;
export type BootStage = (typeof bootStages)[number];
export type BootMark = (stage: BootStage) => void;
export const bootPrefix = "FORTIPI_PRIVATE_BOOT ";

/** Worker-isolate-local; synchronous, sparse and never authoritative. */
export function createBootTrace(emit: (line: string) => void): BootMark {
  const counts = new Map<BootStage, number>();
  let records = 0;
  return (stage) => {
    try {
      if (!bootStages.includes(stage)) return;
      const first = !counts.has(stage);
      const count = Math.min((counts.get(stage) ?? 0) + 1, 1000000);
      counts.set(stage, count);
      const spare = 20 - (bootStages.length - counts.size);
      if (records < 20 && (first || (records < spare && (count & (count - 1)) === 0))) {
        records++;
        emit(bootPrefix + JSON.stringify({ stage, count }));
      }
    } catch {
      /* A broken diagnostic sink cannot replace the original result. */
    }
  };
}

/** Attach observation without replacing the upstream promise or its rejection. */
export function bootPromise<T>(
  mark: BootMark,
  enter: BootStage,
  done: BootStage,
  failed: BootStage,
  call: () => Promise<T>,
  inspect?: (value: T) => void,
): Promise<T> {
  mark(enter);
  try {
    const result = call();
    void result.then(
      (value) => {
        mark(done);
        try {
          inspect?.(value);
        } catch {
          /* Diagnostic only. */
        }
      },
      () => {
        mark(failed);
      },
    );
    return result;
  } catch (error) {
    mark(failed);
    throw error;
  }
}

const installed = new WeakSet<object>(),
  wrapped = new WeakSet<object>(),
  callbacks = new WeakSet<object>();
/** Fixture-only global public-API wrapper, installed before the opted-in host starts. */
export function installBootTrace(
  target: typeof import("@earendil-works/pi-durable").Harness,
  mark: BootMark,
): void {
  if (installed.has(target)) return;
  installed.add(target);
  const open = target.open;
  target.open = function (this: unknown, ...args: Parameters<typeof open>) {
    const options = args[1],
      wake = options.onWake;
    if (wake && !callbacks.has(wake)) {
      const next = function (this: unknown, ...input: Parameters<typeof wake>) {
        mark("wake");
        return Reflect.apply(wake, this === forwarded ? options : this, input) as ReturnType<
          typeof wake
        >;
      };
      callbacks.add(next);
      const forwarded = { ...options, onWake: next };
      args[1] = forwarded;
    }
    return bootPromise(
      mark,
      "open",
      "opened",
      "open-failed",
      () => Reflect.apply(open, this, args) as Promise<Harness>,
      (harness) => {
        if (wrapped.has(harness)) return;
        wrapped.add(harness);
        const resume = harness.resume,
          observe = harness.observeCommits;
        harness.resume = function (this: Harness, ...input: Parameters<typeof resume>) {
          mark("resume");
          try {
            const value = Reflect.apply(resume, this, input) as ReturnType<typeof resume>;
            mark("resumed");
            return value;
          } catch (error) {
            mark("resume-failed");
            throw error;
          }
        };
        harness.observeCommits = function (this: Harness, ...input: Parameters<typeof observe>) {
          mark("observe");
          const observer = input[0],
            advance = observer.advance;
          if (!callbacks.has(advance)) {
            const next = function (this: unknown, ...values: Parameters<typeof advance>) {
              mark("publish");
              return Reflect.apply(
                advance,
                this === forwarded ? observer : this,
                values,
              ) as ReturnType<typeof advance>;
            };
            callbacks.add(next);
            const forwarded = { ...observer, advance: next };
            input[0] = forwarded;
          }
          return Reflect.apply(observe, this, input) as ReturnType<typeof observe>;
        };
      },
    );
  } as typeof open;
}

/** Read only complete closed frames from the harness's existing private bounded capture. */
export function bootSamples(output: string): [BootStage, number][] {
  const latest = new Map<BootStage, number>();
  for (const line of output.slice(-12000).split(/\r?\n/).slice(0, -1)) {
    const at = line.indexOf(bootPrefix);
    if (at < 0) continue;
    const raw = line.slice(at + bootPrefix.length).trimEnd();
    if (raw.length > 128) continue;
    try {
      const value = JSON.parse(raw) as { stage?: BootStage; count?: number };
      if (
        Object.keys(value).join(",") !== "stage,count" ||
        raw !== JSON.stringify(value) ||
        !bootStages.includes(value.stage as BootStage) ||
        !Number.isInteger(value.count) ||
        !value.count ||
        value.count < 1 ||
        value.count > 524288 ||
        (value.count & (value.count - 1)) !== 0
      )
        continue;
      latest.set(
        value.stage as BootStage,
        Math.max(latest.get(value.stage as BootStage) ?? 0, value.count),
      );
    } catch {
      /* No arbitrary child output is eligible. */
    }
  }
  return bootStages.flatMap((stage) =>
    latest.has(stage) ? [[stage, latest.get(stage) as number] as [BootStage, number]] : [],
  );
}
