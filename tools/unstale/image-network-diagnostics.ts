// CI preload: retain only a hostname and transport error code, never URLs/headers/credentials.
const fetchInput = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  try {
    return await fetchInput(input, init);
  } catch (error) {
    const address = input instanceof Request ? input.url : input.toString();
    const cause = error instanceof Error ? error.cause : undefined;
    const code =
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "string" &&
      /^[A-Z0-9_]{1,40}$/.test(cause.code)
        ? cause.code
        : "unknown";
    console.error(`Image input network failure: ${new URL(address).hostname} (${code})`);
    throw error;
  }
};
