import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { freeInfrastructurePolicy } from "fortipi-contract";
import { createTestHarness } from "wrangler";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export function workspaceConfig(paidJs = false) {
  const infrastructure = paidJs
    ? {
        ...freeInfrastructurePolicy,
        accountPlan: "paid",
        capabilities: [
          {
            capability: "loader",
            state: "available",
            accountPlan: "paid",
            deploymentId: "test-deployment",
            observedAt: Date.now(),
          },
        ],
      }
    : freeInfrastructurePolicy;
  return {
    name: "fortipi-workspace-test",
    main:
      process.env.FORTIPI_TEST_ENTRY ??
      resolve(root, "apps/worker/test/workspace/runtime-worker.ts"),
    compatibility_date: "2026-11-10",
    compatibility_flags: ["nodejs_compat"],
    durable_objects: {
      bindings: [
        { name: "WORKSPACES", class_name: "WorkspaceObject" },
        { name: "CONTROL_PLANE", class_name: "ControlFixture" },
      ],
    },
    migrations: [{ tag: "v1", new_sqlite_classes: ["WorkspaceObject", "ControlFixture"] }],
    ...(paidJs ? { worker_loaders: [{ binding: "LOADER" }] } : {}),
    vars: {
      FORTIPI_CONFIG: paidJs
        ? {
            version: 1,
            workspace: { kind: "computer" },
            execution: {
              kind: "cloud-js",
              backendId: "backend",
              modules: [],
              egress: [],
              onInterrupt: "fail",
            },
            routing: { kind: "cloud", targetIds: ["backend"] },
            models: [],
            infrastructure,
          }
        : { version: 1, infrastructure },
    },
  };
}
export function harness(paidJs = false) {
  return createTestHarness({
    root,
    workers: [{ config: JSON.parse(JSON.stringify(workspaceConfig(paidJs))) }],
  });
}
