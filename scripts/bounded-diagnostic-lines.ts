import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** Frame bounded complete lines only; a caller supplies the closed validator. */
export function observeDiagnosticLines(stream: Readable, acceptLine: (line: string) => void): void {
  const decoder = new StringDecoder("utf8");
  let partial = "",
    dropping = false;
  const flush = () => {
    const line = partial.endsWith("\r") ? partial.slice(0, -1) : partial;
    const eligible = !dropping;
    partial = "";
    dropping = false;
    try {
      if (eligible) acceptLine(line);
    } catch {
      /* Diagnostics cannot replace the child result. */
    }
  };
  const accept = (text: string) => {
    for (const character of text) {
      if (character === "\n") flush();
      else if (!dropping) {
        // The classifier allows512 characters; retain one possible CR terminator.
        if (partial.length + character.length > 513) {
          partial = "";
          dropping = true;
        } else partial += character;
      }
    }
  };
  stream.on("data", (chunk: Buffer | string) =>
    accept(typeof chunk === "string" ? chunk : decoder.write(chunk)),
  );
  stream.once("end", () => {
    accept(decoder.end());
    flush();
  });
  // A close without end is not a complete final line and deliberately does not flush.
}
