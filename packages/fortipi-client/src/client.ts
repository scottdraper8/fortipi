import type {
  OperationId,
  OperationRequest,
  OperationResponse,
  OperationValue,
} from "fortipi-contract";
import { routeCatalog } from "fortipi-contract";
import { FortiPiError } from "./errors.js";
import { Http } from "./http.js";
import { resources } from "./resources.js";
import { openUpgrade } from "./transport.js";
import type { ClientOptions, OperationInput, Operations, RequestOptions } from "./types.js";

export class FortiPiClient {
  readonly http: Http;
  readonly operations: Operations;
  readonly discovery: ReturnType<typeof resources>["discovery"];
  readonly agents: ReturnType<typeof resources>["agents"];
  readonly conversations: ReturnType<typeof resources>["conversations"];
  readonly tasks: ReturnType<typeof resources>["tasks"];
  readonly approvals: ReturnType<typeof resources>["approvals"];
  readonly jobs: ReturnType<typeof resources>["jobs"];
  readonly executors: ReturnType<typeof resources>["executors"];
  readonly workspaces: ReturnType<typeof resources>["workspaces"];
  readonly uploads: ReturnType<typeof resources>["uploads"];
  readonly tickets: ReturnType<typeof resources>["tickets"];
  readonly artifacts: ReturnType<typeof resources>["artifacts"];
  constructor(options: ClientOptions) {
    this.http = new Http(options);
    this.operations = Object.fromEntries(
      routeCatalog.map((route) => [
        route.operationId,
        (input: OperationInput<OperationId>, options?: RequestOptions) => {
          if (
            route.operationId === "getClientStream" ||
            route.operationId === "getExecutorSession"
          ) {
            this.http.validation.request(route, input);
            return openUpgrade(
              this.http,
              route.operationId,
              (input.query as { ticket: string }).ticket,
              options?.signal,
            );
          }
          return this.execute(
            { ...input, operationId: route.operationId } as OperationRequest<OperationId>,
            options,
          );
        },
      ]),
    ) as Operations;
    const ports = resources(this);
    this.discovery = ports.discovery;
    this.agents = ports.agents;
    this.conversations = ports.conversations;
    this.tasks = ports.tasks;
    this.approvals = ports.approvals;
    this.jobs = ports.jobs;
    this.executors = ports.executors;
    this.workspaces = ports.workspaces;
    this.uploads = ports.uploads;
    this.tickets = ports.tickets;
    this.artifacts = ports.artifacts;
  }
  negotiate(signal?: AbortSignal) {
    return this.http.negotiate(signal);
  }
  /** Status-preserving generated response union; application errors throw typed FortiPiError. */
  request<K extends OperationId>(
    input: OperationRequest<K>,
    options?: RequestOptions,
  ): Promise<OperationResponse<K>> {
    return this.http.request(input, options);
  }
  async execute<K extends OperationId>(
    input: OperationRequest<K>,
    options?: RequestOptions,
  ): Promise<OperationValue<K>> {
    const result = await this.request(input, options);
    if (result.body && typeof result.body === "object" && "error" in result.body)
      throw new FortiPiError("invalid_wire");
    return result.body as OperationValue<K>;
  }
  /** One immutable idempotency key and payload per user intent, reusable after an uncertain response. */
  messageIntent(
    conversationId: string,
    content: string,
    busyBehavior: "followUp" | "reject" = "reject",
  ) {
    const body = Object.freeze({
      clientRequestId: globalThis.crypto.randomUUID(),
      content,
      busyBehavior,
    });
    return Object.freeze({
      body,
      send: (options?: RequestOptions) => this.conversations.send(conversationId, body, options),
    });
  }
}
