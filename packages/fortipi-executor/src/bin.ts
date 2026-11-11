#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Approvals } from "./approval.js";
import { adapter, effectiveLimits, loadProfile, privateWrite, stateHome } from "./config.js";
import { runDaemon } from "./daemon.js";
import { Guard, Ledger, ledgerRegistryIdentity, rootRegistry } from "./ledger.js";
import { HttpTransport } from "./transport.js";
import { LocalWorkspace } from "./workspace/local.js";
import { SafeRoot } from "./workspace/paths.js";
import { Staging } from "./workspace/staging.js";

export async function main(args = process.argv.slice(2)): Promise<void> {
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const profilePath = value("--profile");
  if (!profilePath)
    throw new Error(
      "Usage: fortipi-executor <init|import|start|status|policy|approvals|approve|reject> --profile <protected-profile.json>",
    );
  const local = args.includes("--local-test");
  const platform = adapter(),
    profile = await loadProfile(resolve(profilePath), platform, local),
    directory = join(dirname(resolve(profilePath)), profile.ledgerId);
  const command = args[0];
  if (command === "init") {
    const guards = await rootRegistry(
      join(stateHome(), "roots"),
      [],
      platform,
      ledgerRegistryIdentity(profile, directory, "provision"),
    );
    for (const guard of guards) guard.close();
    const ledger = await Ledger.provision(
      directory,
      profile.ledgerId,
      effectiveLimits(profile.limits),
      platform,
    );
    ledger.close();
    process.stdout.write(
      "Executor ledger provisioned. Native shell remains disabled until trusted-host consent.\n",
    );
    return;
  }
  if (command === "start") {
    const controller = new AbortController(),
      stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runDaemon(
        profile,
        directory,
        controller.signal,
        () => loadProfile(resolve(profilePath), platform, local),
        local,
      );
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }
  if (command === "policy") {
    if (args.includes("--trusted-host")) {
      if (!args.includes("--accept-daemon-user-files-and-network"))
        throw new Error(
          "Trusted host commands run as your OS user, can access files outside cwd and the network. Supply --accept-daemon-user-files-and-network to persist consent.",
        );
      profile.policy = {
        ...profile.policy,
        version: profile.policy.version + 1,
        trustedHost: true,
        consent: {
          acceptedAt: Date.now(),
          osUser: userInfo().username,
          disclosure: "daemon-user-files-and-network",
        },
      };
      await privateWrite(resolve(profilePath), JSON.stringify(profile), platform);
    } else if (args.includes("--disable")) {
      profile.policy = {
        ...profile.policy,
        version: profile.policy.version + 1,
        trustedHost: false,
      };
      await privateWrite(resolve(profilePath), JSON.stringify(profile), platform);
    }
    process.stdout.write(
      `${JSON.stringify({ confinement: "host", policy: profile.policy, disclosure: "Commands can access files outside cwd and network as the daemon OS user." })}\n`,
    );
    return;
  }
  const ledger = await Ledger.open(
    directory,
    profile.ledgerId,
    effectiveLimits(profile.limits),
    platform,
  );
  try {
    if (command === "import") {
      const binding = profile.bindings.find(
        (b) => b.rootBindingId === value("--root-binding-id") && b.providerKind === "local",
      );
      if (!binding) throw new Error("local --root-binding-id required");
      const root = await SafeRoot.open(binding.path, platform),
        staging = new Staging(
          join(directory, "staging"),
          ledger,
          new HttpTransport(profile, fetch, local),
        );
      await staging.initialize();
      const workspace = new LocalWorkspace(root, binding, profile, ledger, staging);
      const proposal = workspace.importProposal(value("--request-id") ?? randomUUID()),
        approve = value("--approve");
      if (!approve) {
        process.stdout.write(
          `${JSON.stringify({ proposal, disclosure: "Approve this exact root identity/revision/manifest/binding version to import local metadata." })}\n`,
        );
        return;
      }
      if (!value("--request-id") || approve !== proposal.approvalDigest)
        throw new Error("exact --request-id and --approve from import proposal required");
      const guards = await rootRegistry(
        join(stateHome(), "roots"),
        [{ key: root.key, ledgerId: profile.ledgerId, ledgerPath: directory }],
        platform,
        ledgerRegistryIdentity(profile, directory, "bind"),
      );
      try {
        guards.push(await Guard.acquire(join(directory, "daemon.guard.sqlite"), platform));
        const receipt = await workspace.importBinding(proposal);
        process.stdout.write(`${JSON.stringify(receipt)}\n`);
      } finally {
        for (const guard of guards.reverse()) guard.close();
      }
      return;
    }
    const approvals = new Approvals(ledger);
    if (command === "approvals" && args[1] === "list") {
      process.stdout.write(`${JSON.stringify(approvals.list())}\n`);
      return;
    }
    if (command === "approve" || command === "reject") {
      const job = args[1],
        digest = value("--digest");
      if (!job || !digest)
        throw new Error("jobId and exact --digest from approvals list are required");
      approvals.decide(job, digest, command === "approve" ? "allow" : "deny");
      process.stdout.write(
        "Local decision persisted; execution still requires current remote authority and exact policy.\n",
      );
      return;
    }
    if (command === "status") {
      process.stdout.write(
        `${JSON.stringify({ executorId: profile.executorId, executorGeneration: profile.executorGeneration, confinement: "host", nativeEnabled: profile.policy.trustedHost, executions: ledger.identities().map((i) => ({ jobId: i.jobId, executionId: i.executionId, state: ledger.get(i.jobId)?.state })), pendingApprovals: ledger.pending().length })}\n`,
      );
      return;
    }
    throw new Error("unknown executor command");
  } finally {
    ledger.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Executor failed"}\n`);
    process.exitCode = 1;
  });
}
