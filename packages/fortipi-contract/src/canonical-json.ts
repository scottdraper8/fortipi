// Shared builtin-only canonicalization for protocol and standalone tooling.
function validString(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const n = value.charCodeAt(i);
    if (n >= 0xd800 && n <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new Error("lone surrogate");
    } else if (n >= 0xdc00 && n <= 0xdfff) throw new Error("lone surrogate");
  }
}

export { validString };
/** Protocol canonical JSON: UTF-16 key order, JSON encoding, -0 normalization; never accepts non-JSON values. */
export function canonicalJson(value: unknown): string {
  const active = new Set<object>();
  function visit(v: unknown): string {
    if (v === null) return "null";
    if (typeof v === "boolean") return String(v);
    if (typeof v === "string") {
      validString(v);
      return JSON.stringify(v);
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("non-finite number");
      return JSON.stringify(v);
    }
    if (typeof v !== "object" || !v) throw new Error("non-JSON value");
    if (active.has(v)) throw new Error("cyclic JSON");
    active.add(v);
    let result: string;
    if (Array.isArray(v)) {
      if (
        Object.getOwnPropertySymbols(v).length ||
        Object.keys(v).length !== v.length ||
        Object.keys(v).some((k, i) => String(i) !== k)
      )
        throw new Error("sparse/extended array");
      result = `[${Object.keys(v)
        .map((k) => {
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (!d || !("value" in d)) throw new Error("JSON accessor");
          return visit(d.value);
        })
        .join(",")}]`;
    } else {
      if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
        throw new Error("non-JSON object");
      if (Object.getOwnPropertySymbols(v).length) throw new Error("symbol key");
      result = `{${Object.keys(v)
        .sort()
        .map((k) => {
          validString(k);
          const d = Object.getOwnPropertyDescriptor(v, k);
          if (!d || !("value" in d)) throw new Error("JSON accessor");
          return `${JSON.stringify(k)}:${visit(d.value)}`;
        })
        .join(",")}}`;
    }
    active.delete(v);
    return result;
  }
  return visit(value);
}
