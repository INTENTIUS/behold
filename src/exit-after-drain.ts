/**
 * Exit once stdout and stderr have taken everything written to them.
 *
 * `process.exit()` stops the process before a piped stdout has emptied its
 * buffer, so `behold graph --json | wc -c` ended at the 64 KiB a pipe holds
 * (behold#1141). An empty write's callback runs after every earlier write on
 * the stream, so waiting on it waits for the drain. A stream that is already
 * closed (EPIPE, a reader that went away) reports an error to the callback or
 * the 'error' event, and the exit goes ahead.
 */
export function drained(stream: NodeJS.WriteStream): Promise<void> {
  return new Promise((resolve) => {
    if (stream.destroyed || !stream.writable) return resolve();
    stream.once("error", () => resolve());
    stream.write("", () => resolve());
  });
}

export async function exitAfterDrain(code: number): Promise<never> {
  await Promise.all([drained(process.stdout), drained(process.stderr)]);
  process.exit(code);
}
