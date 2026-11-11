import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Assignment, LocalPrepare } from "fortipi-contract/executor";
import { assignmentDigest, operationDigest } from "fortipi-contract/executor";
import type { Profile } from "../../dist/config.js";
import { adapter, defaults, secureDirectory } from "../../dist/config.js";
import type { ExecutorRuntime } from "../../dist/daemon.js";
import { Guard, Ledger } from "../../dist/ledger.js";
import type { LocalPolicy } from "../../dist/policy.js";
import type { HttpTransport } from "../../dist/transport.js";
import type { LocalWorkspace } from "../../dist/workspace/local.js";
import { scan } from "../../dist/workspace/manifest.js";
import { SafeRoot } from "../../dist/workspace/paths.js";

export const credential = {
  credentialId: "synthetic_client_credential",
  generation: 2,
  grantVersion: 3,
};
export const executorCredential = {
  credentialId: "synthetic_executor_transport",
  generation: 5,
  grantVersion: 1,
};
export const resources = {
  agentIds: ["agent"],
  conversationIds: ["conversation"],
  workspaceIds: ["workspace"],
  actions: [
    "workspace.read",
    "workspace.write",
    "executor.register",
    "executor.execute",
    "artifacts.read",
  ],
  tools: ["shell"],
  executorIds: ["executor"],
  backendIds: [],
};
export function policy(): LocalPolicy {
  return {
    version: 1,
    trustedHost: true,
    requireConfinement: false,
    consent: {
      acceptedAt: Date.now(),
      osUser: userInfo().username,
      disclosure: "daemon-user-files-and-network",
    },
    rules: [],
  };
}
export async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "fortipi-executor-")));
  const directory = join(path, "state"),
    rootPath = join(path, "root");
  await secureDirectory(directory);
  await secureDirectory(rootPath);
  const root = await SafeRoot.open(rootPath, adapter());
  const initial = await scan(root, defaults);
  const profile: Profile = {
    version: 1,
    origin: "http://127.0.0.1:8787",
    deploymentId: "deployment",
    executorId: "executor",
    executorGeneration: 7,
    credential: executorCredential,
    token: "synthetic-executor-token",
    ledgerId: "ledger",
    bindings: [
      {
        rootBindingId: "root",
        workspaceId: "workspace",
        bindingVersion: 1,
        path: rootPath,
        revision: "r0",
        manifestHash: initial.manifestHash,
        providerKind: "local",
      },
    ],
    resources,
    policy: policy(),
    limits: {},
  };
  const ledger = await Ledger.provision(directory, profile.ledgerId, defaults);
  return {
    path,
    directory,
    rootPath,
    root,
    profile,
    ledger,
    initial,
    async cleanup() {
      ledger.close();
      await rm(path, { recursive: true, force: true });
    },
  };
}
export const quote = (s: string) =>
  process.platform === "win32" ? `'${s.replaceAll("'", "''")}'` : `'${s.replaceAll("'", `'\\''`)}'`;
export function nodeCommand(...args: string[]): string {
  const native = (s: string) =>
    quote(process.platform === "win32" ? s.replace(/(\\*)"/g, '$1$1\\"') : s);
  return `${process.platform === "win32" ? "& " : ""}${[process.execPath, ...args].map(native).join(" ")}`;
}
export async function assignment(
  command: string,
  jobId = randomUUID(),
  baseRevision = "r0",
): Promise<Assignment> {
  const deadline = Date.now() + 60000,
    target = { kind: "executor" as const, executorId: "executor", generation: 7 };
  const operation = {
    deploymentId: "deployment",
    agentId: "agent",
    conversationId: "conversation",
    tool: "shell",
    arguments: { command },
    workspaceId: "workspace",
    baseRevision,
    target,
    policyVersion: 1,
    grantVersion: 3,
    deadline,
  };
  const operationHash = await operationDigest(operation),
    executionId = randomUUID(),
    reservationId = randomUUID(),
    leaseId = randomUUID(),
    operationId = randomUUID();
  const digest = await assignmentDigest({
    operation,
    executionId,
    reservationId,
    leaseId,
    fence: "1",
    executorGeneration: 7,
  });
  return {
    identity: {
      jobId,
      executionId,
      operationDigest: operationHash,
      assignmentDigest: digest,
      target,
      baseRevision,
      deadline,
      lease: {
        leaseId,
        operationId,
        credential,
        registrationId: "registration",
        leaseVersion: 1,
        workspaceId: "workspace",
        executorId: "executor",
        executorGeneration: 7,
        fence: "1",
        baseRevision,
        expiresAt: Date.now() + 30000,
        ownerKind: "job",
        jobId,
      },
    },
    reservationId,
    tool: "shell",
    arguments: { command },
    workspaceId: "workspace",
    bindingVersion: 1,
    rootBindingId: "root",
    operationContext: {
      deploymentId: "deployment",
      agentId: "agent",
      conversationId: "conversation",
      policyVersion: 1,
    },
    approval: {
      operationId,
      operationDigest: operationHash,
      tool: "shell",
      arguments: { command },
      workspaceId: "workspace",
      baseRevision,
      target,
      trust: "host",
      capabilities: ["shell"],
      policyVersion: 1,
      grantVersion: 3,
      expiresAt: deadline,
    },
  };
}
export function prepare(a: Assignment, manifestHash: string): LocalPrepare {
  return {
    kind: "prepare",
    operationId: a.identity.lease.operationId,
    operationDigest: a.identity.operationDigest,
    workspaceId: a.workspaceId,
    bindingVersion: 1,
    rootBindingId: "root",
    executorId: "executor",
    executorGeneration: 7,
    credential,
    baseRevision: a.identity.baseRevision,
    lease: a.identity.lease,
    deadline: a.identity.deadline,
    commitId: randomUUID(),
    expectedManifestHash: manifestHash,
    mode: {
      kind: "native-execution",
      jobId: a.identity.jobId,
      executionId: a.identity.executionId,
      assignmentDigest: a.identity.assignmentDigest,
    },
  };
}
export function requestScope(request: LocalPrepare) {
  const { kind: _kind, mode: _mode, expectedManifestHash: _hash, ...scope } = request;
  return scope;
}
export function receiptScope(request: LocalPrepare) {
  const { commitId: _commit, ...scope } = requestScope(request);
  return scope;
}
export async function importRoot(local: LocalWorkspace): Promise<void> {
  if (!local.ledger.record("revisions", local.revisionKey(local.binding.revision)))
    await local.importBinding(local.importProposal(randomUUID()));
}
/** Synthetic trusted-CP state for local process tests; ticket/auth durability is excluded. */
export function authenticateFixture(http: HttpTransport): void {
  http.authority = {
    deploymentId: http.profile.deploymentId,
    principalId: "synthetic_executor_principal",
    role: "executor",
    credential: http.profile.credential,
    credentialExpiresAt: null,
  };
}
/** Actual parsed executor lease-update frames; no TTL extension beyond the protocol's 30s window. */
export function jobRenewals(runtime: ExecutorRuntime, a: Assignment) {
  runtime.ledger.admit(a, "lease-renewal-fixture");
  const observations: {
    at: number;
    leaseVersion: number;
    remainingLeaseMs: number;
    remainingDeadlineMs: number;
  }[] = [];
  let pending = Promise.resolve(),
    failure: unknown;
  const renew = () => {
    pending = pending
      .then(async () => {
        const row = runtime.ledger.existing(a.identity);
        if (!row) throw new Error("renewal attempt missing");
        const expiresAt = Math.min(a.identity.deadline, Date.now() + 30000);
        if (expiresAt <= row.assignment.identity.lease.expiresAt) return;
        await runtime.receive({
          type: "job.lease_update",
          requestId: randomUUID(),
          payload: {
            identity: a.identity,
            leaseVersion: row.assignment.identity.lease.leaseVersion + 1,
            expiresAt,
          },
        });
        const current = runtime.ledger.existing(a.identity);
        if (!current) throw new Error("renewed attempt missing");
        observations.push({
          at: Date.now(),
          leaseVersion: current.assignment.identity.lease.leaseVersion,
          remainingLeaseMs: current.assignment.identity.lease.expiresAt - Date.now(),
          remainingDeadlineMs: a.identity.deadline - Date.now(),
        });
      })
      .catch((error) => {
        failure = error;
      });
    return pending;
  };
  const timer = setInterval(() => {
    void renew();
  }, 10000);
  return {
    renew,
    observations,
    async stop() {
      clearInterval(timer);
      await pending;
      if (failure) throw failure;
    },
  };
}

/** Observe real adapter calls without substituting filesystem or permission behavior. */
export function nativeTimeline(root: SafeRoot) {
  const start = performance.now(),
    verifyEntry = root.platform.verifyEntry,
    phases: {
      phase: string;
      at: number;
      elapsedMs: number;
      entryChecks: number;
      entryMs: number;
    }[] = [];
  let entryChecks = 0,
    entryMs = 0,
    maxEntryMs = 0;
  root.platform.verifyEntry = async function (path, stat) {
    const before = performance.now();
    entryChecks++;
    try {
      await verifyEntry.call(this, path, stat);
    } finally {
      const elapsed = performance.now() - before;
      entryMs += elapsed;
      maxEntryMs = Math.max(maxEntryMs, elapsed);
    }
  };
  return {
    async measure<T>(phase: string, work: () => Promise<T>): Promise<T> {
      const before = performance.now(),
        checks = entryChecks,
        cost = entryMs,
        at = Date.now();
      try {
        return await work();
      } finally {
        phases.push({
          phase,
          at,
          elapsedMs: performance.now() - before,
          entryChecks: entryChecks - checks,
          entryMs: entryMs - cost,
        });
      }
    },
    summary() {
      return { elapsedMs: performance.now() - start, entryChecks, entryMs, maxEntryMs, phases };
    },
    restore() {
      root.platform.verifyEntry = verifyEntry;
    },
  };
}
export async function eventually(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeout = 10000,
): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise<void>((r) => setTimeout(r, 20));
  }
  throw new Error(message);
}
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self && process.argv[2] === "guard") {
  try {
    const guard = await Guard.acquire(process.argv[3] as string);
    process.stdout.write("acquired\n");
    guard.close();
  } catch {
    process.stdout.write("locked\n");
    process.exitCode = 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === self && process.argv[2] === "claim-crash") {
  const directory = process.argv[3] as string;
  const ledger = await Ledger.open(directory, "ledger", defaults);
  const a = JSON.parse(process.argv[4] as string) as Assignment;
  const row = ledger.admit(a, "key");
  row.decision = "allow";
  ledger.put(row);
  if (!ledger.claim(a.identity.jobId, "key", "synthetic-root", a.identity.jobId))
    throw new Error("claim failed");
  process.exit(71);
}
if (process.argv[1] && resolve(process.argv[1]) === self && process.argv[2] === "journal-crash") {
  const ledger = await Ledger.open(process.argv[3] as string, "ledger", defaults);
  ledger.db.exec("PRAGMA cache_size=5; BEGIN IMMEDIATE");
  ledger.db
    .prepare("UPDATE meta SET value=? WHERE key='durable_canary'")
    .run("uncommitted".repeat(100000));
  process.exit(74);
}
export const fixtureChild = join(dirname(self), "child.ts");
if (process.argv[1] && resolve(process.argv[1]) === self && process.argv[2] === "start-crash") {
  const inputPath = process.argv[3] as string;
  const { privateRead } = await import("../../dist/config.js");
  const input = JSON.parse(await privateRead(inputPath)) as {
    profile: Profile;
    assignment: Assignment;
    directory: string;
    marker: string;
  };
  const guard = await Guard.acquire(join(input.directory, "daemon.guard.sqlite"));
  const ledger = await Ledger.open(input.directory, "ledger", defaults);
  const binding = input.profile.bindings[0];
  if (!binding) throw new Error("binding missing");
  const root = await SafeRoot.open(binding.path, adapter());
  const { ExecutorRuntime } = await import("../../dist/daemon.js"),
    { HttpTransport } = await import("../../dist/transport.js");
  const http = new HttpTransport(input.profile, fetch, true);
  authenticateFixture(http);
  const runtime = new ExecutorRuntime({
    profile: input.profile,
    ledger,
    directory: input.directory,
    roots: new Map([["root", root]]),
    http,
  });
  await runtime.initialize();
  runtime.connected = true;
  for (const local of runtime.locals.values()) await importRoot(local);
  await runtime.locals.get("root")?.request(prepare(input.assignment, binding.manifestHash));
  await runtime.assignOnce(input.assignment);
  const pending = runtime.approvals.list()[0];
  if (!pending) throw new Error("approval missing");
  runtime.approvals.decide(input.assignment.identity.jobId, pending.digest, "allow");
  await runtime.tick();
  await eventually(async () => {
    try {
      await realpath(input.marker);
      return true;
    } catch {
      return false;
    }
  }, "child marker missing");
  void guard;
  process.exit(77); // Abruptly release OS locks without daemon cleanup; test child self-exits shortly.
}
if (process.argv[1] && resolve(process.argv[1]) === self && process.argv[2] === "windows-probe") {
  if (process.platform !== "win32")
    throw new Error("windows-probe requires an actual Windows host");
  const {
      powershellArgs,
      windowsUtilityEnvironment,
      verifyWindowsSqliteSidecar,
      WindowsAttributeReader,
    } = await import("../../dist/platform/windows.js"),
    execute = promisify(execFile),
    environment = windowsUtilityEnvironment(),
    executable = win32.join(
      environment.SystemRoot ?? "",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
  const marker = "fortipi-native-probe",
    command = `$ErrorActionPreference='Stop';[Console]::Out.Write('${marker}')`;
  let controlledEofPassed = false;
  for (const controlled of [false, true])
    for (const eof of [false, true]) {
      const started = performance.now(),
        pending = execute(executable, powershellArgs(command), {
          env: controlled ? environment : { SystemRoot: environment.SystemRoot ?? "" },
          timeout: 10000,
          maxBuffer: 8192,
          windowsHide: true,
        });
      pending.child.stdin?.on("error", () => {});
      if (eof) pending.child.stdin?.end();
      try {
        const r = await pending,
          matched = r.stdout === marker;
        process.stdout.write(
          `${JSON.stringify({ phase: "startup", controlledEnvironment: controlled, stdinEof: eof, elapsedMs: Math.round(performance.now() - started), exitCode: 0, markerMatched: matched, stdoutBytes: Buffer.byteLength(r.stdout), stderrBytes: Buffer.byteLength(r.stderr) })}\n`,
        );
        if (controlled && eof) controlledEofPassed = matched;
      } catch (error) {
        const e = error as {
          code?: string | number;
          signal?: string;
          killed?: boolean;
          stdout?: string;
          stderr?: string;
        };
        process.stdout.write(
          `${JSON.stringify({ phase: "startup", controlledEnvironment: controlled, stdinEof: eof, elapsedMs: Math.round(performance.now() - started), exitCode: e.code ?? null, signal: e.signal ?? null, killed: e.killed === true, stdoutBytes: Buffer.byteLength(e.stdout ?? ""), stderrBytes: Buffer.byteLength(e.stderr ?? "") })}\n`,
        );
      }
    }
  const path = await realpath(await mkdtemp(join(tmpdir(), "fortipi-windows-probe-"))),
    file = join(path, "synthetic.txt"),
    psLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;
  await writeFile(file, "synthetic");
  function marked(steps: [string, string][]): string {
    const stamp = (stage: string) =>
      `[Console]::Out.WriteLine('fortipi-acl:${stage}:'+$clock.ElapsedMilliseconds);[Console]::Out.Flush()`;
    return `$ErrorActionPreference='Stop';$clock=[System.Diagnostics.Stopwatch]::StartNew();${steps.map(([stage, body]) => `${stamp(`${stage}.begin`)};${body};${stamp(`${stage}.done`)}`).join(";")}`;
  }
  async function runMarked(phase: string, steps: [string, string][]): Promise<boolean> {
    const started = performance.now(),
      pending = execute(executable, powershellArgs(marked(steps)), {
        env: environment,
        timeout: 10000,
        maxBuffer: 8192,
        windowsHide: true,
      });
    pending.child.stdin?.on("error", () => {});
    pending.child.stdin?.end();
    let stdout = "",
      stderr = "",
      exitCode: string | number | null = 0,
      signal: string | null = null,
      killed = false;
    try {
      ({ stdout, stderr } = await pending);
    } catch (error) {
      const e = error as {
        stdout?: string;
        stderr?: string;
        code?: string | number;
        signal?: string;
        killed?: boolean;
      };
      stdout = e.stdout ?? "";
      stderr = e.stderr ?? "";
      exitCode = e.code ?? null;
      signal = e.signal ?? null;
      killed = e.killed === true;
    }
    const stages = stdout
      .split(/\r?\n/)
      .flatMap((line) => {
        const m = /^fortipi-acl:([a-z0-9-]+\.(?:begin|done)):(\d{1,8})$/.exec(line);
        return m ? [{ stage: m[1], elapsedMs: Number(m[2]) }] : [];
      })
      .slice(0, 64);
    process.stdout.write(
      `${JSON.stringify({ phase, elapsedMs: Math.round(performance.now() - started), exitCode, signal, killed, stages, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr) })}\n`,
    );
    return exitCode === 0 && stages.at(-1)?.stage === `${steps.at(-1)?.[0]}.done`;
  }
  // Frozen old commands, separately measured. Markers contain no paths, SIDs or account names.
  await runMarked("cmdlet-protection", [
    ["sid", "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User"],
    ["new-acl", "$acl=New-Object System.Security.AccessControl.DirectorySecurity"],
    ["owner", "$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)"],
    [
      "rules",
      "foreach($s in @($sid,[System.Security.Principal.SecurityIdentifier]'S-1-5-18')){$r=New-Object System.Security.AccessControl.FileSystemAccessRule($s,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($r)}",
    ],
    ["set-acl", `Set-Acl -LiteralPath ${psLiteral(path)} -AclObject $acl`],
  ]);
  await runMarked("security-module", [
    ["import-security", "Import-Module Microsoft.PowerShell.Security -ErrorAction Stop"],
    ["get-acl", `$a=Get-Acl -LiteralPath ${psLiteral(path)}`],
  ]);
  await runMarked("management-module", [
    ["import-management", "Import-Module Microsoft.PowerShell.Management -ErrorAction Stop"],
    ["get-item", `$attributes=[int](Get-Item -Force -LiteralPath ${psLiteral(path)}).Attributes`],
  ]);
  await runMarked("utility-module", [
    ["import-utility", "Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop"],
    ["new-object", "$o=New-Object System.Object"],
    ["convert-json", "$j=[pscustomobject]@{synthetic=$true}|ConvertTo-Json"],
  ]);
  const bclSteps: [string, string][] = [
    [
      "sid",
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$system=[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')",
    ],
  ];
  for (const directory of [true, false]) {
    const kind = directory ? "Directory" : "File",
      tag = directory ? "directory" : "file",
      nativePath = directory ? path : file;
    bclSteps.push(
      [
        `${tag}-new-acl`,
        `$acl=[System.Security.AccessControl.${kind}Security]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)`,
      ],
      [
        `${tag}-rules`,
        `$flags=[System.Security.AccessControl.InheritanceFlags]'${directory ? "ContainerInherit,ObjectInherit" : "None"}';foreach($s in @($sid,$system)){$r=[System.Security.AccessControl.FileSystemAccessRule]::new($s,[System.Security.AccessControl.FileSystemRights]::FullControl,$flags,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);$acl.AddAccessRule($r)}`,
      ],
      [`${tag}-set-acl`, `[System.IO.${kind}]::SetAccessControl(${psLiteral(nativePath)},$acl)`],
      [
        `${tag}-get-acl`,
        `$a=[System.IO.${kind}]::GetAccessControl(${psLiteral(nativePath)},[System.Security.AccessControl.AccessControlSections]'Owner,Access')`,
      ],
      [
        `${tag}-verify`,
        "if(!$a.AreAccessRulesProtected -or $a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'ACL invariant'};$found=$false;foreach($r in $a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])){if($r.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or ($r.IdentityReference.Value -ne $sid.Value -and $r.IdentityReference.Value -ne $system.Value)){throw 'ACL invariant'};if($r.IdentityReference.Value -eq $sid.Value -and (([int64]$r.FileSystemRights -band 2032127) -eq 2032127)){$found=$true}};if(!$found){throw 'ACL invariant'}",
      ],
      [
        `${tag}-attributes`,
        `$attributes=[int][System.IO.File]::GetAttributes(${psLiteral(nativePath)});if(($attributes -band 1024) -ne 0){throw 'reparse invariant'}`,
      ],
    );
  }
  const bclPassed = await runMarked("direct-bcl", bclSteps),
    started = performance.now();
  let aclPassed = false;
  let sidecarPassed = false;
  let attributeReaderPassed = false;
  let operation = "protect-directory";
  try {
    const p = adapter();
    await p.protect(path, true);
    operation = "verify-directory";
    await p.verifyProtection(path, true);
    operation = "protect-file";
    await p.protect(file, false);
    operation = "verify-file";
    await p.verifyProtection(file, false);
    aclPassed = true;
    process.stdout.write(
      `${JSON.stringify({ phase: "actual-dacl", elapsedMs: Math.round(performance.now() - started), protectedDirectoryAndFile: true })}\n`,
    );
    operation = "attribute-reader";
    const { lstat, mkdir: makeDirectory, symlink } = await import("node:fs/promises");
    const entry = join(path, "reader-'$[data];λ.txt"),
      otherPath = join(path, "other-root");
    await writeFile(entry, "actual synthetic entry");
    await makeDirectory(otherPath);
    await writeFile(join(otherPath, "other.txt"), "different root bytes");
    const regular = await lstat(entry),
      batchStarted = performance.now();
    for (let index = 0; index < 44; index++) await p.verifyEntry(entry, regular);
    const fresh44ChecksMs = performance.now() - batchStarted;
    await rm(entry);
    await symlink(otherPath, entry, "junction");
    // Stale regular-file Stats intentionally bypass the early symlink predicate:
    // only a fresh GetAttributes of the actual mutated path can reject this.
    const mixed = await Promise.allSettled([
      p.verifyEntry(file, await lstat(file)),
      p.verifyEntry(entry, regular),
    ]);
    assert.equal(mixed[0]?.status, "fulfilled");
    assert.equal(mixed[1]?.status, "rejected");
    if (mixed[1]?.status === "rejected")
      assert.match(String(mixed[1].reason), /reparse point rejected/);
    await rm(entry);
    await assert.rejects(p.verifyEntry(entry, regular), /Windows attribute query failed/);
    await writeFile(entry, "actual synthetic entry");
    await p.verifyEntry(entry, await lstat(entry));
    const owner = await SafeRoot.open(path, p),
      other = await SafeRoot.open(otherPath, adapter()),
      reads = await Promise.all([owner.read("synthetic.txt", 64), other.read("other.txt", 64)]);
    assert.equal(reads[0]?.toString(), "synthetic");
    assert.equal(reads[1]?.toString(), "different root bytes");
    assert.equal((await SafeRoot.open(path, adapter())).key, owner.key);
    for (const fault of ["eof", "crash"] as const) {
      const children: { closed: boolean; code: number | null; signal: NodeJS.Signals | null }[] =
        [];
      const reader = new WindowsAttributeReader((child) => {
        const observed = {
          closed: false,
          code: null as number | null,
          signal: null as NodeJS.Signals | null,
        };
        children.push(observed);
        child.once("close", (code, signal) => {
          observed.closed = true;
          observed.code = code;
          observed.signal = signal;
        });
        if (children.length === 1) {
          // A malformed prefix makes the real fixed reader exit normally before
          // the following correlated query receives any reply.
          if (fault === "eof") child.stdin.write("probe-eof\n");
          else child.kill(); // Only this actual live helper handle, never a recovered PID.
        }
      });
      await assert.rejects(
        reader.query(file),
        /Windows attribute reader (?:exited or failed|write failed)/,
      );
      assert.equal(children.length, 1);
      assert.equal((await reader.query(file)) & 1024, 0);
      await eventually(
        () => children.every((child) => child.closed),
        "attribute reader failed idle cleanup",
        2000,
      );
      if (fault === "eof") {
        assert.equal(children[0]?.code, 0);
        assert.equal(children[0]?.signal, null);
      }
      assert.equal(children[1]?.code, 0);
      assert.equal(children[1]?.signal, null);
      assert.equal((await reader.query(file)) & 1024, 0);
      await eventually(
        () => children.every((child) => child.closed),
        "reopened attribute reader failed idle cleanup",
        2000,
      );
      assert.equal(children.length, 3);
      assert.equal(children[2]?.code, 0);
      assert.equal(children[2]?.signal, null);
    }
    let helperStarts = 0,
      helperClosed = false,
      reading = true;
    let readFailure: unknown;
    const independent = new WindowsAttributeReader((child) => {
      helperStarts++;
      child.once("close", () => {
        helperClosed = true;
      });
    });
    await independent.query(file);
    const keepReading = (async () => {
      while (reading) {
        await independent.query(file);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    })().catch((error: unknown) => {
      readFailure = error;
    });
    const job = p.spawn(p.shell("[System.Threading.Thread]::Sleep(10000)", path, environment));
    job.stdout?.resume();
    job.stderr?.resume();
    try {
      assert.equal((await p.cancel(job, 50)).state, "stopped");
    } finally {
      reading = false;
      await keepReading;
      if (job.exitCode === null && job.signalCode === null) job.kill();
    }
    if (readFailure) throw readFailure;
    assert.equal(helperStarts, 1, "job-tree cancellation must not kill the separate utility");
    assert.equal((await independent.query(file)) & 1024, 0);
    await eventually(() => helperClosed, "independent helper failed idle cleanup", 2000);
    attributeReaderPassed = true;
    process.stdout.write(
      `${JSON.stringify({ phase: "attribute-reader", fresh44ChecksMs, freshReparseRejected: true, missingRejected: true, multipleRoots: true, correlatedReplies: true, eofCrashFailClosed: true, restartPassed: true, idleNormalExit: true, independentOfJobTree: true })}\n`,
    );
    operation = "sqlite-sidecar-eligibility";
    const { link, mkdir, readFile, stat } = await import("node:fs/promises");
    const database = join(path, "probe.sqlite"),
      sidecar = `${database}-journal`,
      bytes = Buffer.from("synthetic retained journal bytes");
    await writeFile(database, "");
    await p.protect(database, false);
    async function security(command: string): Promise<string> {
      const pending = execute(
        executable,
        powershellArgs(`$ErrorActionPreference='Stop';${command}`),
        { env: environment, timeout: 10000, maxBuffer: 8192, windowsHide: true },
      );
      pending.child.stdin?.on("error", () => {});
      pending.child.stdin?.end();
      return (await pending).stdout.trim();
    }
    const descriptor = (target: string) =>
      security(
        `$a=[System.IO.File]::GetAccessControl(${psLiteral(target)},[System.Security.AccessControl.AccessControlSections]'Owner,Access');[Console]::Out.Write($a.GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]'Owner,Access'))`,
      );
    const fresh = async () => {
      await rm(sidecar, { force: true });
      await writeFile(sidecar, bytes);
    };
    await fresh();
    const before = await stat(sidecar);
    await verifyWindowsSqliteSidecar(database, "-journal");
    await p.verifyProtection(sidecar, false);
    const after = await stat(sidecar);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.mtimeMs !== after.mtimeMs ||
      !(await readFile(sidecar)).equals(bytes)
    )
      throw new Error("sidecar hardening changed identity/content");
    async function rejectUnchanged(main: string, target: string, expected: RegExp): Promise<void> {
      const before = await descriptor(target);
      let rejected = false;
      try {
        await verifyWindowsSqliteSidecar(main, "-journal");
      } catch (error) {
        if (!(error instanceof Error) || !expected.test(error.message))
          throw new Error("sidecar rejection did not reach the expected safety gate");
        rejected = true;
      }
      if (
        !rejected ||
        (await descriptor(target)) !== before ||
        !(await readFile(target)).equals(bytes)
      )
        throw new Error("unsafe sidecar accepted or changed before rejection");
    }
    await fresh();
    await security(
      `$p=${psLiteral(sidecar)};$a=[System.IO.File]::GetAccessControl($p);$r=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.AccessControlType]::Allow);$a.AddAccessRule($r);[System.IO.File]::SetAccessControl($p,$a)`,
    );
    await rejectUnchanged(database, sidecar, /^unsafe SQLite sidecar rules/);
    await fresh();
    const alias = join(path, "hardlink");
    await link(sidecar, alias);
    await rejectUnchanged(database, sidecar, /^unsafe SQLite sidecar type\/link/);
    await rm(alias);
    const unsafeParent = join(path, "unsafe-parent");
    await mkdir(unsafeParent);
    await p.protect(unsafeParent, true);
    const unsafeDatabase = join(unsafeParent, "probe.sqlite"),
      unsafeSidecar = `${unsafeDatabase}-journal`;
    await writeFile(unsafeDatabase, "");
    await p.protect(unsafeDatabase, false);
    await writeFile(unsafeSidecar, bytes);
    await security(
      `$p=${psLiteral(unsafeParent)};$a=[System.IO.Directory]::GetAccessControl($p);$r=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-1-0'),[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);$a.AddAccessRule($r);[System.IO.Directory]::SetAccessControl($p,$a)`,
    );
    await rejectUnchanged(unsafeDatabase, unsafeSidecar, /^unsafe executor DACL/);
    sidecarPassed = true;
    process.stdout.write(
      `${JSON.stringify({ phase: "sqlite-sidecar-eligibility", sameIdentityAndBytes: true, foreignAceRejectedUnchanged: true, hardlinkRejectedUnchanged: true, unsafeParentRejectedUnchanged: true })}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ phase: "actual-dacl", operation, elapsedMs: Math.round(performance.now() - started), protectedDirectoryAndFile: false, reason: error instanceof Error ? error.message : "unknown" })}\n`,
    );
  } finally {
    await rm(path, { recursive: true, force: true });
  }
  process.stdout.write(
    `${JSON.stringify({ phase: "normal-exit", controlledEofPassed, bclPassed, aclPassed, sidecarPassed, attributeReaderPassed })}\n`,
  );
  if (!controlledEofPassed || !bclPassed || !aclPassed || !sidecarPassed || !attributeReaderPassed)
    process.exitCode = 1;
}
