/** One browser task alongside one serial LOCAL lane. Rows stay private until joined. */
export async function withLocalBrowserLane<Row, Result>(
  browser: (sink: Row[]) => Promise<void>,
  serial: (join: () => Promise<readonly Row[]>) => Promise<Result>,
): Promise<Result> {
  const rows: Row[] = [];
  // Attach rejection handling immediately, including a synchronous callback throw.
  const settled = (async () => browser(rows))().then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const join = async () => {
    const result = await settled;
    if (!result.ok) throw result.error;
    return rows as readonly Row[];
  };
  try {
    const result = await serial(join);
    await join();
    return result;
  } catch (error) {
    // Cleanup/settlement is mandatory; it cannot replace the serial lane's error.
    await settled;
    throw error;
  }
}
