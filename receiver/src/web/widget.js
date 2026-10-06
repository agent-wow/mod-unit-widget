// SPDX-License-Identifier: GPL-2.0-or-later
import { UnitFrame } from "./render.js";
/** @typedef {import('../schema.ts').View} View */
const root = /** @type {HTMLElement} */ (document.getElementById("frames"));
const status = /** @type {HTMLElement} */ (document.getElementById("connection"));
const params = new URLSearchParams(location.search);
const source = params.get("source");
const mode = params.get("frame") || "both";
let guid = params.get("guid");
const character = params.get("character");
const player = mode !== "target" ? new UnitFrame(root, "player") : null;
const target = mode !== "player" ? new UnitFrame(root, "target") : null;
/** @type {View | null} */
let view = null;
let received = 0;
let framesStale = false;
let failures = 0;
/** @type {EventSource | null} */
let connection = null;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let reconnectTimer;
function stale() {
  framesStale = true;
  player?.inactive(view?.name || character || "Character", "CONNECTION LOST");
  target?.hide();
  status.textContent = "Waiting for fresh unit data…";
}
/** @param {View | null} snapshot */
function display(snapshot) {
  received = performance.now();
  view = snapshot;
  if (!view) {
    player?.inactive(character || "Character", "WAITING");
    target?.hide();
    status.textContent = "Waiting for this character…";
    return;
  }
  document.title = `${view.name} — Unit frames`;
  if (view.stale) { stale(); return; }
  framesStale = false;
  if (view.presence !== "online") {
    player?.inactive(view.name, view.presence.toUpperCase());
    target?.hide();
    status.textContent = view.presence === "offline" ? "Character offline" : "Character changing maps…";
    return;
  }
  if (view.player) player?.update(view.player, view.age_ms);
  if (view.target) target?.update(view.target, view.age_ms);
  else target?.hide();
  status.textContent = "";
}
async function connect() {
  try {
    const query = new URLSearchParams({ source: source || "" });
    query.set(guid ? "guid" : "character", guid || character || "");
    const response = await fetch(`/api/units?${query}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      const body = await response.json();
      status.textContent = body.error;
      if ([400, 409].includes(response.status)) return;
      throw new Error("Waiting");
    }
    const snapshot = /** @type {View | null} */ (await response.json());
    if (snapshot) { guid = snapshot.guid; query.delete("character"); query.set("guid", guid); }
    display(snapshot);
    connection = new EventSource(`/api/units/stream?${query}`);
    connection.onopen = () => { failures = 0; };
    connection.addEventListener("snapshot", (event) => { display(JSON.parse(event.data)); });
    connection.onerror = () => {
      connection?.close();
      status.textContent = "Reconnecting…";
      schedule();
    };
  } catch { schedule(); }
}
function schedule() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { void connect(); }, Math.min(1000 * 2 ** Math.min(failures++, 4), 10000));
}
let last = 0;
/** @param {number} now */
function animate(now) {
  if (view && view.presence !== "offline" && !framesStale && view.age_ms + now - received >= 5000) stale();
  if (now - last >= 33) { player?.tick(now); target?.tick(now); last = now; }
  requestAnimationFrame(animate);
}
if (!source || Boolean(guid) === Boolean(character) || !["both", "player", "target"].includes(mode)) {
  status.textContent = "Select /widget?source=realm-1&character=Alice&frame=both";
} else {
  void connect();
  requestAnimationFrame(animate);
}
window.addEventListener("pagehide", () => { connection?.close(); clearTimeout(reconnectTimer); });
