// SPDX-License-Identifier: GPL-2.0-or-later
import { Database } from "bun:sqlite";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { badgeIcon } from "./badges.ts";
import type { BadgeKind } from "./badges.ts";

export interface Icon { bytes: Uint8Array; type: string }
export type IconFetch = (url: string, options: RequestInit) => Promise<Response>;
export interface IconOptions {
  mode?: "hybrid" | "offline"; directory?: string; cachePath?: string; maxBytes?: number;
  fetcher?: IconFetch; now?: () => number;
}
const LIMIT = 128 * 1024;
const MIME: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
async function bounded(response: Response): Promise<Uint8Array> {
  if (!response.ok || Number(response.headers.get("content-length")) > LIMIT || !response.body) {
    await response.body?.cancel();
    throw new Error("Icon unavailable");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > LIMIT) throw new Error("Icon response too large");
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
export class Icons {
  private database: Database;
  private manifest: Record<string, string> = {};
  private directory: string;
  private pending = new Map<number, Promise<Icon | null>>();
  private failures = new Map<number, number>();
  private active = 0;
  private closed = false;
  private maxBytes: number;
  private now: () => number;
  private fetcher: IconFetch;
  private options: IconOptions;
  private constructor(options: IconOptions, database: Database) {
    this.options = options;
    this.database = database;
    this.directory = resolve(options.directory ?? "./icons");
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? fetch;
    database.exec("CREATE TABLE IF NOT EXISTS icons (id INTEGER PRIMARY KEY, bytes BLOB, type TEXT, used INTEGER)");
  }
  static async open(options: IconOptions = {}) {
    const path = options.cachePath ?? "./data/icons.sqlite";
    if (path !== ":memory:") await mkdir(dirname(resolve(path)), { recursive: true });
    const icons = new Icons(options, new Database(path));
    try {
      const manifestPath = resolve(icons.directory, "manifest.json");
      if ((await stat(manifestPath)).size > 2 * 1024 * 1024) throw new Error("Icon manifest exceeds 2 MiB");
      const value: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid icon manifest");
      for (const [id, filename] of Object.entries(value)) {
        const badge = /^(class|creature)-([0-9]{1,2})$/.exec(id);
        const validBadge = badge && badgeIcon(badge[1] as BadgeKind, Number(badge[2]));
        if ((!/^[1-9][0-9]{0,9}$/.test(id) && !validBadge) || typeof filename !== "string" ||
          !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\.(png|jpe?g|webp)$/.test(filename)) {
          throw new Error("Invalid icon manifest entry");
        }
        icons.manifest[id] = filename;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { icons.close(); throw error; }
    }
    return icons;
  }
  async get(id: number): Promise<Icon | null> {
    if (!Number.isInteger(id) || id < 1 || id > 0xffffffff) return null;
    return this.getIcon(id, String(id));
  }
  async getBadge(kind: BadgeKind, id: number): Promise<Icon | null> {
    const icon = badgeIcon(kind, id);
    if (!icon) return null;
    // Negative IDs reserve a separate cache namespace without changing existing spell caches.
    return this.getIcon(-(kind === "class" ? 100 : 200) - id, `${kind}-${id}`, icon);
  }
  private async getIcon(id: number, key: string, artwork?: string): Promise<Icon | null> {
    if (this.closed) return null;
    const existing = this.pending.get(id);
    if (existing) return existing;
    if (this.pending.size >= 32) return null;
    const task = this.load(id, key, artwork).catch(() => null).finally(() => this.pending.delete(id));
    this.pending.set(id, task);
    return task;
  }
  private async load(id: number, key: string, artwork?: string): Promise<Icon | null> {
    const filename = this.manifest[key];
    if (filename) {
      try {
        const [root, file] = await Promise.all([realpath(this.directory), realpath(resolve(this.directory, filename))]);
        if (!file.startsWith(root + sep) || (await stat(file)).size > LIMIT) throw new Error("Invalid local icon");
        return { bytes: await readFile(file), type: MIME[filename.split(".").at(-1)!]! };
      } catch { /* A missing local override falls through to the cached/online icon. */ }
    }
    if (this.closed) return null;
    const cached = this.database.query("SELECT bytes, type FROM icons WHERE id = ?").get(id) as Icon | null;
    if (cached) {
      this.database.query("UPDATE icons SET used = ? WHERE id = ?").run(this.now(), id);
      return cached;
    }
    if (this.options.mode === "offline" || this.active >= 4 || (this.failures.get(id) ?? 0) > this.now()) return null;
    ++this.active;
    try {
      let icon: unknown = artwork;
      if (!icon) {
        const metadata = await bounded(await this.fetcher(`https://nether.wowhead.com/wotlk/tooltip/spell/${id}`, {
          signal: AbortSignal.timeout(3000), redirect: "error",
        }));
        icon = JSON.parse(new TextDecoder().decode(metadata)).icon;
      }
      if (typeof icon !== "string" || !/^[a-z0-9_]{1,128}$/.test(icon)) throw new Error("Invalid icon name");
      const response = await this.fetcher(`https://wow.zamimg.com/images/wow/icons/large/${icon}.jpg`, {
        signal: AbortSignal.timeout(3000), redirect: "error",
      });
      const type = response.headers.get("content-type")?.split(";")[0];
      if (type !== "image/jpeg") { await response.body?.cancel(); throw new Error("Invalid image type"); }
      const bytes = await bounded(response);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw new Error("Invalid image");
      if (this.closed || bytes.length > this.maxBytes) return null;
      this.database.transaction(() => {
        this.database.query("INSERT OR REPLACE INTO icons VALUES (?, ?, ?, ?)").run(id, bytes, type, this.now());
        let total = (this.database.query("SELECT coalesce(sum(length(bytes)), 0) AS size FROM icons").get() as
          { size: number }).size;
        while (total > this.maxBytes) {
          const oldest = this.database.query("SELECT id, length(bytes) AS size FROM icons ORDER BY used, id LIMIT 1")
            .get() as { id: number; size: number };
          this.database.query("DELETE FROM icons WHERE id = ?").run(oldest.id);
          total -= oldest.size;
        }
      })();
      return { bytes, type };
    } catch {
      if (this.failures.size >= 10000) this.failures.delete(this.failures.keys().next().value!);
      this.failures.set(id, this.now() + 60000);
      return null;
    } finally { --this.active; }
  }
  close() { if (!this.closed) { this.closed = true; this.database.close(); } }
}
