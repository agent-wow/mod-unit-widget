// SPDX-License-Identifier: GPL-2.0-or-later
import type { Batch, Frame, Snapshot } from "../src/schema.ts";

export function player(name = "Alice", guid = "Player-0x0000000000000001"): Frame {
  return {
    guid, name, kind: "player", level: 80, class_id: 8, creature_type: 7, rank: 0, reaction: "friendly",
    health: { value: 18450, max: 22000 }, power: { type: 0, value: 14320, max: 19800 }, statuses: ["combat", "pvp"],
    auras: [
      { slot: 0, spell_id: 43002, name: "Arcane Intellect", positive: true, count: 0,
        duration_ms: 1800000, remaining_ms: 1320000 },
      { slot: 1, spell_id: 43008, name: "Ice Armor", positive: true, count: 0,
        duration_ms: 1800000, remaining_ms: 1200000 },
      { slot: 2, spell_id: 48161, name: "Power Word: Fortitude", positive: true, count: 0,
        duration_ms: 1800000, remaining_ms: 1700000 },
      { slot: 3, spell_id: 57960, name: "Water Shield", positive: true, count: 3,
        duration_ms: null, remaining_ms: null },
      { slot: 12, spell_id: 116, name: "Frostbolt", positive: false, count: 0,
        duration_ms: 8000, remaining_ms: 6500 },
    ],
    cast: { id: "1", spell_id: 42842, name: "Frostbolt", state: "casting", duration_ms: 3000, remaining_ms: 2300 },
    extra: { combo_points: 0, mana: null, runes: [] },
  };
}
export function snapshot(name = "Alice", guid?: string): Snapshot {
  const self = player(name, guid);
  const target = player("Deathbound Ward", "Creature-0xF130008FFE000001");
  target.kind = "creature"; target.class_id = 0; target.creature_type = 6; target.rank = 1;
  target.reaction = "hostile"; target.level = 82;
  target.health = { value: 53482, max: 84000 }; target.power = null;
  target.statuses = ["combat"]; target.auras = target.auras.slice(3);
  target.cast = { id: "2", spell_id: 71022, name: "Disrupting Shout", state: "casting",
    duration_ms: 5000, remaining_ms: 3800 };
  return { guid: self.guid, name, presence: "online", sequence: "1", age_ms: 0, player: self, target };
}
export function batch(...snapshots: Snapshot[]): Batch {
  return { schema_version: 1, source_id: "realm-1", process_id: "demo-1",
    snapshots: snapshots.length ? snapshots : [snapshot()] };
}
export function scenarios(): Snapshot[] {
  const mage = snapshot();
  const rogue = snapshot("Valeera", "Player-0x0000000000000002");
  rogue.player!.class_id = 4; rogue.player!.power = { type: 3, value: 67, max: 100 };
  rogue.player!.extra.combo_points = 4; rogue.player!.cast = null;
  const druid = snapshot("Malfurion", "Player-0x0000000000000003");
  druid.player!.class_id = 11; druid.player!.power = { type: 1, value: 42, max: 100 };
  druid.player!.extra.mana = { type: 0, value: 8100, max: 12500 }; druid.player!.cast = null;
  const knight = snapshot("Darion", "Player-0x0000000000000004");
  knight.player!.class_id = 6; knight.player!.power = { type: 6, value: 65, max: 100 }; knight.player!.cast = null;
  knight.player!.extra.runes = [0, 0, 1, 1, 2, 3].map((type, i) => ({ type,
    base_type: Math.floor(i / 2), remaining_ms: i % 2 ? 7300 : 0, duration_ms: 10000 }));
  const dead = snapshot("Fallen", "Player-0x0000000000000005");
  dead.player!.health.value = 0; dead.player!.statuses = ["ghost"]; dead.player!.cast = null;
  dead.player!.auras = []; dead.target = null;
  const offline = snapshot("Offline", "Player-0x0000000000000006");
  offline.presence = "offline"; offline.player = null; offline.target = null;
  const crowded = snapshot("A very long character name for layout checks", "Player-0x0000000000000007");
  crowded.player!.auras = Array.from({ length: 64 }, (_, slot) => ({ ...mage.player!.auras[slot % 5]!,
    slot, positive: slot < 40, count: slot % 4 }));
  return [mage, rogue, druid, knight, dead, offline, crowded];
}
