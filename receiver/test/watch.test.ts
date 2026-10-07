// SPDX-License-Identifier: GPL-2.0-or-later
import { expect, test } from "bun:test";
import { createReceiver } from "../src/receiver.ts";
import { batch, snapshot } from "../examples/fixtures.ts";
import { isBatch } from "../src/schema.ts";
import type { Snapshot } from "../src/schema.ts";
import { Store } from "../src/store.ts";
import { snapshotStream } from "../src/receiver.ts";
import type { WatchTarget } from "../src/watch.ts";
const alice = { guid: "Alice", name: "Alice" }, bob = { guid: "Bob", name: "Bob" };
function watched(sequence = 1, name = "Observer", target: WatchTarget | null = null,
  presence: Snapshot["presence"] = "online"): Snapshot {
  return { ...snapshot(name, name), sequence: String(sequence), watch_target: target, presence,
    ...(presence === "online" ? {} : { player: null, target: null }) };
}
test("follow isolates observers and realms, retains offline targets, and clears on unwatch/logout", () => {
  const store = new Store(); store.ingest(batch(watched(), watched(1, "Alice", bob), watched(1, "Bob")));
  store.ingest(batch(watched(2, "Observer", alice), watched(1, "Other", bob)));
  expect(store.view("realm-1", "Observer", true)?.guid).toBe("Alice");
  expect(store.view("realm-1", "Other", true)?.guid).toBe("Bob");
  expect(store.view("realm-1", "Observer")?.guid).toBe("Observer");
  expect(store.view("realm-2", "Observer", true)).toBeNull();
  store.ingest(batch(watched(2, "Alice", null, "offline")));
  expect(store.view("realm-1", "Observer", true)?.presence).toBe("offline");
  store.ingest(batch(watched(3, "Alice")));
  expect(store.view("realm-1", "Observer", true)?.presence).toBe("online");
  store.ingest(batch(watched(3, "Observer", { guid: "Unknown", name: "Unknown" })));
  expect(store.view("realm-1", "Observer", true)).toBeNull();
  store.ingest(batch(watched(4, "Observer"))); store.ingest(batch(watched(3, "Observer", bob)));
  expect(store.view("realm-1", "Observer", true)?.guid).toBe("Observer");
  store.ingest(batch(watched(5, "Observer", alice, "offline")));
  expect(store.view("realm-1", "Observer", true)?.guid).toBe("Observer");
});
test("routing expires independently of target data, and a new process cannot reuse old assignments", () => {
  let now = 0; const store = new Store(() => now);
  store.ingest(batch(watched(1, "Observer", alice), watched(1, "Alice")));
  now = 5000; store.ingest(batch(watched(2, "Alice")));
  expect(store.view("realm-1", "Observer", true)).toBeNull();
  store.ingest(batch(watched(2, "Observer", alice, "unavailable")));
  expect(store.view("realm-1", "Observer", true)?.guid).toBe("Alice");
  store.ingest({ ...batch(watched(1, "Alice")), process_id: "restart" });
  expect(store.view("realm-1", "Observer", true)).toBeNull();
  const legacy = watched(); delete legacy.watch_target;
  store.ingest({ ...batch(legacy), process_id: "restart" });
  store.ingest(batch(watched(999, "Observer", alice)));
  expect(store.view("realm-1", "Observer", true)?.guid).toBe("Observer");
});
test("optional watch metadata and follow query reject malformed inputs", () => {
  expect(isBatch(batch(snapshot()))).toBe(true);
  expect(isBatch(batch(watched(1, "Observer", alice)))).toBe(true);
  for (const target of [false, {}, { guid: "a", name: "" }, { guid: "a".repeat(257), name: "Name" }]) {
    expect(isBatch(batch({ ...watched(), watch_target: target as never }))).toBe(false);
  }
  const store = new Store();
  for (const follow of ["follow=", "follow=bad", "follow=watch&follow=watch"]) {
    expect(() => store.resolve(new URLSearchParams(`source=realm-1&guid=Observer&${follow}`))).toThrow();
  }
});
test("SSE follows GUID changes even at equal revisions and emits waiting when the assignment expires", async () => {
  let now = 0; const store = new Store(() => now);
  store.ingest(batch(watched(1, "Observer", alice), watched(1, "Alice"), watched(1, "Bob")));
  const stream = snapshotStream(store, "realm-1", "Observer", new AbortController().signal, undefined, undefined, true);
  const reader = stream.stream.getReader(); const decoder = new TextDecoder();
  const next = async () => decoder.decode((await reader.read()).value);
  try {
    expect(await next()).toContain('"guid":"Alice"');
    store.ingest(batch(watched(2, "Observer", bob)));
    expect(await next()).toContain('"guid":"Bob"');
    now = 5000;
    expect(await next()).toContain("data: null");
    store.ingest(batch(watched(3, "Observer")));
    expect(await next()).toContain('"guid":"Observer"');
  } finally { await reader.cancel(); }
});

test("HTTP follow remains opt-in and validates query parameters", async () => {
  const receiver = createReceiver({ host: "127.0.0.1", port: 0 });
  try {
    receiver.store.ingest(batch(watched(1, "Observer", alice), watched(1, "Alice")));
    const url = new URL("/api/units?source=realm-1&character=Observer", receiver.server.url);
    expect((await (await fetch(url)).json()).guid).toBe("Observer");
    url.searchParams.set("follow", "watch");
    expect((await (await fetch(url)).json()).guid).toBe("Alice");
    url.searchParams.append("follow", "watch"); expect((await fetch(url)).status).toBe(400);
    url.searchParams.set("follow", "invalid"); expect((await fetch(url)).status).toBe(400);
    expect((await fetch(new URL("/follow.js", receiver.server.url))).status).toBe(200);
  } finally { await receiver.stop(); }
});
