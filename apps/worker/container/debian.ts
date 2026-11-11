/** Debian Policy version ordering and a bounded closure over one immutable binary index. */
export type Fields = Map<string, string>;
function versionPart(a: string, b: string): number {
  const order = (c: string) =>
    c === "~"
      ? -1
      : c === ""
        ? 0
        : /[A-Za-z]/.test(c)
          ? c.charCodeAt(0)
          : /[0-9]/.test(c)
            ? 0
            : c.charCodeAt(0) + 256;
  let i = 0,
    j = 0;
  while (i < a.length || j < b.length) {
    while (
      (i < a.length && !/[0-9]/.test(a[i] ?? "")) ||
      (j < b.length && !/[0-9]/.test(b[j] ?? ""))
    ) {
      const difference = order(a[i] ?? "") - order(b[j] ?? "");
      if (difference) return difference;
      if (i < a.length) i++;
      if (j < b.length) j++;
    }
    while (a[i] === "0") i++;
    while (b[j] === "0") j++;
    const ai = i,
      bj = j;
    while (i < a.length && /[0-9]/.test(a[i] ?? "")) i++;
    while (j < b.length && /[0-9]/.test(b[j] ?? "")) j++;
    if (i - ai !== j - bj) return i - ai - (j - bj);
    const left = a.slice(ai, i),
      right = b.slice(bj, j);
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}
export function compareVersions(a: string, b: string): number {
  const split = (value: string) => {
    const colon = value.indexOf(":");
    const epoch = colon < 0 ? 0n : BigInt(value.slice(0, colon));
    const rest = value.slice(colon + 1);
    const dash = rest.lastIndexOf("-");
    return {
      epoch,
      upstream: dash < 0 ? rest : rest.slice(0, dash),
      revision: dash < 0 ? "0" : rest.slice(dash + 1),
    };
  };
  const left = split(a),
    right = split(b);
  return left.epoch !== right.epoch
    ? left.epoch < right.epoch
      ? -1
      : 1
    : versionPart(left.upstream, right.upstream) || versionPart(left.revision, right.revision);
}
interface Relation {
  name: string;
  operator?: string;
  version?: string;
}
function relation(text: string): Relation {
  const match =
    /^\s*([a-z0-9][a-z0-9+.-]*)(?::(?:any|native|amd64))?(?:\s*\((<<|<=|=|>=|>>)\s*([^()\s]+)\))?\s*$/.exec(
      text,
    );
  if (!match?.[1]) throw new Error(`Unsupported frozen binary relation: ${text}`);
  return {
    name: match[1],
    ...(match[2] && match[3] ? { operator: match[2], version: match[3] } : {}),
  };
}
function matches(version: string | undefined, needed: Relation): boolean {
  if (!needed.version) return true;
  if (!version) return false;
  const n = compareVersions(version, needed.version);
  return needed.operator === "="
    ? n === 0
    : needed.operator === ">="
      ? n >= 0
      : needed.operator === ">>"
        ? n > 0
        : needed.operator === "<="
          ? n <= 0
          : n < 0;
}
export function requiredPackages(base: Fields[], roots: Fields[], index: Fields[]): Fields[] {
  const selected = new Map(base.map((row) => [row.get("Package"), row]));
  const additions = new Map<string, Fields>();
  const queue: Fields[] = [];
  for (const root of roots) {
    const name = root.get("Package");
    if (!name) throw new Error("Missing frozen root name");
    selected.set(name, root);
    additions.set(name, root);
    queue.push(root);
  }
  const available = new Map(index.map((row) => [row.get("Package"), row]));
  const satisfied = (wanted: Relation) => {
    const exact = selected.get(wanted.name);
    if (exact && matches(exact.get("Version"), wanted)) return true;
    for (const row of selected.values())
      for (const value of (row.get("Provides") ?? "").split(",").filter(Boolean)) {
        const provided = relation(value);
        if (provided.name === wanted.name && matches(provided.version, wanted)) return true;
      }
    return false;
  };
  for (let i = 0; i < queue.length; i++) {
    const row = queue[i];
    if (!row) break;
    for (const group of [row.get("Pre-Depends"), row.get("Depends")]
      .filter(Boolean)
      .join(",")
      .split(",")
      .filter(Boolean)) {
      const alternatives = group.split("|").map(relation);
      if (alternatives.some(satisfied)) continue;
      const chosen = alternatives
        .map((wanted) => ({ wanted, row: available.get(wanted.name) }))
        .find(
          ({ wanted, row }) =>
            row && !selected.has(wanted.name) && matches(row.get("Version"), wanted),
        );
      if (!chosen?.row)
        throw new Error(
          `Frozen dependencies unsatisfied without changing pinned base: ${row.get("Package")} -> ${group}`,
        );
      selected.set(chosen.wanted.name, chosen.row);
      additions.set(chosen.wanted.name, chosen.row);
      queue.push(chosen.row);
      if (queue.length > 1024) throw new Error("Frozen dependency closure exceeds bound");
    }
  }
  return [...additions.values()].sort((a, b) =>
    (a.get("Package") ?? "").localeCompare(b.get("Package") ?? ""),
  );
}
