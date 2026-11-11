/** FIFO for explicit filesystem and metadata work. Never hold across an RPC or runtime wait. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(work: () => T | Promise<T>): Promise<T> {
    const previous = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
