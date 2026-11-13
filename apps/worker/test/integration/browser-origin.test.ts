import test from "node:test";
import { validateBrowserOrigin } from "fortipi-contract";
import { harness, setup } from "../agent/harness.ts";

test("an exact configured HTTPS browser allowlist preserves ordinary conversation creation", {
  timeout: 45000,
}, async () => {
  const origin = "https://127.0.0.1:10110";
  validateBrowserOrigin(origin);
  const native = await harness();
  try {
    await setup(native);
  } finally {
    await native.close();
  }
  const browserConfigured = await harness({ origin });
  try {
    await setup(browserConfigured);
  } finally {
    await browserConfigured.close();
  }
});
