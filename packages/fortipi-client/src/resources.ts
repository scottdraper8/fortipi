import type {
  ByteReference,
  OperationId,
  OperationRequest,
  OperationValue,
  PageQuery,
  ReplayQuery,
  RevisionQuery,
} from "fortipi-contract";
import type { FortiPiClient } from "./client.js";
import { FortiPiError } from "./errors.js";
import { sameOrigin, sha256 } from "./http.js";
import type { SubscriptionOptions } from "./subscription.js";
import { subscribe } from "./subscription.js";
import type { OperationInput, RequestOptions } from "./types.js";

type Body<K extends OperationId> = OperationRequest<K>["body"];
/** Resource helpers retain canonical DTOs; the complete operation map remains available. */
export function resources(client: FortiPiClient) {
  const call = <K extends OperationId>(
    operationId: K,
    path: OperationRequest<K>["path"],
    query: OperationRequest<K>["query"],
    body: Body<K>,
    options?: RequestOptions,
  ): Promise<OperationValue<K>> =>
    client.execute({ operationId, path, query, body } as OperationRequest<K>, options);
  return {
    discovery: {
      health: (options?: RequestOptions) => call("getHealth", {}, {}, undefined, options),
      protocol: (options?: RequestOptions) => client.negotiate(options?.signal),
      openApi: (options?: RequestOptions) => call("getOpenApi", {}, {}, undefined, options),
      schema: (name: OperationRequest<"getSchema">["path"]["name"], options?: RequestOptions) =>
        call("getSchema", { name }, {}, undefined, options),
    },
    agents: {
      list: (query: PageQuery = {}, options?: RequestOptions) =>
        call("listAgents", {}, query, undefined, options),
      get: (agentId: string, options?: RequestOptions) =>
        call("describeAgent", { agentId }, {}, undefined, options),
    },
    conversations: {
      list: (agentId: string, query: PageQuery = {}, options?: RequestOptions) =>
        call("listConversations", { agentId }, query, undefined, options),
      create: (agentId: string, body: Body<"createConversation">, options?: RequestOptions) =>
        call("createConversation", { agentId }, {}, body, options),
      get: (id: string, options?: RequestOptions) =>
        call("getConversation", { id }, {}, undefined, options),
      send: (id: string, body: Body<"submitMessage">, options?: RequestOptions) =>
        call("submitMessage", { id }, {}, body, options),
      steer: (id: string, body: Body<"steerConversation">, options?: RequestOptions) =>
        call("steerConversation", { id }, {}, body, options),
      fork: (id: string, body: Body<"forkConversation">, options?: RequestOptions) =>
        call("forkConversation", { id }, {}, body, options),
      events: (id: string, query: ReplayQuery, options?: RequestOptions) =>
        call("replayEvents", { id }, query, undefined, options),
      subscribe: (id: string, options: SubscriptionOptions) => subscribe(client, id, options),
    },
    tasks: {
      get: (id: string, options?: RequestOptions) =>
        call("describeTask", { id }, {}, undefined, options),
      cancel: (id: string, body: Body<"cancelTask">, options?: RequestOptions) =>
        call("cancelTask", { id }, {}, body, options),
      resume: (id: string, body: Body<"resumeTask">, options?: RequestOptions) =>
        call("resumeTask", { id }, {}, body, options),
    },
    approvals: {
      get: (id: string, options?: RequestOptions) =>
        call("describeApproval", { id }, {}, undefined, options),
      decide: (id: string, body: Body<"decideApproval">, options?: RequestOptions) =>
        call("decideApproval", { id }, {}, body, options),
    },
    jobs: {
      get: (id: string, options?: RequestOptions) =>
        call("describeJob", { id }, {}, undefined, options),
      reconcile: (id: string, body: Body<"reconcileJob">, options?: RequestOptions) =>
        call("reconcileJob", { id }, {}, body, options),
    },
    executors: {
      list: (query: PageQuery = {}, options?: RequestOptions) =>
        call("listExecutors", {}, query, undefined, options),
    },
    workspaces: {
      list: (query: PageQuery = {}, options?: RequestOptions) =>
        call("listWorkspaces", {}, query, undefined, options),
      create: (body: Body<"createWorkspace">, options?: RequestOptions) =>
        call("createWorkspace", {}, {}, body, options),
      get: (workspaceId: string, options?: RequestOptions) =>
        call("describeWorkspace", { workspaceId }, {}, undefined, options),
      rebind: (workspaceId: string, body: Body<"rebindWorkspace">, options?: RequestOptions) =>
        call("rebindWorkspace", { workspaceId }, {}, body, options),
      manifest: (workspaceId: string, query: RevisionQuery, options?: RequestOptions) =>
        call("getWorkspaceManifest", { workspaceId }, query, undefined, options),
      files: (
        workspaceId: string,
        query: OperationRequest<"listWorkspaceFiles">["query"],
        options?: RequestOptions,
      ) => call("listWorkspaceFiles", { workspaceId }, query, undefined, options),
      stat: (
        workspaceId: string,
        query: OperationRequest<"statWorkspaceFile">["query"],
        options?: RequestOptions,
      ) => call("statWorkspaceFile", { workspaceId }, query, undefined, options),
      read: (
        workspaceId: string,
        query: OperationRequest<"readWorkspaceFile">["query"],
        options?: RequestOptions,
      ) => call("readWorkspaceFile", { workspaceId }, query, undefined, options),
      diff: (
        workspaceId: string,
        query: OperationRequest<"diffWorkspace">["query"],
        options?: RequestOptions,
      ) => call("diffWorkspace", { workspaceId }, query, undefined, options),
      snapshot: (workspaceId: string, body: Body<"snapshotWorkspace">, options?: RequestOptions) =>
        call("snapshotWorkspace", { workspaceId }, {}, body, options),
      blob: (workspaceId: string, sha256: string, query: RevisionQuery, options?: RequestOptions) =>
        call("getWorkspaceBlob", { workspaceId, sha256 }, query, undefined, options),
      artifact: (
        workspaceId: string,
        artifactId: string,
        query: RevisionQuery,
        options?: RequestOptions,
      ) => call("getWorkspaceArtifact", { workspaceId, artifactId }, query, undefined, options),
      transact: (workspaceId: string, body: Body<"transactWorkspace">, options?: RequestOptions) =>
        call("transactWorkspace", { workspaceId }, {}, body, options),
    },
    uploads: {
      begin: (workspaceId: string, body: Body<"beginUpload">, options?: RequestOptions) =>
        call("beginUpload", { workspaceId }, {}, body, options),
      get: (workspaceId: string, uploadId: string, options?: RequestOptions) =>
        call("getUpload", { workspaceId, uploadId }, {}, undefined, options),
      abort: (workspaceId: string, uploadId: string, options?: RequestOptions) =>
        call("abortUpload", { workspaceId, uploadId }, {}, undefined, options),
      chunk: (input: OperationInput<"putUploadChunk">, options?: RequestOptions) =>
        client.operations.putUploadChunk(input, options),
      validate: (workspaceId: string, uploadId: string, options?: RequestOptions) =>
        call("validateUpload", { workspaceId, uploadId }, {}, undefined, options),
      commit: (
        workspaceId: string,
        uploadId: string,
        body: Body<"commitUpload">,
        options?: RequestOptions,
      ) => call("commitUpload", { workspaceId, uploadId }, {}, body, options),
      receipt: (
        workspaceId: string,
        commitId: string,
        query: OperationRequest<"getCommitReceipt">["query"],
        options?: RequestOptions,
      ) => call("getCommitReceipt", { workspaceId, commitId }, query, undefined, options),
    },
    tickets: {
      mint: (conversationId: string, options?: RequestOptions) =>
        call(
          "mintConnectionTicket",
          {},
          {},
          {
            requestId: globalThis.crypto.randomUUID(),
            audience: "client-stream",
            originMode:
              client.http.options.originMode?.kind === "browser"
                ? { kind: "browser", value: client.http.options.originMode.origin }
                : { kind: "native" },
            resources: {
              agentIds: [],
              conversationIds: [conversationId],
              workspaceIds: [],
              actions: ["events.read"],
              tools: [],
              executorIds: [],
              backendIds: [],
            },
          },
          options,
        ),
    },
    artifacts: {
      /** Descriptor must name its exact public route and revision; arbitrary same-origin URLs are rejected too. */
      read: async (reference: ByteReference, options?: RequestOptions): Promise<Uint8Array> => {
        client.http.validation.assert("ByteReference", reference);
        const url = sameOrigin(client.http.origin, reference.endpoint);
        const expected = reference.artifactId
          ? `/v1/workspaces/${encodeURIComponent(reference.workspaceId)}/artifacts/${encodeURIComponent(reference.artifactId)}`
          : `/v1/workspaces/${encodeURIComponent(reference.workspaceId)}/blobs/${reference.sha256}`;
        if (
          url.pathname !== expected ||
          [...url.searchParams.keys()].some((key) => key !== "revision") ||
          url.searchParams.getAll("revision").length !== 1 ||
          url.searchParams.get("revision") !== reference.revision ||
          (reference.owner.expiresAt !== undefined && reference.owner.expiresAt <= Date.now())
        )
          throw new FortiPiError("unsafe_reference");
        const bytes = reference.artifactId
          ? await call(
              "getWorkspaceArtifact",
              { workspaceId: reference.workspaceId, artifactId: reference.artifactId },
              { revision: reference.revision },
              undefined,
              options,
            )
          : await call(
              "getWorkspaceBlob",
              { workspaceId: reference.workspaceId, sha256: reference.sha256 },
              { revision: reference.revision },
              undefined,
              options,
            );
        if (
          !options?.range &&
          (bytes.length !== reference.size || (await sha256(bytes)) !== reference.sha256)
        )
          throw new FortiPiError("checksum_mismatch");
        return bytes;
      },
      stream: async (
        reference: ByteReference,
        options?: RequestOptions,
      ): Promise<ReadableStream<Uint8Array>> => {
        const bytes = await client.artifacts.read(reference, options);
        let offset = 0;
        return new ReadableStream({
          pull(controller) {
            if (options?.signal?.aborted) {
              controller.error(new FortiPiError("aborted"));
              return;
            }
            if (offset === bytes.length) {
              controller.close();
              return;
            }
            controller.enqueue(bytes.slice(offset, offset + 65536));
            offset = Math.min(bytes.length, offset + 65536);
          },
        });
      },
    },
  };
}
