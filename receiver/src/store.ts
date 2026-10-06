// SPDX-License-Identifier: GPL-2.0-or-later
import { STALE_MS } from "./schema.ts";
import type { Batch, Snapshot, View } from "./schema.ts";

interface Entry { snapshot: Snapshot; received: number; bytes: number }
interface Source { process: string; retired: Set<string>; entries: Map<string, Entry>; updated: number }
export class SelectionError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export class Store {
  private sources = new Map<string, Source>();
  private count = 0;
  private bytes = 0;
  private listeners = new Set<() => void>();
  private now: () => number;
  private maxCharacters: number;
  private maxBytes: number;
  constructor(now = () => performance.now(), maxCharacters = 10000, maxBytes = 64 * 1024 * 1024) {
    this.now = now; this.maxCharacters = maxCharacters; this.maxBytes = maxBytes;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify() { for (const fn of this.listeners) fn(); }
  ingest(batch: Batch) {
    this.prune();
    const now = this.now();
    const old = this.sources.get(batch.source_id);
    if (old?.retired.has(batch.process_id)) return;
    // An expired upload must never change the active source generation.
    const fresh = batch.snapshots.filter((s) => s.age_ms < STALE_MS);
    if (!fresh.length) return;
    const changedProcess = old && old.process !== batch.process_id;
    if ((!old && this.sources.size >= 128) || (changedProcess && old.retired.size >= 128)) {
      throw new SelectionError(503, "Source capacity reached");
    }
    const source: Source = !old || changedProcess
      ? { process: batch.process_id, retired: new Set(old?.retired), entries: new Map(), updated: now }
      : { ...old, entries: new Map(old.entries) };
    if (changedProcess) source.retired.add(old.process);
    let count = this.count - (changedProcess ? old.entries.size : 0);
    let bytes = this.bytes;
    if (changedProcess) for (const entry of old.entries.values()) bytes -= entry.bytes;
    let changed = Boolean(changedProcess);
    for (const snapshot of fresh) {
      const prior = source.entries.get(snapshot.guid);
      if (prior && BigInt(prior.snapshot.sequence) >= BigInt(snapshot.sequence)) continue;
      const size = JSON.stringify(snapshot).length * 2 + 512;
      bytes += size - (prior?.bytes ?? 0);
      if (!prior) ++count;
      source.entries.set(snapshot.guid, { snapshot, received: now, bytes: size });
      changed = true;
    }
    if (count > this.maxCharacters || bytes > this.maxBytes) throw new SelectionError(503, "State capacity reached");
    if (!changed) return;
    source.updated = now;
    this.sources.set(batch.source_id, source);
    this.count = count;
    this.bytes = bytes;
    this.notify();
  }
  private prune() {
    const cutoff = this.now() - 15 * 60 * 1000;
    for (const [key, source] of this.sources) {
      for (const [guid, entry] of source.entries) {
        if (entry.received < cutoff) {
          source.entries.delete(guid);
          --this.count;
          this.bytes -= entry.bytes;
        }
      }
      if (source.updated < cutoff) this.sources.delete(key);
    }
  }
  characters(source: string, name?: string) {
    this.prune();
    const entries = this.sources.get(source)?.entries.values() ?? [];
    return [...entries].filter((e) => !name || e.snapshot.name.toLowerCase() === name.toLowerCase())
      .map((e) => ({ guid: e.snapshot.guid, name: e.snapshot.name,
        presence: this.view(source, e.snapshot.guid)!.presence }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  resolve(params: URLSearchParams): { source: string; guid: string } {
    const source = params.get("source");
    const guid = params.get("guid");
    const name = params.get("character");
    if (!source || source.length > 256 || Boolean(guid) === Boolean(name) ||
      params.getAll("source").length !== 1 || params.getAll("guid").length > 1 ||
      params.getAll("character").length > 1) {
      throw new SelectionError(400, "Select a source and one character name or GUID");
    }
    if (guid) {
      if (guid.length > 256) throw new SelectionError(400, "Invalid GUID");
      return { source, guid };
    }
    const found = this.characters(source, name!);
    if (!found.length) throw new SelectionError(404, "Waiting for this character to be observed");
    if (found.length > 1) throw new SelectionError(409, "Ambiguous character name; select a GUID");
    return { source, guid: found[0]!.guid };
  }
  view(sourceId: string, guid: string): View | null {
    const source = this.sources.get(sourceId);
    const entry = source?.entries.get(guid);
    if (!source || !entry) return null;
    const age = entry.snapshot.age_ms + Math.max(0, this.now() - entry.received);
    const stale = entry.snapshot.presence !== "offline" && age >= STALE_MS;
    return { ...entry.snapshot, source_id: sourceId, process_id: source.process, age_ms: age, stale,
      player: stale ? null : entry.snapshot.player, target: stale ? null : entry.snapshot.target };
  }
}
