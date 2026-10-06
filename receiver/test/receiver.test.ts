// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, expect, test } from "bun:test";
import { createReceiver, MAX_BODY, snapshotStream } from "../src/receiver.ts";
import type { ReceiverOptions } from "../src/receiver.ts";
import { Store } from "../src/store.ts";
import { batch, snapshot } from "../examples/fixtures.ts";
const receivers: ReturnType<typeof createReceiver>[] = [];
afterEach(async () => { await Promise.all(receivers.splice(0).map((r) => r.stop())); });
function fixture(token?: string, options: ReceiverOptions = {}) {
  const receiver = createReceiver({ port: 0, token, output: { async write() {} }, ...options });
  receivers.push(receiver);
  const get = (path: string) => fetch(new URL(path, receiver.server.url));
  const send = (value: unknown = batch(), headers: Record<string, string> = {}) =>
    fetch(new URL("/units", receiver.server.url), {
    method: "POST", body: JSON.stringify(value), headers: { "Content-Type": "application/json", ...headers },
  });
  return { ...receiver, get activeRequests() { return receiver.activeRequests; }, get, send };
}
test("ingestion authentication, schema, and public viewing routes", async () => {
  const { send, get } = fixture("test-token");
  expect((await send()).status).toBe(401);
  const auth = { Authorization: "Bearer test-token" };
  expect((await send({ schema_version: 2 }, auth)).status).toBe(422);
  expect((await send(batch(), auth)).status).toBe(204);
  const read = await get("/api/units?source=realm-1&character=ALICE");
  expect(read.headers.get("cache-control")).toBe("no-store");
  expect((await read.json()).player.health.value).toBe(18450);
  for (const asset of ["/widget", "/widget.js", "/render.js", "/widget.css"]) {
    expect((await get(asset)).status).toBe(200);
  }
  expect((await get("/src/main.ts")).status).toBe(404);
  expect((await get("/units")).status).toBe(405);
});
test("logs authenticated valid requests as JSON lines, including retries, without headers", async () => {
  const lines: string[] = [];
  const { send } = fixture("test-token", { output: { async write(line) { lines.push(line); } } });
  const data = batch({ ...snapshot(), name: "Alice\nForged log line" });
  expect((await send(data)).status).toBe(401);
  const auth = { Authorization: "Bearer test-token" };
  expect((await send({ bad: "payload" }, auth)).status).toBe(422);
  expect(lines).toEqual([]);
  expect((await send(data, auth)).status).toBe(204);
  expect((await send(data, auth)).status).toBe(204);
  expect(lines).toEqual([`${JSON.stringify(data)}\n`, `${JSON.stringify(data)}\n`]);
  expect(lines[0]!.split("\n")).toHaveLength(2);
  expect(lines.join("")).not.toContain("test-token");
});
test("serializes stdout backpressure, bounds admission, and includes output delay in capture age", async () => {
  const lines: string[] = [];
  const gate = Promise.withResolvers<void>();
  const receiver = fixture(undefined, { output: { async write(line) { lines.push(line); await gate.promise; } } });
  const pending = Array.from({ length: 4 }, (_, i) => receiver.send(batch({ ...snapshot(), sequence: String(i + 1) })));
  try {
    for (let i = 0; i < 50 && receiver.activeRequests !== 4; ++i) await Bun.sleep(5);
    expect(receiver.activeRequests).toBe(4);
    expect(receiver.store.view("realm-1", snapshot().guid)).toBeNull();
    expect(lines).toHaveLength(1);
    expect((await receiver.send()).status).toBe(503);
    await Bun.sleep(40);
    gate.resolve();
    expect((await Promise.all(pending)).map((response) => response.status)).toEqual([204, 204, 204, 204]);
    expect(lines).toHaveLength(4);
    const view = receiver.store.view("realm-1", snapshot().guid)!;
    expect(view.sequence).toBe("4"); expect(view.age_ms).toBeGreaterThanOrEqual(40);
  } finally { gate.resolve(); await Promise.all(pending); }
});
test("stdout failure returns retryable errors without publishing unlogged state and closes once", async () => {
  let writes = 0; let closes = 0;
  const diagnostics: string[] = [];
  const { send, store, stop } = fixture(undefined, {
    output: { async write() { ++writes; throw new Error("Broken output"); }, async close() { ++closes; } },
    diagnostic: (message) => diagnostics.push(message),
  });
  const failed = await send();
  expect(failed.status).toBe(503); expect(failed.headers.get("retry-after")).toBe("1");
  expect((await send()).status).toBe(503); expect(writes).toBe(1);
  expect(store.view("realm-1", snapshot().guid)).toBeNull();
  expect(diagnostics).toEqual(["Unit widget receiver: stdout failed; new batches will receive HTTP 503"]);
  await Promise.all([stop(), stop()]); expect(closes).toBe(1);
});
test("serves graphical class and creature fallbacks locally without an icon provider", async () => {
  const { get } = fixture();
  for (const path of ["/badges/class/1", "/badges/class/6", "/badges/creature/7", "/badges/creature/32"]) {
    const response = await get(path);
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("image/svg+xml");
    const svg = await response.text();
    expect(svg).toContain("<svg"); expect(svg).not.toContain("<text"); expect(svg).not.toContain("<script");
  }
  expect((await get("/icons/class/1")).status).toBe(404);
  expect((await get("/icons/arbitrary/1")).status).toBe(404);
});
test("invalid uploads, compression, oversized bodies, and invalid character selectors", async () => {
  const { send, get, server } = fixture();
  expect((await send(batch(), { "Content-Type": "text/plain" })).status).toBe(415);
  expect((await send(batch(), { "Content-Encoding": "gzip" })).status).toBe(415);
  expect((await fetch(new URL("/units", server.url), { method: "POST", body: "{", headers: {
    "Content-Type": "application/json" } })).status).toBe(400);
  expect((await send({ junk: "x".repeat(MAX_BODY) })).status).toBe(413);
  expect((await get("/api/units?source=realm-1")).status).toBe(400);
  expect((await get("/api/units?source=realm-1&character=missing")).status).toBe(404);
  expect((await get("/api/units?source=realm-1&guid=missing")).status).toBe(200);
  expect((await get("/api/characters")).status).toBe(400);
});
test("SSE gets a current snapshot immediately, follows GUID after rename, and recovers by snapshot", async () => {
  const { send, get } = fixture();
  await send();
  const response = await get("/api/units/stream?source=realm-1&character=Alice");
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain('"name":"Alice"');
  await send(batch({ ...snapshot(), name: "Renamed", sequence: "2", target: null }));
  const second = new TextDecoder().decode((await reader.read()).value);
  expect(second).toContain('"name":"Renamed"'); expect(second).toContain('"target":null');
  await reader.cancel();
  const again = await get(`/api/units/stream?source=realm-1&guid=${snapshot().guid}`);
  const reread = again.body!.getReader();
  expect(new TextDecoder().decode((await reread.read()).value)).toContain('"sequence":"2"');
  await reread.cancel();
});
test("SSE disconnects slow consumers and releases subscriptions", async () => {
  const store = new Store();
  store.ingest(batch());
  let closed = 0;
  const stream = snapshotStream(store, "realm-1", snapshot().guid, new AbortController().signal, () => ++closed, 6000);
  for (let sequence = 2; sequence < 10; ++sequence) store.ingest(batch({ ...snapshot(), sequence: String(sequence) }));
  expect(closed).toBe(1);
  expect(stream.closed).toBe(true);
  const reader = stream.stream.getReader();
  while (!(await reader.read()).done) { /* Drain the bounded queue. */ }
  await reader.cancel();
  expect(closed).toBe(1);
});
test("SSE emits staleness even when no more uploads arrive", async () => {
  let now = 0;
  const store = new Store(() => now);
  store.ingest(batch());
  const abort = new AbortController();
  const connection = snapshotStream(store, "realm-1", snapshot().guid, abort.signal);
  const reader = connection.stream.getReader();
  await reader.read();
  now = 5001;
  const changed = new TextDecoder().decode((await reader.read()).value);
  expect(changed).toContain('"stale":true'); expect(changed).toContain('"target":null');
  await reader.cancel();
});
test("already aborted streams do not leave timers or subscriptions", async () => {
  const abort = new AbortController(); abort.abort();
  let closed = 0;
  const connection = snapshotStream(new Store(), "realm-1", "guid", abort.signal, () => ++closed);
  expect(connection.closed).toBe(true); expect(closed).toBe(1);
  await connection.stream.cancel();
});
test("slow uploads occupy bounded slots, expire, and release admission", async () => {
  const receiver = createReceiver({ port: 0, bodyTimeoutMs: 500, output: { async write() {} } });
  receivers.push(receiver);
  const sockets: ReturnType<typeof Bun.connect> extends Promise<infer T> ? T[] : never = [];
  const replies: Promise<number>[] = [];
  for (let i = 0; i < 4; ++i) {
    const result = Promise.withResolvers<number>();
    let response = "";
    const socket = await Bun.connect({ hostname: "127.0.0.1", port: receiver.server.port!, socket: {
      open(socket) {
        socket.write("POST /units HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n" +
          "Transfer-Encoding: chunked\r\n\r\n1\r\n{\r\n");
      },
      data(_socket, bytes) {
        response += new TextDecoder().decode(bytes);
        const status = /^HTTP\/1.1 (\d{3})/.exec(response);
        if (status) result.resolve(Number(status[1]));
      },
      error(_socket, error) { result.reject(error); },
    } });
    sockets.push(socket);
    replies.push(result.promise);
  }
  try {
    for (let i = 0; i < 50 && receiver.activeRequests !== 4; ++i) await Bun.sleep(5);
    expect(receiver.activeRequests).toBe(4);
    const busy = await fetch(new URL("/units", receiver.server.url), { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch()) });
    expect(busy.status).toBe(503);
    expect(await Promise.all(replies)).toEqual([408, 408, 408, 408]);
    expect(receiver.activeRequests).toBe(0);
    const next = await fetch(new URL("/units", receiver.server.url), { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(batch()) });
    expect(next.status).toBe(204);
  } finally { for (const socket of sockets) socket.terminate(); }
});
