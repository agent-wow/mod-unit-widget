// SPDX-License-Identifier: GPL-2.0-or-later
import { isWatchTarget } from "./watch.ts";
import type { WatchTarget } from "./watch.ts";
export const STALE_MS = 5000;
export interface Power { type: number; value: number; max: number }
export interface Aura {
  spell_id: number; name: string; slot: number; positive: boolean; count: number;
  duration_ms: number | null; remaining_ms: number | null;
}
export interface Cast {
  id: string; spell_id: number; name: string;
  state: "casting" | "channeling" | "complete" | "interrupted" | "cancelled";
  duration_ms: number; remaining_ms: number;
}
export interface Rune { type: number; base_type: number; remaining_ms: number; duration_ms: number }
export interface Frame {
  guid: string; name: string; level: number; class_id: number; kind: "player" | "creature";
  creature_type: number; rank: number; reaction: "hostile" | "friendly" | "neutral";
  health: { value: number; max: number }; power: Power | null; statuses: string[];
  auras: Aura[]; cast: Cast | null;
  extra: { combo_points: number; mana: Power | null; runes: Rune[] };
}
export interface Snapshot {
  watch_target?: WatchTarget | null;
  guid: string; name: string; presence: "online" | "offline" | "unavailable";
  sequence: string; age_ms: number; player: Frame | null; target: Frame | null;
}
export interface Batch { schema_version: 1; source_id: string; process_id: string; snapshots: Snapshot[] }
export interface View extends Snapshot { source_id: string; process_id: string; stale: boolean }

type ObjectValue = Record<string, unknown>;
const object = (v: unknown): v is ObjectValue => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max = 256): v is string =>
  typeof v === "string" && v.length > 0 && new TextEncoder().encode(v).length <= max;
const number = (v: unknown, max = 0xffffffff, min = 0): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const integer = (v: unknown, max = 0xffffffff, min = 0): v is number => number(v, max, min) && Number.isInteger(v);
const sequence = (v: unknown): v is string =>
  typeof v === "string" && /^[1-9][0-9]{0,19}$/.test(v) && BigInt(v) <= 18446744073709551615n;
const choices = (v: unknown, list: readonly string[]): boolean => typeof v === "string" && list.includes(v);
function power(v: unknown): boolean {
  return v === null || (object(v) && integer(v.type, 6) && number(v.value) && number(v.max));
}
function aura(v: unknown): boolean {
  return object(v) && integer(v.spell_id, 0xffffffff, 1) && text(v.name, 512) && integer(v.slot, 63) &&
    typeof v.positive === "boolean" && integer(v.count, 255) &&
    ((v.duration_ms === null && v.remaining_ms === null) ||
      (integer(v.duration_ms, 0x7fffffff, 1) && integer(v.remaining_ms, 0x7fffffff)));
}
function cast(v: unknown): boolean {
  return v === null || (object(v) && sequence(v.id) && integer(v.spell_id, 0xffffffff, 1) && text(v.name, 512) &&
    choices(v.state, ["casting", "channeling", "complete", "interrupted", "cancelled"]) &&
    integer(v.duration_ms, 0x7fffffff, -1) && integer(v.remaining_ms, 0x7fffffff, -1));
}
function rune(v: unknown): boolean {
  return object(v) && integer(v.type, 3) && integer(v.base_type, 3) &&
    integer(v.duration_ms, 0x7fffffff) && integer(v.remaining_ms, 0x7fffffff);
}
function frame(v: unknown): v is Frame {
  if (!object(v) || !object(v.health) || !object(v.extra)) return false;
  return text(v.guid) && text(v.name, 512) && integer(v.level, 255) && integer(v.class_id, 11) &&
    choices(v.kind, ["player", "creature"]) && integer(v.creature_type, 32) && integer(v.rank, 4) &&
    choices(v.reaction, ["hostile", "friendly", "neutral"]) &&
    integer(v.health.value) && integer(v.health.max) && power(v.power) &&
    Array.isArray(v.statuses) && v.statuses.length <= 6 && v.statuses.every((s) =>
      choices(s, ["combat", "dead", "ghost", "pvp", "afk", "dnd"])) &&
    Array.isArray(v.auras) && v.auras.length <= 64 && v.auras.every(aura) &&
    new Set(v.auras.map((a) => (a as Aura).slot)).size === v.auras.length && cast(v.cast) &&
    integer(v.extra.combo_points, 5) && power(v.extra.mana) && Array.isArray(v.extra.runes) &&
    [0, 6].includes(v.extra.runes.length) && v.extra.runes.every(rune);
}
function snapshot(v: unknown): v is Snapshot {
  if (!object(v) || !isWatchTarget(v.watch_target) || !text(v.guid) || !text(v.name, 512) || !sequence(v.sequence) ||
    !integer(v.age_ms, 86400000) || !choices(v.presence, ["online", "offline", "unavailable"])) return false;
  if (v.presence !== "online") return v.player === null && v.target === null;
  return frame(v.player) && v.player.guid === v.guid && v.player.kind === "player" &&
    (v.target === null || frame(v.target));
}
export function isBatch(v: unknown): v is Batch {
  return object(v) && v.schema_version === 1 && text(v.source_id) &&
    typeof v.process_id === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(v.process_id) &&
    Array.isArray(v.snapshots) && v.snapshots.length <= 100 && v.snapshots.every(snapshot);
}
