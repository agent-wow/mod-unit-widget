// SPDX-License-Identifier: GPL-2.0-or-later
import { Icons } from "./icons.ts";
import { createReceiver } from "./receiver.ts";

try {
  const port = Number(process.env.UNIT_WIDGET_PORT ?? 3001);
  const mode = process.env.UNIT_WIDGET_ICON_MODE ?? "hybrid";
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !["hybrid", "offline"].includes(mode)) {
    throw new Error("Invalid receiver settings");
  }
  const icons = await Icons.open({ mode: mode as "hybrid" | "offline",
    directory: process.env.UNIT_WIDGET_ICON_DIR, cachePath: process.env.UNIT_WIDGET_ICON_CACHE });
  const receiver = createReceiver({ port, host: process.env.UNIT_WIDGET_HOST ?? "127.0.0.1",
    token: process.env.UNIT_WIDGET_BEARER_TOKEN, icons });
  console.error(`Unit widget listening at ${receiver.server.url}`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    void receiver.stop().then(() => { clearTimeout(deadline); process.exit(0); });
  });
} catch {
  console.error("Unable to start unit widget receiver; check settings, icon manifest, cache, and listening port");
  process.exitCode = 1;
}
