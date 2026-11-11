import type { Terminal } from "@earendil-works/pi-tui";
/** Component terminal only: records actual renderer output, but is not a PTY/OS terminal. */
export class FixtureTerminal implements Terminal {
  columns = 100;
  rows = 30;
  kittyProtocolActive = false;
  output = "";
  stopped = false;
  private input: (data: string) => void = () => {};
  start(onInput: (data: string) => void): void {
    this.input = onInput;
  }
  key(data: string): void {
    if (data.length > 1 && !data.startsWith("\u001b")) {
      for (const char of data) this.input(char);
    } else this.input(data);
  }
  stop(): void {
    this.stopped = true;
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.output += data;
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}
