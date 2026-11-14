import { schemaRegistry } from "fortipi-contract";
import { digest } from "../api/common.js";
import type * as D from "../boundary/dto.js";

export type EntryMessages = D.Message | D.Message[];
export const entryMessages = (value: EntryMessages): D.Message[] =>
  Array.isArray(value) ? value : [value];

// The frozen Message constraint, not a separate model/output allowance.
const characters =
  schemaRegistry["conversations.schema.json"].$defs.Message.properties.content.maxLength;

/** Preserve every codepoint and the original entry; only the public projection has parts. */
export async function messageParts(message: D.Message): Promise<D.Message[]> {
  if (message.content.length <= characters) return [message];
  const contents: string[] = [];
  let start = 0,
    end = 0,
    count = 0;
  for (const character of message.content) {
    if (count === characters) {
      contents.push(message.content.slice(start, end));
      start = end;
      count = 0;
    }
    end += character.length;
    count++;
  }
  contents.push(message.content.slice(start));
  return Promise.all(
    contents.map(async (content, index) => ({
      ...message,
      messageId:
        index === 0 ? message.messageId : `part_${await digest([message.messageId, index])}`,
      content,
    })),
  );
}
