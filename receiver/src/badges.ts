// SPDX-License-Identifier: GPL-2.0-or-later
// Fixed artwork names only: client input can never select an arbitrary download URL.
const classIcons: Record<number, string> = {
  1: "classicon_warrior", 2: "classicon_paladin", 3: "classicon_hunter", 4: "classicon_rogue",
  5: "classicon_priest", 6: "classicon_deathknight", 7: "classicon_shaman", 8: "classicon_mage",
  9: "classicon_warlock", 11: "classicon_druid",
};
const creatureIcons: Record<number, string> = {
  1: "ability_hunter_pet_wolf", 2: "inv_misc_head_dragon_01", 3: "spell_shadow_metamorphosis",
  4: "spell_frost_summonwaterelemental", 5: "ability_racial_avatar", 6: "spell_shadow_raisedead",
  7: "spell_holy_prayerofhealing", 8: "spell_nature_polymorph", 9: "inv_misc_gear_01",
  11: "spell_nature_stoneskintotem", 12: "ability_hunter_pet_cat", 13: "spell_nature_abolishmagic",
};
export type BadgeKind = "class" | "creature";
export function badgeIcon(kind: BadgeKind, id: number): string | undefined {
  return (kind === "class" ? classIcons : creatureIcons)[id];
}

// Original vector pictograms keep every avatar graphical without bundled third-party artwork or network access.
const sword = '<path d="M24 39 44 8 49 5 49 13 29 43M19 34 34 45M25 40 17 52M13 49 20 54"/>';
const shield = '<path d="M32 7 50 14V31Q49 45 32 56 15 45 14 31V14Z"/>';
const person = '<circle cx="32" cy="21" r="10"/><path d="M13 53V46Q14 35 32 35 50 35 51 46V53Z"/>';
const paw = '<ellipse cx="32" cy="42" rx="15" ry="11"/><ellipse cx="15" cy="27" rx="5" ry="7"/>' +
  '<ellipse cx="27" cy="19" rx="5" ry="7"/><ellipse cx="40" cy="20" rx="5" ry="7"/>' +
  '<ellipse cx="50" cy="30" rx="5" ry="7"/>';
const skull = '<path d="M20 42Q11 39 13 25 14 10 32 10 50 10 51 25 53 39 44 42V52H20Z"/>' +
  '<circle cx="24" cy="29" r="5"/><circle cx="40" cy="29" r="5"/><path d="m29 40 3-5 3 5M27 46V52M37 46V52"/>';
const bolt = '<path d="M35 5 13 35H30L25 59 51 26H34Z"/>';
const leaf = '<path d="M13 49Q3 18 52 9 57 52 22 52ZM16 49 43 21M28 37V22M28 37 43 37"/>';
const star = '<path d="m32 8 6 15 16 1-13 11 4 18-13-10-14 10 5-18L9 24 17-1Z"/>';
const classShapes: Record<number, string> = {
  1: sword,
  2: shield + '<path d="M32 19V40M23 28H41"/>',
  3: '<path d="M19 9Q61 30 19 55L27 32ZM9 32H54M46 25 54 32 46 39"/>',
  4: sword + '<path d="m16 8 23 35M12 7 16 8 19 14M32 43 42 37M38 42 45 53"/>',
  5: '<ellipse cx="32" cy="12" rx="16" ry="6"/><path d="M27 24H37V33H47V43H37V57H27V43H17V33H27Z"/>',
  6: skull,
  7: bolt,
  8: '<path d="M18 55 43 17M38 12 43 5 48 12 43 19ZM13 16H23M18 11V21M41 42H53M47 36V48"/>',
  9: '<path d="M18 23 9 7 29 18M46 23 55 7 35 18M18 22 32 15 46 22V42L32 55 18 42Z"/>' +
    '<path d="m24 29 5 5M40 29 35 34M26 43H38"/>',
  11: leaf,
};
const creatureShapes: Record<number, string> = {
  1: paw,
  2: '<path d="M17 53 20 38 10 20 29 26 39 9 54 19 47 30 34 36 32 52ZM38 17 43 19M35 34 45 42"/>',
  3: classShapes[9]!,
  4: '<path d="M32 7Q51 29 51 39A19 19 0 0 1 13 39Q13 27 32 7ZM22 37Q18 47 31 49"/>',
  5: '<path d="M16 49V30L22 22H41L48 31V49ZM23 22V10H41V22M25 33V43M39 33V43"/>',
  6: skull,
  7: person,
  8: paw,
  9: '<path d="m26 8-2 8-7 4-8-1-4 12 7 5 3 7-2 8 12 6 6-7 8-1 7 4 9-9-4-7 1-8 7-6-6-12-8 2-7-3-5-7Z"/>' +
    '<circle cx="32" cy="32" r="10"/>',
  11: '<path d="M24 8H40V55H24ZM12 18H52V29H12ZM13 39H51M28 15H36M29 36H35M29 47H35"/>',
  12: paw,
  13: '<path d="M15 44a10 10 0 0 1-2-20 15 15 0 0 1 28-5 12 12 0 0 1 8 25ZM22 51H43M28 57H37"/>',
};
export function badgeSvg(kind: BadgeKind, id: number): string {
  const shape = (kind === "class" ? classShapes : creatureShapes)[id] ?? (kind === "class" ? shield : star);
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    '<g fill="none" stroke="#f2dfae" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
    shape + '</g></svg>';
}
