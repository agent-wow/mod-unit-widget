// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IconFetch } from "../src/icons.ts";
import { Icons } from "../src/icons.ts";
const folders: string[] = [];
const opened: Icons[] = [];
afterEach(async () => {
  for (const icons of opened.splice(0)) icons.close();
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});
async function temp() {
  const folder = await mkdtemp(join(tmpdir(), "unit-widget-icons-")); folders.push(folder); return folder;
}
async function open(options: Parameters<typeof Icons.open>[0]) {
  const icons = await Icons.open(options); opened.push(icons); return icons;
}
const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
function provider(log: string[]): IconFetch {
  return (async (url: string | URL | Request) => {
    const path = String(url); log.push(path);
    return path.includes("tooltip") ? Response.json({ icon: "spell_frost_frostbolt02" }) :
      new Response(jpg, { headers: { "Content-Type": "image/jpeg" } });
  }) as IconFetch;
}
test("uses only spell IDs online and persists successful icons across offline restarts", async () => {
  const directory = await temp();
  const cachePath = join(directory, "cache.sqlite");
  const log: string[] = [];
  const icons = await open({ directory, cachePath, fetcher: provider(log) });
  const [first, duplicate] = await Promise.all([icons.get(116), icons.get(116)]);
  expect(first!.bytes).toEqual(jpg); expect(duplicate!.bytes).toEqual(jpg); expect(log.length).toBe(2);
  expect(log[0]).toBe("https://nether.wowhead.com/wotlk/tooltip/spell/116");
  icons.close();
  const offline = await open({ directory, cachePath, mode: "offline", fetcher: provider(log) });
  expect((await offline.get(116))!.bytes).toEqual(jpg);
  expect(await offline.get(999)).toBeNull(); expect(log.length).toBe(2);
});
test("local manifest overrides cached images, works offline, and confines paths", async () => {
  const directory = await temp();
  await writeFile(join(directory, "manifest.json"), JSON.stringify({ 116: "custom.png" }));
  await writeFile(join(directory, "custom.png"), "local artwork");
  const log: string[] = [];
  const icons = await open({ directory, cachePath: ":memory:", mode: "offline", fetcher: provider(log) });
  expect(new TextDecoder().decode((await icons.get(116))!.bytes)).toBe("local artwork"); expect(log).toEqual([]);
  const outside = join(directory, "outside"); await mkdir(outside);
  await writeFile(join(outside, "secret.png"), "not an icon");
  await rm(join(directory, "custom.png"));
  // A symlink outside the configured icon root must not be served.
  const root = join(directory, "root"); await mkdir(root);
  await writeFile(join(root, "manifest.json"), JSON.stringify({ 116: "escape.png" }));
  await symlink(join(outside, "secret.png"), join(root, "escape.png"));
  const confined = await open({ directory: root, cachePath: ":memory:", mode: "offline" });
  expect(await confined.get(116)).toBeNull();
});
test("provider errors are negatively cached and downloaded bodies are bounded", async () => {
  let calls = 0; let now = 0;
  const icons = await open({ directory: await temp(), cachePath: ":memory:", now: () => now,
    fetcher: (async () => { ++calls; return new Response("x".repeat(128 * 1024 + 1)); }) as IconFetch });
  expect(await icons.get(116)).toBeNull(); expect(await icons.get(116)).toBeNull(); expect(calls).toBe(1);
  now = 61000; expect(await icons.get(116)).toBeNull(); expect(calls).toBe(2);
});
test("rejects provider path injection and never follows an arbitrary icon URL", async () => {
  let calls = 0;
  const icons = await open({ directory: await temp(), cachePath: ":memory:",
    fetcher: (async () => {
      ++calls; return Response.json({ icon: "../../secret?url=http://localhost" });
    }) as IconFetch });
  expect(await icons.get(116)).toBeNull(); expect(calls).toBe(1);
});
test("cache byte budget evicts old icons and lookup concurrency stays bounded", async () => {
  const log: string[] = [];
  const icons = await open({ directory: await temp(), cachePath: ":memory:", maxBytes: 6, fetcher: provider(log) });
  await icons.get(1); await icons.get(2); await icons.get(1);
  expect(log.length).toBe(6);
  let active = 0; let peak = 0;
  const gate = Promise.withResolvers<void>();
  const limited = await open({ directory: await temp(), cachePath: ":memory:", fetcher: (async () => {
    ++active; peak = Math.max(peak, active); await gate.promise; --active;
    return new Response(null, { status: 503 });
  }) as IconFetch });
  const pending = Array.from({ length: 20 }, (_, i) => limited.get(i + 1));
  await Bun.sleep(10); gate.resolve(); await Promise.all(pending);
  expect(peak).toBe(4);
});
test("class and creature artwork uses fixed CDN names and persists separately from spell icons", async () => {
  const directory = await temp();
  const cachePath = join(directory, "cache.sqlite");
  const log: string[] = [];
  const icons = await open({ directory, cachePath, fetcher: provider(log) });
  expect((await icons.getBadge("class", 1))!.bytes).toEqual(jpg);
  expect((await icons.getBadge("creature", 7))!.bytes).toEqual(jpg);
  expect(log).toEqual([
    "https://wow.zamimg.com/images/wow/icons/large/classicon_warrior.jpg",
    "https://wow.zamimg.com/images/wow/icons/large/spell_holy_prayerofhealing.jpg",
  ]);
  expect(await icons.getBadge("class", 10)).toBeNull();
  expect(await icons.getBadge("creature", 32)).toBeNull();
  expect(await icons.get(-101)).toBeNull();
  icons.close();
  const offline = await open({ directory, cachePath, mode: "offline", fetcher: provider(log) });
  expect((await offline.getBadge("class", 1))!.bytes).toEqual(jpg);
  expect((await offline.getBadge("creature", 7))!.bytes).toEqual(jpg);
  expect(await offline.get(1)).toBeNull(); expect(log).toHaveLength(2);
});
test("class and creature manifest overrides take priority over cached artwork in offline mode", async () => {
  const directory = await temp();
  const cachePath = join(directory, "cache.sqlite");
  const log: string[] = [];
  const online = await open({ directory, cachePath, fetcher: provider(log) });
  await online.getBadge("class", 1); online.close();
  await writeFile(join(directory, "manifest.json"), JSON.stringify({
    "class-1": "warrior.png", "creature-7": "humanoid.webp",
  }));
  await writeFile(join(directory, "warrior.png"), "custom warrior");
  await writeFile(join(directory, "humanoid.webp"), "custom humanoid");
  const offline = await open({ directory, cachePath, mode: "offline", fetcher: provider(log) });
  expect(new TextDecoder().decode((await offline.getBadge("class", 1))!.bytes)).toBe("custom warrior");
  expect(new TextDecoder().decode((await offline.getBadge("creature", 7))!.bytes)).toBe("custom humanoid");
  expect(await offline.getBadge("class", 6)).toBeNull(); expect(log).toHaveLength(1);
});
