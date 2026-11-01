/**
 * Questions go to the controlling terminal, not stdin/stdout, so they work while stdout is piped.
 * Without a terminal (CI, cron, another program's subprocess), opening /dev/tty fails and we return null.
 */

let queue: Promise<unknown> = Promise.resolve();

async function prompt(text: string): Promise<string | null> {
  try {
    const out = Bun.file("/dev/tty").writer();
    out.write(text);
    await out.end();
    const reader = Bun.file("/dev/tty").stream().getReader();
    let line = "";
    while (!line.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) break;
      line += new TextDecoder().decode(value);
    }
    await reader.cancel();
    return line.split("\n")[0]!.trim();
  } catch {
    return null;
  }
}

/** Asks one question at a time, even when parallel tool calls ask at once. */
export function ask(text: string): Promise<string | null> {
  const answer = queue.then(() => prompt(text));
  queue = answer;
  return answer;
}

export async function hasTerminal(): Promise<boolean> {
  try {
    await Bun.file("/dev/tty").writer().end();
    return true;
  } catch {
    return false;
  }
}

export const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
