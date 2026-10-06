// SPDX-License-Identifier: GPL-2.0-or-later
// Stdout writer adapted from agent-wow/mod-chat-widget by hazim-j (Hazim Jumali).
export interface BatchOutput {
  write(line: string): Promise<void>;
  close?(): Promise<void>;
}

export function stdoutOutput(): BatchOutput {
  const writer = Bun.stdout.writer();
  return {
    async write(line) {
      writer.write(line);
      await writer.flush();
    },
    async close() { await writer.end(); },
  };
}
