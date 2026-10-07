// SPDX-License-Identifier: GPL-2.0-or-later
import { resolveObserver, validFollow, SelectionError } from "./follow.js";
import { UnitFrame } from "./render.js";
/** @typedef {import('../schema.ts').View} View */
const root = /** @type {HTMLElement} */ (document.getElementById("frames"));
const status = /** @type {HTMLElement} */ (document.getElementById("connection"));
const params = new URLSearchParams(location.search);
const follow = params.get("follow") === "watch";
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
let stopped = false;
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
  if (view?.guid !== snapshot?.guid || view?.process_id !== snapshot?.process_id) {
    player?.reset(); target?.reset();
  }
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
    status.textContent = view.presence === "offline" ? "" : "Character changing maps…";
    return;
  }
  if (view.player) player?.update(view.player, view.age_ms);
  if (view.target) target?.update(view.target, view.age_ms);
  else target?.hide();
  status.textContent = "";
}
async function connect() {
  if (stopped) return;
  try {
    guid = await resolveObserver(source, guid, character, follow);
    const query = new URLSearchParams({ source: source || "" });
    if (follow) query.set("follow", "watch");
    query.set(guid ? "guid" : "character", guid || character || "");
    const response = await fetch(`/api/units?${query}`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      const body = await response.json();
      status.textContent = body.error;
      if ([400, 409].includes(response.status)) return;
      throw new Error("Waiting");
    }
    const snapshot = /** @type {View | null} */ (await response.json());
    if (snapshot && !follow) guid = snapshot.guid;
    if (guid) { query.delete("character"); query.set("guid", guid); }
    display(snapshot);
    const current = new EventSource(`/api/units/stream?${query}`); connection = current;
    current.onopen = () => { if (connection !== current || stopped) return; failures = 0; };
    current.addEventListener("snapshot", (event) => {
      if (connection === current && !stopped) display(JSON.parse(event.data));
    });
    current.onerror = () => {
      if (connection !== current || stopped) return;
      connection?.close();
      status.textContent = "Reconnecting…";
      schedule();
    };
  } catch (error) {
    if (error instanceof SelectionError) {
      status.textContent = error.message;
      if ([400, 409].includes(error.status)) { stopped = true; return; }
    }
    schedule();
  }
}
function schedule() {
  if (stopped) return;
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
if (!validFollow(params) || !source || Boolean(guid) === Boolean(character) ||
  !["both", "player", "target"].includes(mode)) {
  status.textContent = "Select /widget?source=realm-1&character=Alice&frame=both";
} else {
  void connect();
  requestAnimationFrame(animate);
}
window.addEventListener("pagehide", () => { stopped = true; connection?.close(); clearTimeout(reconnectTimer); });
