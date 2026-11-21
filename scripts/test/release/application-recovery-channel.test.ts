import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { ApplicationRecoveryBridge } from "../../../tests/clients/platform-recovery.ts";
import {
  attachApplicationRecoveryChannel,
  type InfrastructureObservationPort,
} from "../../application-recovery-channel.ts";
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
  observer?: InfrastructureObservationPort,
) {
  let channel: ReturnType<typeof attachApplicationRecoveryChannel> | undefined;
  const errors: Buffer[] = [];
  const result = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import {applicationRecoveryChannel,discoverApplicationRecoveryMode,infrastructureObservationChannel} from ${JSON.stringify(moduleUrl)};
    try { ${source} } finally { process.disconnect?.(); }
  `,
    ],
    repository,
    childEnvironment(),
    10000,
    false,
    (child) => {
      channel = attachApplicationRecoveryChannel(
        child,
        directory,
        coordinator,
        forbidden,
        observer,
      );
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
    import {applicationRecoveryChannel,discoverApplicationRecoveryMode,infrastructureObservationChannel} from ${JSON.stringify(moduleUrl)};
    try { applicationRecoveryChannel('perform'); throw Error('No channel required'); }
    catch(error) { if(!String(error).includes('Inherited application recovery channel required'))throw error; console.log('no-implicit-channel'); }
    try { await discoverApplicationRecoveryMode(); throw Error('Discovered without IPC'); }
    catch(error) { if(!String(error).includes('Inherited application recovery channel required'))throw error; }
    try { infrastructureObservationChannel(); throw Error('Observed without IPC'); }
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

test("one infrastructure read precedes recovery on the same IPC without changing discovery or phase IDs", async () => {
  for (const mode of ["perform", "verify-existing"] as const) {
    const calls: string[] = [];
    const unavailable = { status: "unavailable" as const, reason: "Transport fixture" };
    const result = await run(
      `
      assert.equal(await discoverApplicationRecoveryMode(), ${JSON.stringify(mode)});
      const observer=infrastructureObservationChannel();
      assert.deepEqual(await observer.read({requested:['inventory']}), {samples:[{bytes:17}]});
      await assert.rejects(observer.read(null), /already requested/);
      const bridge=applicationRecoveryChannel(${JSON.stringify(mode)});
      ${mode === "perform" ? `await bridge.perform(${JSON.stringify(before)});await bridge.finish(${JSON.stringify(after)});` : "await bridge.verifyExisting();"}
      console.log('observed-then-recovered');
    `,
      mode === "perform"
        ? {
            mode,
            bridge: {
              async perform(file) {
                assert.deepEqual(file, before);
                assert.deepEqual(calls, ["read"]);
                calls.push("perform");
                return unavailable;
              },
              async finish(file) {
                assert.deepEqual(file, after);
                calls.push("finish");
                return unavailable;
              },
            },
          }
        : {
            mode,
            bridge: {
              async verifyExisting() {
                assert.deepEqual(calls, ["read"]);
                calls.push("verifyExisting");
                return unavailable;
              },
            },
          },
      [],
      {
        async read(input) {
          assert.deepEqual(input, { requested: ["inventory"] });
          calls.push("read");
          return { samples: [{ bytes: 17 }] };
        },
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.rejection, "");
    assert.equal(result.stdout.trim(), "observed-then-recovered");
    assert.deepEqual(
      calls,
      mode === "perform" ? ["read", "perform", "finish"] : ["read", "verifyExisting"],
    );
  }
});

test("missing, repeated, unconfigured or malformed observation cannot admit a recovery phase", async () => {
  const read = {
    protocol: "fortipi-infrastructure-observation-v1",
    id: 1,
    method: "read",
    input: null,
  };
  for (const fault of [
    "missing",
    "repeated",
    "unconfigured",
    "unknown-protocol",
    "extra",
    "id",
    "method",
  ]) {
    let reads = 0,
      phases = 0;
    const result = await run(
      `
      const fault=${JSON.stringify(fault)};
      const request=${JSON.stringify(read)};
      const receive=()=>new Promise(accept=>process.once('message',accept));
      if(fault==='missing'){
        await assert.rejects(applicationRecoveryChannel('verify-existing').verifyExisting(), /response rejected/);
      }else{
        if(fault==='repeated')await infrastructureObservationChannel().read(null);
        if(fault==='unknown-protocol')request.protocol='unrecognized-observation-v1';
        if(fault==='extra')request.authority=true;
        if(fault==='id')request.id=2;
        if(fault==='method')request.method='write';
        const reply=receive();process.send(request);assert.equal((await reply).ok,false);
      }
      console.log('rejected');
    `,
      {
        mode: "verify-existing",
        bridge: {
          async verifyExisting() {
            phases++;
            throw Error("Unexpected recovery phase");
          },
        },
      },
      [],
      fault === "unconfigured"
        ? undefined
        : {
            async read() {
              reads++;
              return { samples: [] };
            },
          },
    );
    assert.equal(result.code, 0, `${fault}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), "rejected");
    assert.match(result.rejection, /channel rejected/, fault);
    assert.equal(phases, 0, fault);
    assert.equal(reads, fault === "repeated" ? 1 : 0, fault);
  }
});

test("an accepted but unfinished observation cannot start recovery", async () => {
  let channel: ReturnType<typeof attachApplicationRecoveryChannel> | undefined;
  let reads = 0,
    phases = 0;
  const result = await execute(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    const receive=()=>new Promise(accept=>process.once('message',accept));
    const entered=receive();
    process.send({protocol:'fortipi-infrastructure-observation-v1',id:1,method:'read',input:null});
    assert.deepEqual(await entered,{fixture:'observer-entered'});
    const denied=receive();
    process.send({protocol:'fortipi-application-recovery-v1',id:1,method:'verifyExisting',checkpoint:null});
    assert.deepEqual(await denied,{protocol:'fortipi-application-recovery-v1',id:1,ok:false});
    process.disconnect();
  `,
    ],
    repository,
    childEnvironment(),
    10000,
    false,
    (child) => {
      channel = attachApplicationRecoveryChannel(
        child,
        directory,
        {
          mode: "verify-existing",
          bridge: {
            async verifyExisting() {
              phases++;
              throw Error("Unexpected recovery phase");
            },
          },
        },
        [],
        {
          async read() {
            reads++;
            await new Promise<void>((accept) => {
              child.once("disconnect", accept);
              child.send?.({ fixture: "observer-entered" });
            });
            return { samples: [] };
          },
        },
      );
    },
  );
  assert.ok(channel);
  try {
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    await assert.rejects(channel.settled(), /channel rejected/);
    assert.equal(reads, 1);
    assert.equal(phases, 0);
  } finally {
    channel.close();
  }
});

test("observation responses use the existing bound and forbidden rules without crossing raw errors", async () => {
  const secret = 'synthetic-observation-quote"backslash\\newline\n-canary';
  for (const fault of ["throw", "secret", "oversize"]) {
    const result = await run(
      `
      const observer=infrastructureObservationChannel();
      await assert.rejects(observer.read({requested:['inventory']}), /response rejected/);
      await assert.rejects(observer.read(null), /already requested/);
      console.log('rejected');
    `,
      {
        mode: "verify-existing",
        bridge: {
          async verifyExisting() {
            throw Error("Unexpected recovery phase");
          },
        },
      },
      [secret],
      {
        async read() {
          if (fault === "throw") throw Error(secret);
          return { samples: fault === "secret" ? secret : "x".repeat(1_000_001) };
        },
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.rejection, /channel rejected/);
    assert.equal(result.stdout.trim(), "rejected");
    assert.equal(`${result.stdout}${result.stderr}${result.rejection}`.includes(secret), false);
  }
});

test("observation exchange accepts only its own protocol and closed response, then removes listeners", async () => {
  const valid = { protocol: "fortipi-infrastructure-observation-v1", id: 1, ok: true, value: [17] };
  for (const response of [
    valid,
    { ...valid, protocol: "fortipi-application-recovery-v1" },
    { ...valid, id: 2 },
    { ...valid, authority: true },
    { protocol: valid.protocol, id: 1, ok: true },
    { protocol: valid.protocol, id: 1, ok: false, error: "synthetic-private-error" },
  ]) {
    let request: unknown;
    const result = await execute(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import assert from 'node:assert/strict';
      import {infrastructureObservationChannel}from ${JSON.stringify(moduleUrl)};
      const counts=()=>[process.listenerCount('message'),process.listenerCount('disconnect')];
      const baseline=counts();const observer=infrastructureObservationChannel();
      ${response === valid ? "assert.deepEqual(await observer.read({requested:['inventory']}),[17]);" : "await assert.rejects(observer.read({requested:['inventory']}),/response rejected/);"}
      assert.deepEqual(counts(),baseline);
      console.log('clean');process.disconnect();
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
    assert.equal(result.stdout.trim(), "clean");
    assert.deepEqual(request, {
      protocol: valid.protocol,
      id: 1,
      method: "read",
      input: { requested: ["inventory"] },
    });
  }
});
