// SPDX-License-Identifier: GPL-2.0-or-later
/** @typedef {import('../schema.ts').Frame} Frame */
/** @typedef {import('../schema.ts').Aura} Aura */
const classes = ["", "Warrior", "Paladin", "Hunter", "Rogue", "Priest", "Death Knight",
  "Shaman", "Mage", "Warlock", "", "Druid"];
const colors = ["#8e8874", "#c79c6e", "#f58cba", "#abd473", "#fff569", "#ffffff", "#c41f3b", "#0070de",
  "#69ccf0", "#9482c9", "#999", "#ff7d0a"];
const powerColors = ["#428af4", "#d93f38", "#cb793e", "#dfc84b", "#50b48d", "#8aacc7", "#36bbdf"];
const powerNames = ["Mana", "Rage", "Focus", "Energy", "Happiness", "Runes", "Runic power"];
const creatures = ["Creature", "Beast", "Dragonkin", "Demon", "Elemental", "Giant", "Undead", "Humanoid",
  "Critter", "Mechanical", "Unknown", "Totem", "Companion", "Gas cloud"];
/** @param {number} value @param {number} max */
export function fraction(value, max) { return max > 0 ? Math.max(0, Math.min(1, value / max)) : 0; }
/** @param {number} milliseconds */
export function timeLabel(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return seconds >= 3600 ? `${Math.ceil(seconds / 3600)}h`
    : seconds >= 60 ? `${Math.ceil(seconds / 60)}m` : `${seconds}`;
}
/** @param {string} tag @param {string} cls @param {HTMLElement=} parent */
function element(tag, cls, parent) {
  const el = document.createElement(tag);
  el.className = cls;
  parent?.append(el);
  return el;
}
/** @param {HTMLElement} parent @param {string} cls */
function bar(parent, cls) {
  const root = element("div", `bar ${cls}`, parent);
  return { root, fill: element("div", "fill", root), text: element("span", "bar-text", root) };
}
/** @param {string} url */
function artwork(url) {
  const img = document.createElement("img");
  img.alt = "";
  img.className = "failed";
  let retry = 0;
  img.onerror = () => {
    img.className = "failed";
    ++retry;
    setTimeout(() => {
      if (img.isConnected) img.src = `${url}?retry=${retry}`;
    }, Math.min(1000 * 2 ** Math.min(retry, 6), 60000));
  };
  img.onload = () => { img.className = ""; };
  img.src = url;
  return img;
}
/** @param {HTMLElement} parent @param {number} id @param {string} name */
function icon(parent, id, name) {
  const root = element("div", "spell-icon", parent);
  root.title = name;
  root.setAttribute("aria-label", name);
  root.append(document.createTextNode(name.split(/\s+/).map((s) => s[0]).slice(0, 2).join("")));
  root.append(artwork(`/icons/${id}`));
  return root;
}
export class UnitFrame {
  /** @param {HTMLElement} parent @param {string} role */
  constructor(parent, role) {
    this.root = element("section", "frame empty", parent);
    this.root.dataset.role = role;
    this.root.setAttribute("aria-label", `${role} frame`);
    this.plate = element("div", "plate", this.root);
    this.badge = element("div", "badge", this.plate);
    this.badge.setAttribute("role", "img");
    this.badgeKey = "";
    this.updateBadge("class", 0, "Character");
    this.level = element("div", "level", this.plate);
    const heading = element("div", "heading", this.plate);
    this.name = element("span", "name", heading);
    this.rank = element("span", "rank", heading);
    this.health = bar(this.plate, "health");
    this.power = bar(this.plate, "power");
    this.status = element("div", "statuses", this.plate);
    this.extra = element("div", "extra", this.root);
    this.castRoot = element("div", "cast hidden", this.root);
    this.castIcon = element("div", "cast-icon-holder", this.castRoot);
    const track = element("div", "cast-track", this.castRoot);
    this.castFill = element("div", "cast-fill", track);
    const label = element("div", "cast-label", track);
    this.castName = element("span", "cast-name", label);
    this.castTime = element("span", "cast-time", label);
    const groups = element("div", "aura-groups", this.root);
    this.buffs = element("div", "aura-row buffs", groups);
    this.debuffs = element("div", "aura-row debuffs", groups);
    /** @type {Map<number, { id: number, root: HTMLElement, count: HTMLElement, time: HTMLElement }>} */
    this.auras = new Map();
    /** @type {Frame | null} */
    this.data = null;
    this.received = 0;
    this.age = 0;
    this.extraKey = "";
    this.castId = "";
    this.guid = "";
  }
  /** @param {string} name @param {string} status */
  inactive(name, status) {
    this.root.classList.remove("empty");
    this.root.classList.add("inactive");
    this.name.textContent = name;
    this.status.textContent = status;
    this.castRoot.classList.add("hidden");
    this.data = null;
  }
  hide() { this.root.classList.add("empty"); this.data = null; }
  /** @param {string} kind @param {number} id @param {string} label */
  updateBadge(kind, id, label) {
    const key = `${kind}/${id}`;
    if (this.badgeKey === key) return;
    this.badgeKey = key;
    this.badge.title = label;
    this.badge.setAttribute("aria-label", label);
    const fallback = document.createElement("img");
    fallback.alt = "";
    fallback.className = "badge-fallback";
    fallback.src = `/badges/${key}`;
    this.badge.replaceChildren(fallback);
    if (id > 0) this.badge.append(artwork(`/icons/${key}`));
  }
  /** @param {Frame} frame @param {number} age */
  update(frame, age) {
    const changedUnit = this.guid !== frame.guid;
    if (changedUnit) {
      this.guid = frame.guid;
      this.castId = "";
      this.extraKey = "";
      for (const aura of this.auras.values()) aura.root.remove();
      this.auras.clear();
    }
    this.root.classList.remove("empty", "inactive");
    this.data = frame;
    this.received = performance.now();
    this.age = age;
    this.name.textContent = frame.name;
    this.name.title = frame.name;
    this.name.style.color = frame.reaction === "hostile" ? "#f09b89"
      : frame.reaction === "neutral" ? "#ffe593" : "#f4ddb0";
    this.level.textContent = frame.rank === 3 ? "☠" : String(frame.level);
    const kind = frame.kind === "player" ? classes[frame.class_id] || "Player"
      : creatures[frame.creature_type] || "Creature";
    this.updateBadge(frame.kind === "player" ? "class" : "creature",
      frame.kind === "player" ? frame.class_id : frame.creature_type, kind);
    this.root.style.setProperty("--class-color", colors[frame.class_id] || colors[0] || "#888");
    this.rank.textContent = ["", "Elite", "Rare elite", "Boss", "Rare"][frame.rank] || "";
    this.health.fill.style.transform = `scaleX(${fraction(frame.health.value, frame.health.max)})`;
    this.health.text.textContent = `${frame.health.value.toLocaleString()} / ${frame.health.max.toLocaleString()}`;
    this.power.root.style.visibility = frame.power ? "visible" : "hidden";
    if (frame.power) {
      this.power.fill.style.background = `linear-gradient(${powerColors[frame.power.type]}, #121b2780)`;
      this.power.fill.style.transform = `scaleX(${fraction(frame.power.value, frame.power.max)})`;
      this.power.text.textContent = `${Math.floor(frame.power.value)} / ${Math.floor(frame.power.max)}`;
      this.power.root.title = powerNames[frame.power.type] || "Resource";
    }
    this.status.textContent = frame.statuses.map((s) => s.toUpperCase()).join(" · ");
    const extraKey = JSON.stringify([frame.extra.combo_points, frame.extra.mana, frame.extra.runes.map((r) => r.type)]);
    if (extraKey !== this.extraKey) {
      this.extraKey = extraKey;
      this.extra.replaceChildren();
      for (const rune of frame.extra.runes) {
        const el = element("span", "rune", this.extra);
        el.style.setProperty("--rune-color", ["#c8364c", "#4acf73", "#58b7ed", "#a176d8"][rune.type] || "#aaa");
        el.title = ["Blood", "Unholy", "Frost", "Death"][rune.type] || "Rune";
      }
      if (frame.extra.mana) {
        const mana = bar(this.extra, "power mana-reserve");
        mana.fill.style.transform = `scaleX(${fraction(frame.extra.mana.value, frame.extra.mana.max)})`;
        mana.text.textContent = `${Math.floor(frame.extra.mana.value)} mana`;
      }
      if (frame.extra.combo_points > 0) {
        const combo = element("div", "combo", this.extra);
        combo.title = `${frame.extra.combo_points} combo points on selected target`;
        for (let i = 0; i < 5; ++i) element("span", `point${i < frame.extra.combo_points ? " lit" : ""}`, combo);
      }
    }
    const seen = new Set();
    for (const aura of frame.auras) {
      seen.add(aura.slot);
      let entry = this.auras.get(aura.slot);
      const parent = aura.positive ? this.buffs : this.debuffs;
      if (!entry || entry.id !== aura.spell_id) {
        entry?.root.remove();
        const root = icon(parent, aura.spell_id, aura.name);
        entry = { id: aura.spell_id, root, count: element("span", "aura-count", root),
          time: element("span", "aura-time", root) };
        this.auras.set(aura.slot, entry);
      }
      if (entry.root.parentElement !== parent) parent.append(entry.root);
      entry.root.style.order = String(aura.slot);
      entry.count.textContent = aura.count > 1 ? String(aura.count) : "";
    }
    for (const [slot, entry] of this.auras) if (!seen.has(slot)) { entry.root.remove(); this.auras.delete(slot); }
    const cast = frame.cast;
    this.castRoot.classList.toggle("hidden", !cast);
    if (cast) {
      if (this.castId !== `${cast.id}:${cast.spell_id}`) {
        this.castId = `${cast.id}:${cast.spell_id}`;
        this.castIcon.replaceChildren();
        icon(this.castIcon, cast.spell_id, cast.name);
      }
      this.castRoot.dataset.state = cast.state;
      this.castName.textContent = cast.name;
    }
    this.tick(performance.now());
  }
  /** @param {number} now */
  tick(now) {
    const frame = this.data;
    if (!frame) return;
    const elapsed = this.age + now - this.received;
    for (const aura of frame.auras) {
      const entry = this.auras.get(aura.slot);
      if (entry) entry.time.textContent = aura.remaining_ms === null ? "" : timeLabel(aura.remaining_ms - elapsed);
    }
    const runeEls = this.extra.querySelectorAll(".rune");
    frame.extra.runes.forEach((rune, i) => {
      const el = runeEls[i];
      if (!el) return;
      const remaining = Math.max(0, rune.remaining_ms - elapsed);
      el.classList.toggle("cooldown", remaining > 0);
      el.textContent = remaining > 0 ? timeLabel(remaining) : ["B", "U", "F", "D"][rune.type] || "";
    });
    const cast = frame.cast;
    if (cast) {
      const active = ["casting", "channeling"].includes(cast.state);
      const remaining = Math.max(0, cast.remaining_ms - elapsed);
      const ratio = cast.duration_ms < 0 ? 1 : cast.state === "channeling"
        ? fraction(remaining, cast.duration_ms) : 1 - fraction(remaining, cast.duration_ms);
      this.castFill.style.transform = `scaleX(${active ? ratio : 1})`;
      this.castTime.textContent = !active ? cast.state.toUpperCase()
        : cast.duration_ms < 0 ? "" : `${(remaining / 1000).toFixed(1)}s`;
    }
  }
}
