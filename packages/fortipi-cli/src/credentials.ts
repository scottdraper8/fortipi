import type {
  CredentialMint,
  CredentialReceipt,
  RevocationInput,
  RevocationReceipt,
} from "fortipi-contract";
import type { AdminClient } from "./admin.js";
import { CliError } from "./errors.js";
import { outsideCheckout, reserveProtected, verifyReserved } from "./profiles.js";
import type { CredentialDelivery } from "./results.js";
import { validate } from "./validation.js";

/** Reserve and persist recovery identity before asking the authority to issue one-time material. */
export async function issueCredential(
  client: AdminClient,
  endpoint: string,
  output: string,
  input: CredentialMint | RevocationInput,
  rotateId?: string,
): Promise<CredentialDelivery> {
  validate(rotateId ? "RevocationInput" : "CredentialMint", input);
  await outsideCheckout(output);
  const destination = await reserveProtected(output);
  const pending = {
    version: 1,
    endpoint,
    state: "pending",
    requestId: input.requestId,
    ...(rotateId ? { rotateId } : {}),
  };
  let issued: CredentialReceipt | undefined;
  try {
    await destination.writeFile(`${JSON.stringify(pending)}\n`);
    await destination.sync();
    let revocation: RevocationReceipt | undefined;
    if (rotateId) {
      const receipt = await client.call("rotateCredential", {
        path: { id: rotateId },
        query: {},
        body: input as RevocationInput,
      });
      issued = receipt.replacement;
      revocation = receipt.revocation;
    } else
      issued = await client.call("mintCredential", {
        path: {},
        query: {},
        body: input as CredentialMint,
      });
    if (issued.state === "already-issued") {
      const recovery = Buffer.from(
        `${JSON.stringify({ ...pending, state: issued.state, credential: issued.credential })}\n`,
      );
      await destination.truncate(0);
      await destination.write(recovery, 0, recovery.length, 0);
      await destination.sync();
      throw new CliError("credential_already_issued_revoke_or_replace");
    }
    await verifyReserved(output, destination);
    const contents = {
      version: 1,
      endpoint,
      role: issued.role,
      token: issued.token,
      credential: issued.credential,
      ...(issued.expiresAt === undefined ? {} : { expiresAt: issued.expiresAt }),
    };
    await destination.truncate(0);
    await destination.write(
      Buffer.from(`${JSON.stringify(contents)}\n`),
      0,
      Buffer.byteLength(`${JSON.stringify(contents)}\n`),
      0,
    );
    await destination.sync();
    await verifyReserved(output, destination);
    return {
      credential: issued.credential,
      role: issued.role,
      state: issued.state,
      ...(revocation ? { revocation } : {}),
    };
  } catch (e) {
    // No blind remint or secret recovery. The caller can inspect the durable operation and revoke.
    if (issued?.state === "issued") {
      await destination.truncate(0).catch(() => undefined);
      const recovery = Buffer.from(
        `${JSON.stringify({ ...pending, state: "delivery-failed", credential: issued.credential })}\n`,
      );
      await destination.write(recovery, 0, recovery.length, 0).catch(() => undefined);
      await destination.sync().catch(() => undefined);
      throw new CliError("credential_delivery_failed_revoke_or_replace");
    }
    throw e;
  } finally {
    issued = undefined;
    await destination.close();
  }
}
