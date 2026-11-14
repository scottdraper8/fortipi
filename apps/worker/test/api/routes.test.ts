import assert from "node:assert/strict";
import test from "node:test";
import { routeCatalog } from "fortipi-contract";
import type * as D from "../../src/boundary/dto.js";
import { harness } from "../agent/harness.ts";

test("all generated routes reach a real authenticated owner boundary", async () => {
  const h = await harness();
  try {
    assert.equal(routeCatalog.length, 74, "Approved public operation allocation");
    for (const route of routeCatalog) {
      const pathname = route.path.replace(/\{([^}]+)\}/g, (_match, name: string) =>
        name === "name" ? "common.schema.json" : name === "chunkIndex" ? "0" : "resource",
      );
      const query =
        "transport" in route && route.transport === "upgrade"
          ? "?ticket=synthetic-ticket"
          : route.query === "ReplayQuery"
            ? "?after=0"
            : route.query === "RevisionQuery"
              ? "?revision=revision"
              : route.query === "TransferQuery"
                ? "?attemptId=attempt"
                : route.query === "TransferChunkQuery"
                  ? `?attemptId=attempt&length=1&sha256=${"0".repeat(64)}`
                  : route.query === "ChunkQuery"
                    ? `?length=1&sha256=${"0".repeat(64)}`
                    : route.query === "CommitReceiptQuery"
                      ? `?commitDigest=${"0".repeat(64)}`
                      : route.query === "WorkspacePathQuery"
                        ? "?revision=revision&path=file"
                        : route.query === "WorkspaceReadQuery"
                          ? "?revision=revision&path=file"
                          : route.query === "WorkspaceListQuery"
                            ? "?revision=revision"
                            : route.query === "WorkspaceDiffQuery"
                              ? "?revision=revision&otherRevision=other"
                              : route.query === "ExecutorJobQuery"
                                ? `?executionId=execution&assignmentDigest=${"0".repeat(64)}&connectionEpoch=1`
                                : route.query === "ExecutorJobChunkQuery"
                                  ? `?executionId=execution&assignmentDigest=${"0".repeat(64)}&connectionEpoch=1&length=1&sha256=${"0".repeat(64)}`
                                  : "";
      const response = await h.server.fetch(`http://fortipi.local${pathname}${query}`, {
        method: route.method,
      });
      if (route.audience === "public") assert.equal(response.status, 200, route.operationId);
      else if ("transport" in route && route.transport === "upgrade")
        assert.equal(response.status, 400, route.operationId);
      else assert.equal(response.status, 401, route.operationId);
    }
    for (const path of [
      "/__fortipi/terminal-proof/job",
      "/__fortipi/authority/start",
      "/internal/artifacts/workspace/output",
      "/agents",
      "/capnweb",
    ]) {
      const response = await h.server.fetch(`http://fortipi.local${path}`);
      assert.equal(response.status, 404, path);
    }
  } finally {
    await h.close();
  }
});

test("shared artifacts.read never grants the administrator audience", async () => {
  const h = await harness();
  try {
    const grant: D.Grant = {
      grantId: "artifact-reader",
      version: 1,
      resources: {
        agentIds: ["agent"],
        conversationIds: ["conversation"],
        workspaceIds: ["workspace"],
        actions: ["artifacts.read"],
        tools: [],
        executorIds: [],
        backendIds: [],
      },
    };
    const minted = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
      requestId: crypto.randomUUID(),
      role: "client",
      grants: [grant],
    });
    assert.equal(minted.status, 201);
    assert.equal(minted.body.state, "issued");
    if (minted.body.state !== "issued") assert.fail("Expected new synthetic reader");
    const response = await h.api("/v1/admin/artifacts/export", undefined, "GET", minted.body.token);
    assert.equal(
      response.status,
      403,
      "Application artifact action cannot authorize an admin route",
    );
  } finally {
    await h.close();
  }
});

test("assigned-job transfers require the executor audience before owner forwarding", async () => {
  const h = await harness();
  try {
    const query = `executionId=execution&assignmentDigest=${"0".repeat(64)}&connectionEpoch=1`;
    const paths = [
      { method: "GET", suffix: "manifest" },
      { method: "GET", suffix: `blobs/${"0".repeat(64)}` },
      { method: "POST", suffix: "uploads" },
      {
        method: "PUT",
        suffix: `uploads/upload/blobs/${"0".repeat(64)}/chunks/0`,
        extra: `&length=1&sha256=${"0".repeat(64)}`,
      },
      { method: "POST", suffix: "uploads/upload/validate" },
    ];
    // Even an administrator with all actions is not an executor connection.
    for (const path of paths) {
      const response = await h.api<D.ErrorBody>(
        `/v1/executor/jobs/job/${path.suffix}?${query}${path.extra ?? ""}`,
        undefined,
        path.method,
      );
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, "unauthorized");
      assert.equal(response.body.error.message, "Executor audience required");
    }
  } finally {
    await h.close();
  }
});

test("CORS exposes the checksum required by public byte clients", async () => {
  const origin = "https://client.example";
  const h = await harness({ origin });
  try {
    const response = await h.server.fetch("http://fortipi.local/health", {
      headers: { Origin: origin },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
    const exposed = response.headers.get("Access-Control-Expose-Headers")?.toLowerCase().split(",");
    assert.ok(
      exposed?.includes("x-content-sha256"),
      "Browser clients must be permitted to read the verified byte checksum",
    );
  } finally {
    await h.close();
  }
});
