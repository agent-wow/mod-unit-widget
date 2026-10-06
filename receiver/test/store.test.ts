// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, test } from "bun:test";
import { Store } from "../src/store.ts";
import { isBatch } from "../src/schema.ts";
import { batch, snapshot, scenarios } from "../examples/fixtures.ts";
import { fraction, timeLabel } from "../src/web/render.js";

describe("live state", () => {
  test("validates every demonstration class and rejects malformed nested frames", () => {
    expect(isBatch(batch(...scenarios()))).toBe(true);
    for (const mutate of [
      (b: any) => b.snapshots[0].player.health.value = -1,
      (b: any) => b.snapshots[0].player.auras[0].slot = 64,
      (b: any) => b.snapshots[0].sequence = "900719925474099300000000000",
      (b: any) => b.snapshots[0].player.extra.runes = [{ type: 99 }],
      (b: any) => b.snapshots[0].target.cast.remaining_ms = "100",
      (b: any) => b.snapshots[0].player.auras.push(b.snapshots[0].player.auras[0]),
    ]) {
      const value = batch(); mutate(value); expect(isBatch(value)).toBe(false);
    }
  });
  test("isolates realms, resolves names, pins GUIDs, and rejects ambiguous selection", () => {
    const store = new Store();
    store.ingest(batch());
    store.ingest({ ...batch(snapshot("Alice", "another")), source_id: "realm-2" });
    expect(store.resolve(new URLSearchParams("source=realm-1&character=ALICE")).guid).toBe(snapshot().guid);
    expect(store.characters("realm-2")[0]!.guid).toBe("another");
    store.ingest(batch(snapshot("ALICE", "duplicate")));
    expect(() => store.resolve(new URLSearchParams("source=realm-1&character=Alice"))).toThrow("Ambiguous");
    expect(() => store.resolve(new URLSearchParams("character=Alice"))).toThrow("Select");
    expect(() => store.resolve(new URLSearchParams("source=realm-1&guid=x&character=Alice"))).toThrow("Select");
    expect(store.view("unknown", snapshot().guid)).toBeNull();
  });
  test("orders uint64 sequences exactly and duplicates cannot extend freshness", () => {
    let now = 0;
    const store = new Store(() => now);
    const first = snapshot(); first.sequence = "9007199254740993";
    store.ingest(batch(first));
    now = 4000;
    store.ingest(batch({ ...first, sequence: "9007199254740992", name: "Old" }));
    store.ingest(batch(first));
    now = 5000;
    const view = store.view("realm-1", first.guid)!;
    expect(view.name).toBe("Alice"); expect(view.stale).toBe(true);
    expect(view.player).toBeNull(); expect(view.target).toBeNull();
  });
  test("capture age contributes to staleness; fresh snapshots recover", () => {
    let now = 100;
    const store = new Store(() => now);
    store.ingest(batch({ ...snapshot(), age_ms: 4900 }));
    now = 201;
    expect(store.view("realm-1", snapshot().guid)!.stale).toBe(true);
    store.ingest(batch({ ...snapshot(), sequence: "2" }));
    expect(store.view("realm-1", snapshot().guid)!.stale).toBe(false);
  });
  test("restarts clear old characters, retire old senders, and expired batches cannot take ownership", () => {
    const store = new Store();
    store.ingest(batch(snapshot(), snapshot("Bob", "bob")));
    store.ingest({ ...batch({ ...snapshot(), sequence: "2" }), process_id: "new" });
    expect(store.view("realm-1", "bob")).toBeNull();
    store.ingest(batch({ ...snapshot(), sequence: "999" }));
    expect(store.view("realm-1", snapshot().guid)!.process_id).toBe("new");
    store.ingest({ ...batch({ ...snapshot(), age_ms: 5000 }), process_id: "expired" });
    expect(store.view("realm-1", snapshot().guid)!.process_id).toBe("new");
  });
  test("atomic capacity failure preserves existing state and source generation", () => {
    const store = new Store(() => 0, 1);
    store.ingest(batch());
    expect(() => store.ingest({ ...batch(snapshot(), snapshot("Bob", "bob")), process_id: "new" })).toThrow("capacity");
    expect(store.view("realm-1", snapshot().guid)!.process_id).toBe("demo-1");
    store.ingest(batch({ ...snapshot(), sequence: "2", name: "Renamed" }));
    expect(store.characters("realm-1")[0]!.name).toBe("Renamed");
  });
  test("logout clears the frame and remains offline instead of becoming a connection error", () => {
    let now = 0;
    const store = new Store(() => now);
    const offline = scenarios()[5]!;
    store.ingest(batch(offline));
    now = 6000;
    expect(store.view("realm-1", offline.guid)!.stale).toBe(false);
    expect(store.view("realm-1", offline.guid)!.presence).toBe("offline");
    now = 16 * 60 * 1000;
    expect(store.characters("realm-1")).toEqual([]);
  });
  test("bar bounds and timer labels handle zero maxima and long buffs", () => {
    expect(fraction(5, 0)).toBe(0); expect(fraction(120, 100)).toBe(1);
    expect(fraction(-1, 100)).toBe(0); expect(timeLabel(-20)).toBe("0");
    expect(timeLabel(61000)).toBe("2m"); expect(timeLabel(3600000)).toBe("1h");
  });
});
