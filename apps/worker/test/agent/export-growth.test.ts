import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import type * as D from "../../src/boundary/dto.js";
import { eventually, harness, setup } from "./harness.ts";

interface Trace {
  local: {
    growth: { pending: number; claims: { operationId: string; reservationId?: string }[] };
    works: { operationId: string; capacity?: D.CapacityReservation }[];
    physical: number;
    retainedExports: string[];
    armFailures: number;
    report: { input: { coverage: { bytes: number } }; receipt?: { sampleSeq: number } };
  };
  control: {
    reservation: D.CapacityReservation;
    disposition?: string;
    covered: boolean;
    held: boolean;
  }[];
}
for (const mode of ["capacity", "settlement", "held-settlement"] as const)
  test(`export growth survives lost committed ${mode} reply and requires actual measured coverage`, {
    timeout: 60000,
  }, async () => {
    const h = await harness({
      main:
        process.env.FORTIPI_EXPORT_GROWTH_FAULT_WORKER ??
        resolve("apps/worker/test/agent/export-growth-worker.ts"),
      modelChunkBytes: 256,
      // Export byte retention is the oracle; ample FAUX context isolates Pi
      // compaction, without changing any infrastructure/model stream bound.
      largeModelContext: true,
    });
    try {
      const { agent, conversation } = await setup(h);
      const probe = h.env.AGENT_SESSIONS.getByName(agent.agentId);
      const cp = h.env.CONTROL_PLANE.getByName("control");
      // Maximum admitted export payload is exercised on real 100KiB Pi entries,
      // not synthetic database records or a weakened byte assertion.
      if (mode === "settlement")
        for (let i = 0; i < 6; i++) {
          const response = await h.api<D.AdmissionReceipt>(
            `/v1/conversations/${conversation.conversationId}/messages`,
            {
              clientRequestId: crypto.randomUUID(),
              content: "large-answer",
              busyBehavior: "followUp",
            },
          );
          assert.equal(response.status, 202);
          await eventually(
            async () => {
              await probe.runRepair();
              return probe.admissionStatus();
            },
            (rows) =>
              rows.find((row) => row.receipt?.operationId === response.body.operationId)?.state ===
              "settled",
          );
        }
      const resources: D.ResourceScope = {
        agentIds: [agent.agentId],
        conversationIds: [conversation.conversationId],
        workspaceIds: [],
        executorIds: [],
        backendIds: [],
        tools: [],
        actions: ["exports.create"],
      };
      const issued = await h.api<D.CredentialReceipt>("/v1/admin/credentials", {
        requestId: crypto.randomUUID(),
        role: "admin",
        grants: [{ grantId: crypto.randomUUID(), version: 1, resources }],
      });
      assert.equal(issued.status, 201);
      if (issued.body.state !== "issued")
        assert.fail("Real scoped synthetic export credential required");
      const authenticated = await cp.authenticate({
        bearer: issued.body.token,
        deploymentId: h.env.CONTROL_PLANE.idFromName("control").toString(),
        requestId: crypto.randomUUID(),
        deadline: Date.now() + 30000,
      });
      if (!authenticated.ok) assert.fail("Real export authentication required");
      const registered = await cp.registerAuthorityRecipient(authenticated.value, {
        credential: {
          credentialId: authenticated.value.credentialId,
          generation: authenticated.value.generation,
          grantVersion: authenticated.value.grantVersion,
        },
        recipient: { kind: "agent", id: agent.agentId },
        resources,
      });
      if (!registered.ok) assert.fail("Real scoped Agent registration required");
      const auth = { ...authenticated.value, registrationId: registered.value.registrationId };
      const raw = (path: string) =>
        h.server.fetch(`http://fortipi.local${path}`, {
          headers: { "X-Fortipi-Context": JSON.stringify(auth) },
        });
      const trace = async (sample = false, drain = false): Promise<Trace> =>
        (
          await raw(
            `/__export-growth/trace?agent=${agent.agentId}&cid=${conversation.conversationId}&sample=${sample}&drain=${drain}`,
          )
        ).json() as Promise<Trace>;
      await raw(`/__export-growth/mode?mode=${mode}`);
      const input: D.ExportRequest = {
        exportId: crypto.randomUUID(),
        action: "exports.create",
        resources,
        maxBytes: 1048576,
        deadline: Date.now() + 30000,
      };
      const prepare = async () =>
        JSON.parse(await probe.exportDataJson(auth, input)) as D.Outcome<D.ExportDescriptor>;
      if (mode === "held-settlement") {
        const first = prepare().then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        let draining: Promise<unknown> | undefined;
        let known: Promise<unknown> | undefined;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await eventually(
            () => trace(),
            (state) => state.local.retainedExports.includes(input.exportId),
          );
          // Drives only EXISTING export-work repair; before the fix the initial
          // call itself holds settlement and this drain queues behind it.
          draining = trace(false, true).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          await eventually(
            () => trace(),
            (state) => state.control[0]?.held === true,
          );
          await raw(`/__export-growth/arm-failure?agent=${agent.agentId}`);
          known = prepare().then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          const observed = await Promise.race([
            Promise.all([first, known]).then((values) => ({ ready: true as const, values })),
            new Promise<{ ready: false }>((accept) => {
              timeout = setTimeout(() => accept({ ready: false }), 2000);
            }),
          ]);
          assert.equal(
            observed.ready,
            true,
            "Durably READY initial and known export descriptors must not await a held CP settlement",
          );
          if (!observed.ready) assert.fail("Retained descriptor blocked on settlement");
          const ready = observed.values[0] as { value: D.Outcome<D.ExportDescriptor> };
          assert.ok(ready.value.ok);
          assert.deepEqual(
            observed.values[0],
            observed.values[1],
            "Known READY descriptor must survive an unwritable app wake arm",
          );
          const held = await trace(true);
          assert.equal(held.local.armFailures, 0, "Known receipt attempts no wake/marker mutation");
          assert.equal(held.control[0]?.disposition, "consumed");
          assert.equal(held.control[0]?.covered, false);
          assert.ok(
            held.local.growth.claims.some(
              (row) => row.operationId === held.local.works[0]?.operationId,
            ),
            "Held completion reply cannot retire export P even after physical measurement",
          );
        } finally {
          clearTimeout(timeout);
          await raw("/__export-growth/mode");
          await Promise.allSettled([first, draining, known]);
        }
        const repaired = await trace();
        assert.equal(repaired.local.works.length, 0);
        assert.ok(repaired.local.growth.pending > 0, "Actual ACK alone still retains P");
        const covered = await trace(true);
        assert.equal(covered.local.growth.pending, 0);
        assert.equal(covered.control[0]?.covered, true);
        return;
      }
      const first = await prepare();
      if (mode === "settlement") await trace(false, true);
      const held = await trace();
      assert.equal(held.local.works.length, 1);
      const operationId = held.local.works[0]?.operationId;
      assert.ok(operationId);
      assert.equal(held.control.length, 1);
      assert.equal(held.control[0]?.reservation.operationId, operationId);
      assert.equal(held.control[0]?.reservation.admissionSlots, 0);
      assert.ok(
        held.local.growth.claims.some((row) => row.operationId === operationId),
        "Export must persist prospective growth before the actual capacity reply",
      );
      if (mode === "capacity") assert.equal(first.ok, false);
      else {
        assert.ok(first.ok);
        if (first.ok) {
          assert.equal(
            first.value.state,
            "partial",
            "Maximum payload truthfully reports truncation",
          );
          assert.ok((first.value.artifacts[0]?.size ?? 0) > 800000);
        }
        const withoutAck = await trace(true);
        assert.ok(withoutAck.local.growth.claims.some((row) => row.operationId === operationId));
        assert.equal(
          withoutAck.control[0]?.covered,
          false,
          "Measurement alone cannot fabricate settlement ACK",
        );
      }
      await raw("/__export-growth/mode");
      // Ordinary due repair handles unknown capacity/settlement outcomes.
      await eventually(
        async () => trace(false, true),
        (state) => state.local.works.length === 0,
      );
      const repaired = await prepare();
      assert.ok(repaired.ok, JSON.stringify(repaired));
      if (!repaired.ok) assert.fail("Retained export unavailable after real repair");
      if (first.ok)
        assert.deepEqual(repaired, first, "Retained source cut/descriptor never changes on retry");
      const artifact = repaired.value.artifacts[0];
      assert.ok(artifact);
      const bytes = new Uint8Array(
        await (
          await probe.fetch(
            new Request(`https://agent.internal${artifact.endpoint}`, {
              headers: { "X-Fortipi-Context": JSON.stringify(auth) },
            }),
          )
        ).arrayBuffer(),
      );
      assert.equal(bytes.length, artifact.size);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
      const beforeSample = await trace();
      assert.ok(
        beforeSample.local.growth.claims.some((row) => row.operationId === operationId),
        "Consumed ACK alone cannot retire local export growth",
      );
      const covered = await trace(true);
      assert.equal(
        covered.local.growth.claims.some((row) => row.operationId === operationId),
        false,
      );
      assert.equal(covered.control[0]?.covered, true);
      assert.ok(covered.local.report.receipt);
      assert.ok(covered.local.report.input.coverage.bytes >= bytes.length);
    } finally {
      await h.close();
    }
  });
