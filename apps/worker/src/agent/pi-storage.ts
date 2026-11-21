import type { Storage } from "@earendil-works/pi-durable";
import type { Store } from "./store.js";

/** Pre-entry watermark only. Original durability receipts/publication are untouched. */
export function piStorageWatermark(original: Storage, store: Store): Storage {
  return {
    commit: async (batches, receive, context) => {
      // Leave the shared queue before calling Pi storage. No outer transaction,
      // delayed receive, rollback or claim to serialize raw Lifecycle writers.
      await store.transaction(async () => store.mutationWatermark());
      return original.commit(batches, receive, context);
    },
    ...(original.publishing ? { publishing: original.publishing.bind(original) } : {}),
    mintId: original.mintId.bind(original),
    conversation: original.conversation.bind(original),
    scanConversations: original.scanConversations.bind(original),
    entry: original.entry.bind(original),
    findLatestHeadMarker: original.findLatestHeadMarker.bind(original),
    scanEntries: original.scanEntries.bind(original),
    task: original.task.bind(original),
    scanTasks: original.scanTasks.bind(original),
    submission: original.submission.bind(original),
    scanSubmissions: original.scanSubmissions.bind(original),
    submissionByRequest: original.submissionByRequest.bind(original),
    findDocument: original.findDocument.bind(original),
    document: original.document.bind(original),
    scanDocuments: original.scanDocuments.bind(original),
    close: original.close.bind(original),
  };
}
