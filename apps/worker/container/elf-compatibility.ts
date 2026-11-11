import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type Fields, paragraphs } from "./debian.ts";
import { check, run, sha256 } from "./fuse-security.ts";

interface Symbol {
  name: string;
  version: string;
  undefined: boolean;
  weak: boolean;
}
/** Both GNU and LLVM objdump print section, size, optional version, then name. */
export function dynamicSymbols(text: string): Symbol[] {
  check(
    text.includes("file format elf64-x86-64") && text.includes("DYNAMIC SYMBOL TABLE:"),
    "Expected amd64 ELF dynamic symbols",
  );
  const symbols: Symbol[] = [];
  for (const line of text.split("\n")) {
    if (!/^\s*[a-f0-9]{16}\s/.test(line)) continue;
    const fields = line.trim().split(/\s+/);
    const section =
      fields.findIndex((field, index) => index > 0 && /^[a-f0-9]{16}$/.test(field)) - 1;
    const tail = fields.slice(section + 1);
    check(section > 0 && (tail.length === 2 || tail.length === 3), "Unsupported ELF symbol row");
    const name = tail.at(-1);
    check(name, "Unnamed ELF symbol");
    const version = tail.length === 3 ? (tail[1] ?? "").replace(/[()]/g, "") : "";
    symbols.push({
      name,
      version: version === "Base" ? "" : version,
      undefined: fields[section] === "*UND*",
      weak: fields.slice(1, section).includes("w"),
    });
  }
  check(symbols.length > 0, "No ELF symbols inspected");
  return symbols;
}
export function assertResolved(consumer: Symbol[], providers: Symbol[]): string[] {
  const exported = new Set(
    providers
      .filter((symbol) => !symbol.undefined)
      .flatMap((symbol) => [symbol.name, `${symbol.name}@${symbol.version}`]),
  );
  const required = consumer
    .filter((symbol) => symbol.undefined && !symbol.weak)
    .map((symbol) => (symbol.version ? `${symbol.name}@${symbol.version}` : symbol.name))
    .sort();
  for (const symbol of required) check(exported.has(symbol), `Unresolved native symbol: ${symbol}`);
  return required;
}
export async function verifyNativeCompatibility(
  output: string,
  addon: Uint8Array,
  binary: Uint8Array,
  authenticated: Fields[],
): Promise<void> {
  const directory = resolve(output, "native-compatibility");
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const controls: Record<string, Record<string, string>> = {};
  for (const name of ["fuse3", "libfuse3-4"]) {
    const deb = resolve(output, "context/packages", `${name}.deb`);
    const row = authenticated.find((row) => row.get("Package") === name);
    check(
      row && sha256(await readFile(deb)) === row.get("SHA256"),
      "Native package differs from signed index",
    );
    const controlArchive = resolve(directory, `${name}-control.tar.xz`);
    await writeFile(controlArchive, await run("ar", ["-p", deb, "control.tar.xz"]));
    const fields = paragraphs(
      (await run("tar", ["-xOf", controlArchive, "./control"])).toString("utf8"),
    )[0];
    check(fields, "Missing native package control");
    for (const field of [
      "Package",
      "Version",
      "Architecture",
      "Source",
      "Pre-Depends",
      "Depends",
      "Conflicts",
      "Breaks",
      "Replaces",
      "Provides",
      "Built-Using",
      "Static-Built-Using",
    ])
      check(
        fields.get(field) === row.get(field),
        `Native control/index mismatch: ${name}/${field}`,
      );
    controls[name] = Object.fromEntries(fields);
    await writeFile(
      resolve(directory, `${name}-data.tar.xz`),
      await run("ar", ["-p", deb, "data.tar.xz"]),
    );
  }
  const inputs = {
    "fuse.node": Buffer.from(addon),
    computerd: Buffer.from(binary),
    "libfuse3.so.4": await run("tar", [
      "-xOf",
      resolve(directory, "libfuse3-4-data.tar.xz"),
      "./usr/lib/x86_64-linux-gnu/libfuse3.so.3.18.3",
    ]),
    fusermount3: await run("tar", [
      "-xOf",
      resolve(directory, "fuse3-data.tar.xz"),
      "./usr/bin/fusermount3",
    ]),
    "libc.so.6": await run("tar", [
      "-xOf",
      resolve(output, "37fb86c2a767b88d500c6872195f88078f64765fe0d2f9cc375cc2efbd4c0a41.tgz"),
      "usr/lib/x86_64-linux-gnu/libc.so.6",
    ]),
  };
  const parsed = new Map<string, Symbol[]>();
  const dependencies: Record<string, string[]> = {};
  for (const [name, bytes] of Object.entries(inputs)) {
    const path = resolve(directory, name);
    await writeFile(path, bytes);
    const [table, headers] = await Promise.all([
      run("objdump", ["-T", path]),
      run("objdump", ["-p", path]),
    ]);
    parsed.set(name, dynamicSymbols(table.toString("utf8")));
    dependencies[name] = [...headers.toString("utf8").matchAll(/^\s+NEEDED\s+(\S+)\s*$/gm)]
      .map((match) => match[1] ?? "")
      .sort();
    if (name === "libfuse3.so.4")
      check(
        /^\s+SONAME\s+libfuse3\.so\.4\s*$/m.test(headers.toString("utf8")),
        "FUSE SONAME changed",
      );
  }
  check(
    JSON.stringify(dependencies["fuse.node"]) === JSON.stringify(["libc.so.6", "libfuse3.so.4"]),
    "Addon runtime dependencies changed",
  );
  for (const name of ["libfuse3.so.4", "fusermount3"])
    check(
      JSON.stringify(dependencies[name]) === JSON.stringify(["libc.so.6"]),
      "FUSE runtime dependency closure changed",
    );
  const symbols = (name: string) => {
    const result = parsed.get(name);
    check(result, "Missing ELF symbol table");
    return result;
  };
  const required: Record<string, string[]> = {};
  required["fuse.node"] = assertResolved(symbols("fuse.node"), [
    ...symbols("libfuse3.so.4"),
    ...symbols("libc.so.6"),
    ...symbols("computerd"),
  ]);
  for (const name of ["libfuse3.so.4", "fusermount3"])
    required[name] = assertResolved(symbols(name), symbols("libc.so.6"));
  await writeFile(
    resolve(output, "native-compatibility.json"),
    `${JSON.stringify({ controls, inputs: Object.fromEntries(Object.entries(inputs).map(([name, bytes]) => [name, sha256(bytes)])), dependencies, required, runtimeVerified: false, observation: "Static versioned symbol resolution; no Linux loader, installation, kernel/FUSE or structure-layout proof" }, null, 2)}\n`,
  );
}
