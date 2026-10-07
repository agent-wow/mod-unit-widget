// SPDX-License-Identifier: GPL-2.0-or-later
import { runInNewContext } from "node:vm";
import { expect, test } from "bun:test";
import { resolveObserver, validFollow, SelectionError } from "../src/web/follow.js";
import { batch, snapshot } from "../examples/fixtures.ts";
import { Store } from "../src/store.ts";

const code = (await Bun.file(new URL("../src/web/widget.js", import.meta.url)).text()).replace(/^import .*;\n/gm, "");
class Element {
  children: Element[] = []; dataset = {}; textContent = ""; hidden = false;
  classList = { add() {}, remove() {}, toggle() {} };
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  setAttribute() {}
}
class Connection extends EventTarget {
  static all: Connection[] = [];
  url: URL; closed = false; onerror?: () => void;
  constructor(url: string) { super(); this.url = new URL(url, "http://localhost"); Connection.all.push(this); }
  close() { this.closed = true; }
  emit(type: string, value: unknown) {
    this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(value) }));
  }
}
class Renderer {
  static all: Renderer[] = [];
  resets = 0; guid: string | null = null; motion: unknown = null;
  markers: unknown[] = []; quests: unknown[] = [];
  constructor() { Renderer.all.push(this); }
  update(view: { guid: string }) { this.guid = view.guid; }
  reset() { ++this.resets; this.guid = null; }
  inactive() { this.guid = null; }
  hide() { this.guid = null; }
  tick() {}
  setMotion(value: unknown) { this.motion = value; }
  setQuests(value: unknown[]) { this.quests = value; }
  setCatalog() {}
  presence() {}
  clear() { ++this.resets; }
}
test("browser retains observer across retarget/reconnect and clears previous character state", async () => {
  const store = new Store();
  store.ingest(batch(snapshot("Alice", "Alice"), snapshot("Bob", "Bob")));
  const alice = store.view("realm-1", "Alice")!, bob = store.view("realm-1", "Bob")!;
  Connection.all = []; Renderer.all = [];
  const nodes = new Map<string, Element>();
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id)!; };
  const timers = new Map<number, () => void>(); let timerId = 0;
  const requests: URL[] = [];
  runInNewContext(code, {
    document: { getElementById: get, createTextNode: () => new Element(), body: { dataset: {} } },
    window: new EventTarget(), location: { search: "?source=realm-1&guid=Observer&follow=watch" },
    URLSearchParams, AbortSignal, performance, EventSource: Connection, resolveObserver, validFollow, SelectionError,
    PanelRenderer: Renderer, labels: { info: "Info", inventory: "Inventory" }, symbols: {}, el: () => new Element(),
    UnitFrame: Renderer, Maps: Renderer,
    async fetch(path: string) {
      const url = new URL(path, "http://localhost"); requests.push(url);
      return { ok: true, json: async () => url.pathname === "/api/catalog" ? {} : alice };
    },
    requestAnimationFrame() {},
    setTimeout(fn: () => void) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id: number) { timers.delete(id); }, setInterval() { return 1; }, clearInterval() {},
  });
  await new Promise(setImmediate);
  const first = Connection.all[0]!;
  expect(first.url.searchParams.get("guid")).toBe("Observer");
  expect(first.url.searchParams.get("follow")).toBe("watch");
  const initialResets = Renderer.all.reduce((sum, r) => sum + r.resets, 0);
  first.emit("snapshot", bob);
  expect(Renderer.all.reduce((sum, r) => sum + r.resets, 0)).toBeGreaterThan(initialResets);
  first.emit("snapshot", null);
  expect(Renderer.all.every(r => r.guid === null)).toBe(true);
  first.onerror!();
  const retry = [...timers.values()][0]!; timers.clear(); retry();
  await new Promise(setImmediate);
  const second = Connection.all[1]!;
  expect(second.url.searchParams.get("guid")).toBe("Observer");
  expect(second.url.searchParams.get("follow")).toBe("watch");
  expect(requests.filter(r => r.pathname !== "/api/catalog").every(r => r.searchParams.get("guid") === "Observer"))
    .toBe(true);
  const resets = Renderer.all.reduce((sum, r) => sum + r.resets, 0);
  first.emit("snapshot", bob); // Already closed connection cannot overwrite its replacement.
  expect(Renderer.all.reduce((sum, r) => sum + r.resets, 0)).toBe(resets);
});
