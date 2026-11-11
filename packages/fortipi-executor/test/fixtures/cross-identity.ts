import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Profile } from "../../dist/config.js";
import {
  adapter,
  defaults,
  loadProfile,
  privateWrite,
  secureDirectory,
} from "../../dist/config.js";
import { Ledger } from "../../dist/ledger.js";
import {
  powershellArgs,
  verifyWindowsSqliteSidecar,
  windowsUtilityEnvironment,
} from "../../dist/platform/windows.js";
import { disabledPolicy } from "../../dist/policy.js";

// No local privilege escalation, self-hosted machines, or operator credential files.
// https://docs.github.com/en/actions/reference/workflows-and-actions/variables
assert.equal(process.env.GITHUB_ACTIONS, "true", "hosted CI only");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "disposable hosted CI only");
assert.equal(process.env.GITHUB_JOB, "native-executor", "native CI job only");
assert.equal(process.env.GITHUB_REPOSITORY, "scottdraper8/fortipi", "FortiPi CI only");
const runnerOs: Partial<Record<NodeJS.Platform, string>> = {
  linux: "Linux",
  darwin: "macOS",
  win32: "Windows",
};
assert.ok(runnerOs[process.platform], "supported native runner required");
assert.equal(process.env.RUNNER_OS, runnerOs[process.platform], "actual native runner required");

const execute = promisify(execFile);
const environment =
  process.platform === "win32" ? windowsUtilityEnvironment() : { PATH: "/usr/bin:/bin" };
async function run(command: string, args: string[], timeout = 20000): Promise<string> {
  const pending = execute(command, args, {
    env: environment,
    cwd: root,
    timeout,
    maxBuffer: 16384,
  });
  pending.child.stdin?.on("error", () => {});
  pending.child.stdin?.end();
  try {
    return (await pending).stdout.trim();
  } catch (error) {
    // Never forward execFile's command/output-bearing Error (including credentials or file bytes).
    const e = error as { code?: string | number; killed?: boolean; stderr?: string };
    // Windows PowerShell may wrap stderr in CLIXML. Extract ONLY our fixed categories,
    // never the XML, command, exception messages, paths, environment or credential bytes.
    const stage = e.stderr?.match(
      /cross-identity Windows stage=(?:load-account-api|create-context|find-account|create-account|group-membership|resolve-identity|baseline|permission-fault|restored) native=-?[0-9]{1,10} detail=(?:none|identity|public-control|file-open|child-runtime) type=[A-Za-z0-9_]+ hresult=-?[0-9]{1,10}/,
    )?.[0];
    const control = e.stderr?.match(
      /unprivileged identity control failed|public read control failed|unexpected file-open failure/,
    )?.[0];
    const launch = /sudo: unable to execute [^\r\n]*: Permission denied/.test(e.stderr ?? "")
      ? "sudo execute denied"
      : undefined;
    const parser = /ParserError/.test(e.stderr ?? "") ? "PowerShell parser failure" : undefined;
    throw new Error(
      `cross-identity child failed: code=${e.code ?? "unknown"}, timedOut=${e.killed === true}${[
        stage,
        control,
        launch,
        parser,
      ]
        .filter(Boolean)
        .map((s) => `; ${s}`)
        .join("")}`,
    );
  }
}
const ps = (script: string, timeout = 20000) =>
  run(
    win32.join(environment.SystemRoot ?? "", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    powershellArgs(`$ErrorActionPreference='Stop';${script}`),
    timeout,
  );
const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;

// Child code is inline so the unprivileged user need not traverse the checkout.
// Paths and a PUBLIC nonce only: no profile token or account password in arguments/environment.
function worker(spec: object): string {
  return `
const fs = require('node:fs');
const cp = require('node:child_process');
const spec = ${JSON.stringify(spec)};
let identity = false;
if (process.platform === 'win32') {
  const whoami = spec.whoami;
  const opts = {timeout:5000, maxBuffer:8192, encoding:'utf8', windowsHide:true};
  const user = cp.execFileSync(whoami, ['/user','/fo','csv','/nh'], opts);
  const groups = cp.execFileSync(whoami, ['/groups','/fo','csv','/nh'], opts);
  const sids = groups.match(/S-1-[0-9-]+/g) || [];
  identity = user.includes('"' + spec.expectedSid + '"') && !user.includes('"' + spec.ownerSid + '"') &&
    sids.includes('S-1-5-32-545') && !sids.includes('S-1-5-32-544') &&
    !sids.some(s => ['S-1-5-18','S-1-16-12288','S-1-16-16384'].includes(s));
} else {
  identity = process.getuid() === spec.uid && process.geteuid() === spec.uid &&
    spec.uid !== 0 && spec.uid !== spec.ownerUid && !process.getgroups().includes(0);
}
if (!identity) throw Error('unprivileged identity control failed');
if (fs.readFileSync(spec.control, 'utf8') !== spec.nonce) throw Error('public read control failed');
const cases = spec.targets.map(t => {
  try {
    if (t.directory) fs.readdirSync(t.path);
    else {
      const fd = fs.openSync(t.path, 'r');
      try { fs.readSync(fd, Buffer.alloc(1), 0, 1, 0); } finally { fs.closeSync(fd); }
    }
    return {id:t.id, result:'readable'};
  } catch(e) {
    if (e.code !== 'EACCES' && e.code !== 'EPERM') throw Error('unexpected file-open failure');
    return {id:t.id, result:e.code};
  }
});
process.stdout.write(JSON.stringify({identity:true, controlReadable:true, cases}));
`;
}
interface Observation {
  identity: boolean;
  controlReadable: boolean;
  cases: { id: string; result: string }[];
}
function check(raw: string, weakened = false): Observation {
  const result = JSON.parse(raw) as Observation;
  assert.equal(result.identity, true);
  assert.equal(result.controlReadable, true);
  assert.deepEqual(
    result.cases.map((c) => c.id),
    ["directory", "profile", "sqlite", "journal", "exported-profile"],
  );
  for (const c of result.cases)
    if (weakened && c.id === "exported-profile")
      assert.equal(c.result, "readable", "permission fault must be detected");
    else
      assert.ok(
        ["EACCES", "EPERM"].includes(c.result),
        `${c.id}: actual permission denial required`,
      );
  return result;
}

const platform = adapter();
// macOS os.tmpdir() has private ancestry: /tmp supplies an independent readable control.
const parent = process.platform === "win32" ? join(environment.SystemRoot ?? "", "Temp") : "/tmp";
const root = await realpath(await mkdtemp(join(parent, "fortipi-cross-identity-")));
let observation: Observation | undefined;
try {
  if (process.platform === "win32") {
    // Only our synthetic public lab gets Users read/traverse, never the product directory.
    await ps(
      `$p=${literal(root)};$a=[System.Security.AccessControl.DirectorySecurity]::new();$me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$a.SetOwner($me);$a.SetAccessRuleProtection($true,$false);foreach($sid in @($me.Value,'S-1-5-18','S-1-5-32-545')){$rights=if($sid -eq 'S-1-5-32-545'){'ReadAndExecute'}else{'FullControl'};$a.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($sid),$rights,'ContainerInherit,ObjectInherit','None','Allow'))};[System.IO.Directory]::SetAccessControl($p,$a)`,
    );
  } else await chmod(root, 0o755);
  let executable = process.execPath;
  if (process.platform !== "win32") {
    // Hosted macOS's Node can live below the runner's private home. Copy ONLY the
    // actual public executable into our public lab; do not change that home's ACL.
    executable = join(root, "node");
    await copyFile(process.execPath, executable);
    await chmod(executable, 0o755);
    const digest = async (path: string) => {
      const sha = createHash("sha256");
      for await (const bytes of createReadStream(path)) sha.update(bytes);
      return sha.digest("hex");
    };
    assert.equal(
      await digest(executable),
      await digest(process.execPath),
      "public probe executable must be byte-identical",
    );
  }
  const directory = join(root, "state");
  await secureDirectory(directory);
  const profile = join(directory, "profile.json");
  const exported = join(root, "exported-profile.json");
  // Synthetic owned profile bytes, never an existing user's config or credentials.
  const data: Profile = {
    version: 1,
    token: randomBytes(32).toString("hex"),
    executorId: "synthetic",
    executorGeneration: 1,
    origin: "https://cross-identity.invalid",
    deploymentId: "synthetic",
    credential: { credentialId: "synthetic", generation: 1, grantVersion: 1 },
    ledgerId: "ledger",
    bindings: [],
    resources: {
      agentIds: [],
      conversationIds: [],
      workspaceIds: [],
      actions: [],
      tools: [],
      executorIds: [],
      backendIds: [],
    },
    policy: disabledPolicy,
    limits: {},
  };
  await privateWrite(profile, JSON.stringify(data));
  await loadProfile(profile);
  await privateWrite(join(directory, "exported-profile.json"), JSON.stringify(data));
  await rename(join(directory, "exported-profile.json"), exported);
  const ledger = await Ledger.provision(directory, "ledger", defaults);
  ledger.db.prepare("INSERT INTO meta(key,value) VALUES('durable_canary','before')").run();
  const database = ledger.path;
  ledger.close();
  const crash = execute(
    process.execPath,
    [fileURLToPath(new URL("./daemon.ts", import.meta.url)), "journal-crash", directory],
    {
      env: environment,
      timeout: 30000,
      maxBuffer: 16384,
    },
  );
  crash.child.stdin?.end();
  let crashed = false;
  try {
    await crash;
  } catch (error) {
    crashed = (error as { code?: number }).code === 74;
  }
  assert.equal(crashed, true, "actual SQLite crash fixture must leave its hot journal");
  const journal = `${database}-journal`;
  if (process.platform === "win32") await verifyWindowsSqliteSidecar(database, "-journal");
  else await platform.verifyProtection(journal, false);
  const control = join(root, "public-control");
  const nonce = randomBytes(24).toString("hex");
  await writeFile(control, nonce, { mode: 0o644, flag: "wx" });
  const targets = [
    { id: "directory", path: directory, directory: true },
    { id: "profile", path: profile },
    { id: "sqlite", path: database },
    { id: "journal", path: journal },
    { id: "exported-profile", path: exported },
  ];
  // Owner opens every existing target with all SQLite handles CLOSED. Missing files or locks
  // cannot count as other-user permission denial. Never print any bytes.
  assert.ok((await readdir(directory)).length > 0);
  for (const t of targets.filter((t) => !t.directory)) {
    const fd = await open(t.path, "r");
    try {
      assert.equal((await fd.read(Buffer.alloc(1), 0, 1, 0)).bytesRead, 1);
    } finally {
      await fd.close();
    }
  }
  let baseline: Observation;
  if (process.platform !== "win32") {
    const reportedUid = Number(await run("/usr/bin/id", ["-u", "nobody"]));
    assert.ok(
      Number.isSafeInteger(reportedUid) && reportedUid >= -2147483648 && reportedUid <= 4294967295,
    );
    const uid = reportedUid >>> 0; // macOS may print nobody's uid_t as signed -2.
    assert.ok(Number.isSafeInteger(uid) && uid > 0 && uid !== process.getuid?.());
    const code = worker({ uid, ownerUid: process.getuid?.(), control, nonce, targets });
    const probe = () => run("/usr/bin/sudo", ["-n", "-u", "nobody", "--", executable, "-e", code]);
    baseline = check(await probe());
    try {
      await chmod(exported, 0o644);
      check(await probe(), true);
    } finally {
      await chmod(exported, 0o600);
    }
    check(await probe());
  } else {
    // .NET Framework BCL avoids module autoload/name translation and external password argv.
    // https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.processstartinfo.password
    // https://learn.microsoft.com/en-us/dotnet/api/system.directoryservices.accountmanagement.userprincipal
    const code = worker({
      control,
      nonce,
      targets,
      expectedSid: "__EXPECTED_SID__",
      ownerSid: "__OWNER_SID__",
      whoami: win32.join(environment.SystemRoot ?? "", "System32/whoami.exe"),
    });
    const script = `
$ctx=$null;$account=$null;$users=$null;$admins=$null;$secret=$null;$rng=$null;$created=$false;$ok=$false;$stage='load-account-api';$cleanup=$true;$saved=$null;$detail='none'
try {
  [void][System.Reflection.Assembly]::Load('System.DirectoryServices.AccountManagement, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
  $stage='create-context'
  $ctx=[System.DirectoryServices.AccountManagement.PrincipalContext]::new([System.DirectoryServices.AccountManagement.ContextType]::Machine)
  $name='fpi'+[Guid]::NewGuid().ToString('N').Substring(0,12)
  $stage='find-account'
  $existing=[System.DirectoryServices.AccountManagement.UserPrincipal]::FindByIdentity($ctx,$name)
  if($null -ne $existing){$existing.Dispose();throw 'account collision'}
  $rng=[System.Security.Cryptography.RandomNumberGenerator]::Create();$bytes=[byte[]]::new(32);$rng.GetBytes($bytes)
  $password=[Convert]::ToBase64String($bytes)+'Aa1!';[Array]::Clear($bytes,0,$bytes.Length)
  $secret=[System.Security.SecureString]::new();foreach($ch in $password.ToCharArray()){$secret.AppendChar($ch)};$secret.MakeReadOnly()
  $stage='create-account'
  $account=[System.DirectoryServices.AccountManagement.UserPrincipal]::new($ctx);$account.SamAccountName=$name;$account.Name=$name;$account.SetPassword($password);$password=$null;$account.Enabled=$true;$account.Save();$created=$true
  $stage='group-membership'
  $users=[System.DirectoryServices.AccountManagement.GroupPrincipal]::FindByIdentity($ctx,[System.DirectoryServices.AccountManagement.IdentityType]::Sid,'S-1-5-32-545');if(!$users.Members.Contains($account)){$users.Members.Add($account);$users.Save()}
  $admins=[System.DirectoryServices.AccountManagement.GroupPrincipal]::FindByIdentity($ctx,[System.DirectoryServices.AccountManagement.IdentityType]::Sid,'S-1-5-32-544');if($admins.Members.Contains($account)){throw 'privileged test account'}
  $stage='resolve-identity'
  $source=[System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(code).toString("base64")}')).Replace('__EXPECTED_SID__',$account.Sid.Value).Replace('__OWNER_SID__',[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
  $source64=[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($source))
  function Probe {
    $p=[System.Diagnostics.Process]::new()
    try {
      $p.StartInfo.FileName=${literal(process.execPath)};$p.StartInfo.Arguments='-e "eval(Buffer.from(process.argv[1],process.argv[2]).toString())" '+$source64+' base64'
      $p.StartInfo.UserName=$name;$p.StartInfo.Domain='.';$p.StartInfo.Password=$secret;$p.StartInfo.UseShellExecute=$false;$p.StartInfo.LoadUserProfile=$false;$p.StartInfo.WorkingDirectory=${literal(root)}
      $p.StartInfo.RedirectStandardOutput=$true;$p.StartInfo.RedirectStandardError=$true;$p.StartInfo.CreateNoWindow=$true
      $p.StartInfo.EnvironmentVariables.Clear();$p.StartInfo.EnvironmentVariables['SystemRoot']=${literal(environment.SystemRoot ?? "")};$p.StartInfo.EnvironmentVariables['WINDIR']=${literal(environment.SystemRoot ?? "")};$p.StartInfo.EnvironmentVariables['PATH']=${literal(environment.PATH ?? "")};$p.StartInfo.EnvironmentVariables['TEMP']=${literal(root)};$p.StartInfo.EnvironmentVariables['TMP']=${literal(root)}
      [void]$p.Start();$out=$p.StandardOutput.ReadToEndAsync();$err=$p.StandardError.ReadToEndAsync()
      if(!$p.WaitForExit(15000)){$p.Kill();$p.WaitForExit();throw 'child deadline'}
      $text=$out.GetAwaiter().GetResult();$stderr=$err.GetAwaiter().GetResult();if($p.ExitCode -ne 0 -or $text.Length -gt 16384){$script:detail='child-runtime';if($stderr.Contains('unprivileged identity control failed')){$script:detail='identity'};if($stderr.Contains('public read control failed')){$script:detail='public-control'};if($stderr.Contains('unexpected file-open failure')){$script:detail='file-open'};throw 'child control failed'}
      return $text
    } finally { $p.Dispose() }
  }
  $stage='baseline';$baseline=Probe
  $stage='permission-fault';$path=${literal(exported)};$saved=[System.IO.File]::GetAccessControl($path)
  try {$wide=[System.IO.File]::GetAccessControl($path);$wide.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'),'Read','Allow'));[System.IO.File]::SetAccessControl($path,$wide);$weakened=Probe}
  finally {[System.IO.File]::SetAccessControl($path,$saved);$saved=$null}
  $stage='restored';$restored=Probe;$ok=$true
} catch { $native=0;$failure=$_.Exception;$kind=$failure.GetType().Name;$hresult=$failure.HResult;while($null -ne $failure){if($failure -is [System.ComponentModel.Win32Exception]){$native=$failure.NativeErrorCode};$failure=$failure.InnerException};[Console]::Error.Write('cross-identity Windows stage='+$stage+' native='+$native+' detail='+$detail+' type='+$kind+' hresult='+$hresult) }
finally {
  if($null -ne $saved){try{[System.IO.File]::SetAccessControl(${literal(exported)},$saved)}catch{$cleanup=$false}}
  if($created){try{$account.Delete();$remaining=[System.DirectoryServices.AccountManagement.UserPrincipal]::FindByIdentity($ctx,$name);if($null -ne $remaining){$remaining.Dispose();$cleanup=$false}}catch{$cleanup=$false}}
  foreach($resource in @($secret,$account,$users,$admins,$ctx,$rng)){if($null -ne $resource){try{$resource.Dispose()}catch{$cleanup=$false}}}
}
if(!$ok -or !$cleanup){exit 1}
[Console]::Out.Write('{"accountCleanup":true,"baseline":'+$baseline+',"weakened":'+$weakened+',"restored":'+$restored+'}')
`;
    const result = JSON.parse(await ps(script, 60000)) as {
      accountCleanup: boolean;
      baseline: Observation;
      weakened: Observation;
      restored: Observation;
    };
    assert.equal(result.accountCleanup, true);
    baseline = check(JSON.stringify(result.baseline));
    check(JSON.stringify(result.weakened), true);
    check(JSON.stringify(result.restored));
  }
  observation = baseline;
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    phase: "cross-identity",
    platform: process.platform,
    ...observation,
    permissionFaultDetected: true,
    restoredDenial: true,
    cleanup: true,
  }),
);
