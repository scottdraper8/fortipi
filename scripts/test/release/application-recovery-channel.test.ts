import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ApplicationRecoveryBridge } from "../../../tests/clients/platform-recovery.ts";
import { attachApplicationRecoveryChannel } from "../../application-recovery-channel.ts";
import { repository } from "../../build-workspaces.ts";
import { childEnvironment, execute } from "../../prepare-release.ts";
import { sha256 } from "../../verify-release-gates.ts";

const directory = resolve(repository, ".agent-docs/tmp/recovery-channel-fixture");
const before = {
  path: resolve(directory, "application-before.json"),
  size: 2,
  mode: 0o600,
  sha256: sha256("{}"),
};
const after = { ...before, path: resolve(directory, "application-after.json") };
const moduleUrl = pathToFileURL(
  resolve(repository, "scripts/application-recovery-channel.ts"),
).href;
async function run(
  source: string,
  coordinator: Parameters<typeof attachApplicationRecoveryChannel>[2],
  forbidden: string[] = [],
) {
  let channel: ReturnType<typeof attachApplicationRecoveryChannel> | undefined;
  const errors: Buffer[] = [];
  const result = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {applicationRecoveryChannel,discoverApplicationRecoveryMode} from ${JSON.stringify(moduleUrl)};
    try { ${source} } finally { process.disconnect?.(); }
  `,
    ],
    repository,
    childEnvironment(),
    10000,
    false,
    (child) => {
      channel = attachApplicationRecoveryChannel(child, directory, coordinator, forbidden);
      assert.ok(child.stderr);
      child.stderr.on("data", (bytes) => errors.push(Buffer.from(bytes)));
    },
  );
  assert.ok(channel);
  try {
    let rejection = "";
    try {
      await channel.settled();
    } catch (error) {
      rejection = String(error);
    }
    return {
      code: result.code,
      stdout: result.stdout,
      stderr: Buffer.concat(errors).toString(),
      rejection,
    };
  } finally {
    channel.close();
  }
}

test("inherited IPC carries only the bound before/after records, in order, without granting recovery qualification", async () => {
  const calls: string[] = [];
  const bridge: ApplicationRecoveryBridge = {
    async perform(file) {
      assert.deepEqual(file, before);
      calls.push("before");
      return { status: "unavailable", reason: "Transport fixture; no provider operation" };
    },
    async finish(file) {
      assert.deepEqual(file, after);
      calls.push("after");
      return { status: "unavailable", reason: "Transport fixture; no application proof" };
    },
  };
  const result = await run(
    `
    const bridge=applicationRecoveryChannel('perform');
    const first=await bridge.perform(${JSON.stringify(before)});
    const second=await bridge.finish(${JSON.stringify(after)});
    console.log(JSON.stringify({statuses:[first.status,second.status],github:!!process.env.GITHUB_TOKEN,cloudflare:!!process.env.CLOUDFLARE_API_TOKEN,npm:!!process.env.NPM_TOKEN}));
  `,
    { mode: "perform", bridge },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.rejection, "");
  assert.deepEqual(calls, ["before", "after"]);
  assert.deepEqual(JSON.parse(result.stdout), {
    statuses: ["unavailable", "unavailable"],
    github: false,
    cloudflare: false,
    npm: false,
  });
  const readonly = await run(
    `
    const result=await applicationRecoveryChannel('verify-existing').verifyExisting();
    console.log(result.status);
  `,
    {
      mode: "verify-existing",
      bridge: {
        async verifyExisting() {
          calls.push("read-only");
          return { status: "unavailable", reason: "Transport fixture; no retained lineage" };
        },
      },
    },
  );
  assert.equal(readonly.code, 0, readonly.stderr);
  assert.equal(readonly.rejection, "");
  assert.equal(readonly.stdout.trim(), "unavailable");
  assert.deepEqual(calls, ["before", "after", "read-only"]);
});

test("wrong checkpoint paths and read-only channel writes fail before a trusted handler runs", async () => {
  const unattached = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {applicationRecoveryChannel,discoverApplicationRecoveryMode} from ${JSON.stringify(moduleUrl)};
    try { applicationRecoveryChannel('perform'); throw Error('No channel required'); }
    catch(error) { if(!String(error).includes('Inherited application recovery channel required'))throw error; console.log('no-implicit-channel'); }
    try { await discoverApplicationRecoveryMode(); throw Error('Discovered without IPC'); }
    catch(error) { if(!String(error).includes('Inherited application recovery channel required'))throw error; }
  `,
    ],
    repository,
    childEnvironment({ FORTIPI_RECOVERY_MODE: "perform" }),
  );
  assert.equal(unattached.code, 0);
  assert.equal(unattached.stdout.trim(), "no-implicit-channel");
  let calls = 0;
  const bridge: ApplicationRecoveryBridge = {
    async perform() {
      calls++;
      throw new Error("Unexpected provider call");
    },
    async finish() {
      calls++;
      throw new Error("Unexpected finish call");
    },
  };
  const escaped = await run(
    `
    try { await applicationRecoveryChannel('perform').perform(${JSON.stringify({ ...before, path: resolve(directory, "../foreign.json") })}); throw Error('Accepted escape'); }
    catch(error) { if(!String(error).includes('response rejected'))throw error; console.log('rejected'); }
  `,
    { mode: "perform", bridge },
  );
  assert.equal(escaped.code, 0, escaped.stderr);
  assert.match(escaped.rejection, /channel rejected/);
  const readonly = await run(
    `
    try { await applicationRecoveryChannel('perform').perform(${JSON.stringify(before)}); throw Error('Accepted provider write'); }
    catch(error) { if(!String(error).includes('response rejected'))throw error; console.log('rejected'); }
  `,
    {
      mode: "verify-existing",
      bridge: {
        async verifyExisting() {
          calls++;
          throw new Error("Unexpected verify");
        },
      },
    },
  );
  assert.equal(readonly.code, 0, readonly.stderr);
  assert.match(readonly.rejection, /channel rejected/);
  assert.equal(calls, 0);
});

test("one-shot discovery selects only the attached parent's mode and leaves phase IDs unchanged", async () => {
  const calls: string[] = [];
  const perform = await run(
    `
    process.env.FORTIPI_RECOVERY_MODE='verify-existing';
    const mode=await discoverApplicationRecoveryMode();
    if(mode!=='perform')throw Error('Wrong attached mode');
    const bridge=applicationRecoveryChannel(mode);
    await bridge.perform(${JSON.stringify(before)});await bridge.finish(${JSON.stringify(after)});
    try { await discoverApplicationRecoveryMode(); throw Error('Repeated discovery'); }
    catch(error) { if(!String(error).includes('discovery already requested'))throw error; }
    console.log(mode);
  `,
    {
      mode: "perform",
      bridge: {
        async perform(file) {
          assert.deepEqual(file, before);
          calls.push("before");
          return { status: "unavailable", reason: "Transport fixture" };
        },
        async finish(file) {
          assert.deepEqual(file, after);
          calls.push("after");
          return { status: "unavailable", reason: "Transport fixture" };
        },
      },
    },
  );
  assert.equal(perform.code, 0, perform.stderr);
  assert.equal(perform.rejection, "");
  assert.equal(perform.stdout.trim(), "perform");
  const readonly = await run(
    `
    process.env.FORTIPI_RECOVERY_MODE='perform';
    const mode=await discoverApplicationRecoveryMode();
    if(mode!=='verify-existing')throw Error('Wrong attached mode');
    await applicationRecoveryChannel(mode).verifyExisting();console.log(mode);
  `,
    {
      mode: "verify-existing",
      bridge: {
        async verifyExisting() {
          calls.push("read-only");
          return { status: "unavailable", reason: "Transport fixture" };
        },
      },
    },
  );
  assert.equal(readonly.code, 0, readonly.stderr);
  assert.equal(readonly.rejection, "");
  assert.equal(readonly.stdout.trim(), "verify-existing");
  assert.deepEqual(calls, ["before", "after", "read-only"]);
});

test("forged, replayed and late discovery or a mismatched bridge cannot change parent authority", async () => {
  const discovery = {
    protocol: "fortipi-application-recovery-v1",
    id: 0,
    method: "discover",
    checkpoint: null,
  };
  for (const fault of ["forged", "replay", "late", "mismatch"]) {
    let calls = 0;
    const coordinator: Parameters<typeof attachApplicationRecoveryChannel>[2] =
      fault === "late"
        ? {
            mode: "perform",
            bridge: {
              async perform() {
                calls++;
                return { status: "unavailable", reason: "Transport fixture" };
              },
              async finish() {
                calls++;
                throw Error("Unexpected finish");
              },
            },
          }
        : {
            mode: "verify-existing",
            bridge: {
              async verifyExisting() {
                calls++;
                throw Error("Unexpected handler");
              },
            },
          };
    const result = await run(
      `
      const fault=${JSON.stringify(fault)};
      if(fault==='replay'||fault==='mismatch')await discoverApplicationRecoveryMode();
      if(fault==='late')await applicationRecoveryChannel('perform').perform(${JSON.stringify(before)});
      if(fault==='mismatch'){
        try { await applicationRecoveryChannel('perform').perform(${JSON.stringify(before)});throw Error('Accepted mismatched mode'); }
        catch(error){if(!String(error).includes('response rejected'))throw error;}
      }else{
        const request=${JSON.stringify(discovery)};
        if(fault==='forged')request.mode='perform';
        const response=await new Promise(accept=>{process.once('message',accept);process.send(request);});
        if(response.ok!==false||response.id!==0)throw Error('Accepted invalid discovery');
      }
      console.log('rejected');
    `,
      coordinator,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "rejected");
    assert.match(result.rejection, /channel rejected/);
    assert.equal(calls, fault === "late" ? 1 : 0);
  }
});

test("discovery rejects malformed parent replies and cleans its listeners and timer", async () => {
  const valid = { protocol: "fortipi-application-recovery-v1", id: 0, ok: true, mode: "perform" };
  for (const response of [
    { ...valid, protocol: "forged" },
    { ...valid, id: 1 },
    { ...valid, mode: "local" },
    { ...valid, authority: true },
  ]) {
    let request: unknown;
    const result = await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {discoverApplicationRecoveryMode}from ${JSON.stringify(moduleUrl)};
      const counts=()=>[process.listenerCount('message'),process.listenerCount('disconnect')];const baseline=JSON.stringify(counts());
      try{await discoverApplicationRecoveryMode();throw Error('Accepted malformed discovery');}
      catch(error){if(!String(error).includes('response rejected'))throw error;}
      if(JSON.stringify(counts())!==baseline)throw Error('Discovery listeners leaked');
      console.log('rejected-and-clean');process.disconnect();
    `,
      ],
      repository,
      childEnvironment(),
      10000,
      false,
      (child) => {
        child.once("message", (value) => {
          request = value;
          child.send?.(response);
        });
      },
    );
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    assert.equal(result.stdout.trim(), "rejected-and-clean");
    assert.deepEqual(request, {
      protocol: "fortipi-application-recovery-v1",
      id: 0,
      method: "discover",
      checkpoint: null,
    });
  }
});

test("actual live CLI discovers inherited recovery before candidate setup without skipping authentication", {
  timeout: 30000,
}, async () => {
  const out = resolve(repository, ".agent-docs/tmp/recovery-mode-cli-fixture");
  for (const mode of ["perform", "verify-existing"] as const) {
    let discoveries = 0,
      calls = 0;
    let channel: ReturnType<typeof attachApplicationRecoveryChannel> | undefined;
    const result = await execute(
      process.execPath,
      [
        "tests/clients/run-evidence.ts",
        "live",
        "--candidate",
        resolve(out, "missing-candidate.json"),
        "--fixture",
        resolve(repository, "tests/clients/fixtures/local.json"),
        "--out",
        out,
      ],
      repository,
      childEnvironment(),
      10000,
      false,
      (child) => {
        const coordinator: Parameters<typeof attachApplicationRecoveryChannel>[2] =
          mode === "perform"
            ? {
                mode,
                bridge: {
                  async perform() {
                    calls++;
                    throw Error("Candidate authentication must precede effects");
                  },
                  async finish() {
                    calls++;
                    throw Error("Unexpected finish");
                  },
                },
              }
            : {
                mode,
                bridge: {
                  async verifyExisting() {
                    calls++;
                    throw Error("Candidate authentication must precede reads");
                  },
                },
              };
        channel = attachApplicationRecoveryChannel(
          child,
          resolve(out, "application-recovery"),
          coordinator,
        );
        child.on("message", (value) => {
          if (
            value &&
            typeof value === "object" &&
            "method" in value &&
            value.method === "discover"
          )
            discoveries++;
        });
      },
    );
    assert.ok(channel);
    try {
      assert.equal(result.code, 1);
      assert.equal(result.timedOut, false);
      assert.equal(discoveries, 1);
      assert.equal(calls, 0);
      await assert.rejects(channel.settled(), /Application recovery incomplete/);
    } finally {
      channel.close();
    }
  }
});

test("provider errors and accidentally credential-bearing replies stay in the trusted process", async () => {
  for (const secret of [
    "synthetic-private-cloudflare-canary-value",
    'synthetic-quote"and-backslash\\-newline\n-canary',
  ])
    for (const throws of [false, true]) {
      const result = await run(
        `
      try { await applicationRecoveryChannel('perform').perform(${JSON.stringify(before)}); throw Error('Leaked response'); }
      catch(error) { if(!String(error).includes('response rejected'))throw error; console.log(String(error)); }
    `,
        {
          mode: "perform",
          bridge: {
            async perform() {
              if (throws) throw new Error(secret);
              return { status: "unavailable", reason: secret };
            },
            async finish() {
              throw new Error("Unexpected finish");
            },
          },
        },
        [secret],
      );
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.rejection, /channel rejected/);
      assert.equal(`${result.stdout}${result.stderr}${result.rejection}`.includes(secret), false);
    }
});
