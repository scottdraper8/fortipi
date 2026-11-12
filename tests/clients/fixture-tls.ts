import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

export interface FixtureTLS {
  directory: string;
  ca: string;
  key: string;
  cert: string;
  leafSpki: string;
  openssl: string;
}
/** Disposable synthetic loopback identity. No system trust, real key, auth file
 * or certificate-ignore setting is read or changed. */
export async function fixtureTLS(): Promise<FixtureTLS> {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), "fortipi-evidence-tls-")));
  await chmod(directory, 0o700);
  const ca = resolve(directory, "ca.pem"),
    caKey = resolve(directory, "ca.key"),
    key = resolve(directory, "leaf.key"),
    cert = resolve(directory, "leaf.pem");
  const execute = promisify(execFile);
  const env = {
    PATH: process.env.PATH,
    LANG: "C",
    HOME: directory,
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
  };
  const tool = async (...args: string[]) =>
    execute("openssl", args, {
      cwd: directory,
      env,
      timeout: 20000,
      maxBuffer: 32768,
      windowsHide: true,
    });
  try {
    const openssl = (await tool("version")).stdout.trim();
    await tool(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "1",
      "-subj",
      "/CN=FortiPi disposable fixture CA",
      "-keyout",
      caKey,
      "-out",
      ca,
    );
    await tool(
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      "/CN=127.0.0.1",
      "-keyout",
      key,
      "-out",
      "leaf.csr",
    );
    await writeFile(
      resolve(directory, "leaf.ext"),
      "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n",
      { flag: "wx", mode: 0o600 },
    );
    await tool(
      "x509",
      "-req",
      "-in",
      "leaf.csr",
      "-CA",
      ca,
      "-CAkey",
      caKey,
      "-set_serial",
      "1010",
      "-days",
      "1",
      "-sha256",
      "-extfile",
      "leaf.ext",
      "-out",
      cert,
    );
    await chmod(caKey, 0o600);
    await chmod(key, 0o600);
    const identity = await verifyFixtureTLS({ directory, ca, key, cert });
    return { directory, ca, key, cert, leafSpki: identity.leafSpki, openssl };
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error("Disposable loopback TLS identity generation failed");
  }
}
export async function verifyFixtureTLS(
  input: Pick<FixtureTLS, "directory" | "ca" | "key" | "cert">,
) {
  const ca = new X509Certificate(await readFile(input.ca)),
    leaf = new X509Certificate(await readFile(input.cert));
  assert.equal(ca.ca, true);
  assert.equal(leaf.ca, false);
  assert.ok(ca.verify(ca.publicKey));
  assert.ok(leaf.checkIssued(ca) && leaf.verify(ca.publicKey));
  assert.equal(leaf.checkIP("127.0.0.1"), "127.0.0.1");
  assert.equal(leaf.checkHost("localhost"), "localhost");
  for (const cert of [ca, leaf]) {
    assert.ok(Date.parse(cert.validFrom) <= Date.now() && Date.parse(cert.validTo) > Date.now());
    assert.ok(Date.parse(cert.validTo) - Date.parse(cert.validFrom) <= 2 * 86400000);
  }
  const spki = leaf.publicKey.export({ type: "spki", format: "der" });
  assert.deepEqual(
    createPublicKey(createPrivateKey(await readFile(input.key))).export({
      type: "spki",
      format: "der",
    }),
    spki,
  );
  return {
    leafSpki: createHash("sha256").update(spki).digest("base64"),
    leafSha256: createHash("sha256").update(leaf.raw).digest("hex"),
    caSha256: createHash("sha256").update(ca.raw).digest("hex"),
  };
}
