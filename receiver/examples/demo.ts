// SPDX-License-Identifier: GPL-2.0-or-later
import { batch, scenarios } from "./fixtures.ts";
const endpoint = process.env.UNIT_WIDGET_DEMO_ENDPOINT ?? "http://127.0.0.1:3001/units";
const processId = crypto.randomUUID();
const started = performance.now();
let sequence = 0;
console.error("Sending synthetic realm-1 frames: Alice, Valeera, Malfurion, Darion, Fallen, Offline.");
console.error("Stop with Ctrl+C to demonstrate stale/disconnected frames.");
while (true) {
  const elapsed = performance.now() - started;
  const snapshots = scenarios();
  for (const snapshot of snapshots) {
    snapshot.sequence = String(++sequence);
    if (snapshot.player) {
      snapshot.player.health.value = Math.floor(snapshot.player.health.max * (0.7 + Math.sin(elapsed / 4000) * 0.2));
      if (snapshot.name === "Fallen") snapshot.player.health.value = 0;
      for (const unit of [snapshot.player, snapshot.target]) {
        if (!unit) continue;
        if (unit.cast) {
          unit.cast.id = String(1 + Math.floor(elapsed / 7000));
          unit.cast.state = Math.floor(elapsed / 7000) % 2 ? "channeling" : "casting";
          unit.cast.duration_ms = 7000;
          unit.cast.remaining_ms = Math.ceil(7000 - elapsed % 7000);
        }
        for (const aura of unit.auras) if (aura.remaining_ms !== null) {
          aura.remaining_ms = Math.ceil(aura.duration_ms! - elapsed % aura.duration_ms!);
        }
      }
      for (const rune of snapshot.player.extra.runes) if (rune.remaining_ms) {
        rune.remaining_ms = Math.ceil(10000 - elapsed % 10000);
      }
    }
  }
  const data = batch(...snapshots);
  data.process_id = processId;
  try {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json",
      ...(process.env.UNIT_WIDGET_BEARER_TOKEN
        ? { Authorization: `Bearer ${process.env.UNIT_WIDGET_BEARER_TOKEN}` } : {}) },
      body: JSON.stringify(data), signal: AbortSignal.timeout(2000) });
    if (!response.ok) console.error(`Demo ingestion returned ${response.status}`);
  } catch { console.error("Waiting for receiver…"); }
  await Bun.sleep(100);
}
