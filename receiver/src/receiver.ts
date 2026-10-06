// SPDX-License-Identifier: GPL-2.0-or-later
import { timingSafeEqual } from "node:crypto";
import { isBatch } from "./schema.ts";
import { Store, SelectionError } from "./store.ts";
import type { Icons } from "./icons.ts";
import { badgeSvg } from "./badges.ts";
import { stdoutOutput } from "./output.ts";
import type { BatchOutput } from "./output.ts";

export const MAX_BODY = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const assets = new Map([
  ["/widget", ["widget.html", "text/html; charset=utf-8"]],
  ["/widget.js", ["widget.js", "text/javascript; charset=utf-8"]],
  ["/render.js", ["render.js", "text/javascript; charset=utf-8"]],
  ["/widget.css", ["widget.css", "text/css; charset=utf-8"]],
]);
function failure(status: number, error: string) {
  return Response.json({ error }, { status, headers: { "Cache-Control": "no-store",
    ...(status === 503 ? { "Retry-After": "1" } : {}) } });
}
async function readBody(request: Request, timeout: number) {
  if (!request.body) throw new SelectionError(400, "Empty request body");
  const reader = request.body.getReader();
  const interrupted = Promise.withResolvers<never>();
  const timer = setTimeout(() => interrupted.reject(new SelectionError(408, "Upload deadline exceeded")), timeout);
  const abort = () => interrupted.reject(new SelectionError(400, "Upload interrupted"));
  request.signal.addEventListener("abort", abort, { once: true });
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    if (request.signal.aborted) throw new SelectionError(400, "Upload interrupted");
    while (true) {
      const { done, value } = await Promise.race([reader.read(), interrupted.promise]);
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BODY) throw new SelectionError(413, "Body exceeds 2 MiB");
      chunks.push(value);
    }
    const result = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(result);
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}

// Each subscriber has a byte budget, sends full snapshots, and never replays an event history.
export function snapshotStream(store: Store, source: string, guid: string, signal: AbortSignal,
  onClose: () => void = () => {}, highWaterMark = 256 * 1024) {
  let cleanup = () => {};
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let signature = "";
      let lastPing = performance.now();
      let unsubscribe = () => {};
      let timer: ReturnType<typeof setInterval> | undefined;
      cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer) clearInterval(timer);
        unsubscribe();
        signal.removeEventListener("abort", cleanup);
        onClose();
      };
      const send = (text: string) => {
        if (closed) return;
        const bytes = encoder.encode(text);
        if ((controller.desiredSize ?? 0) < bytes.length) {
          cleanup();
          controller.close();
          return;
        }
        controller.enqueue(bytes);
      };
      const update = () => {
        if (closed) return;
        const view = store.view(source, guid);
        const next = view ? `${view.process_id}:${view.sequence}:${view.stale}` : "waiting";
        if (signature !== next) {
          signature = next;
          send(`event: snapshot\ndata: ${JSON.stringify(view)}\n\n`);
        } else if (performance.now() - lastPing >= 15000) {
          lastPing = performance.now();
          send(": keepalive\n\n");
        }
      };
      signal.addEventListener("abort", cleanup, { once: true });
      unsubscribe = store.subscribe(update);
      timer = setInterval(update, 500);
      if (signal.aborted) cleanup();
      else update();
    },
    cancel() { cleanup(); },
  }, { highWaterMark, size: (chunk) => chunk?.byteLength ?? 0 });
  return { stream, close: cleanup, get closed() { return closed; } };
}

export interface ReceiverOptions {
  host?: string; port?: number; token?: string; store?: Store; icons?: Icons; bodyTimeoutMs?: number;
  output?: BatchOutput; diagnostic?: (message: string) => void;
}
export function createReceiver(options: ReceiverOptions = {}) {
  const store = options.store ?? new Store();
  const output = options.output ?? stdoutOutput();
  const diagnostic = options.diagnostic ?? ((message: string) => console.error(message));
  const digest = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest();
  const expected = options.token ? digest(`Bearer ${options.token}`) : null;
  const streams = new Set<() => void>();
  let active = 0;
  let stopping = false;
  let outputFailed = false;
  let writeQueue = Promise.resolve();
  let stopPromise: Promise<void> | undefined;
  const server = Bun.serve({
    hostname: options.host ?? "127.0.0.1", port: options.port ?? 3001,
    maxRequestBodySize: MAX_BODY, idleTimeout: 15,
    async fetch(request, server) {
      const url = new URL(request.url);
      try {
        if (stopping) return failure(503, "Receiver stopping");
        if (url.pathname === "/units") {
          if (request.method !== "POST") return failure(405, "Use POST /units");
          if (expected && !timingSafeEqual(expected, digest(request.headers.get("authorization") ?? ""))) {
            return failure(401, "Unauthorized");
          }
          if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" ||
            ![null, "identity"].includes(request.headers.get("content-encoding"))) {
            return failure(415, "Uncompressed application/json required");
          }
          if (Number(request.headers.get("content-length")) > MAX_BODY) return failure(413, "Body exceeds 2 MiB");
          if (outputFailed || active >= 4) return failure(503, "Receiver unavailable; retry this batch");
          server.timeout(request, 0);
          ++active;
          try {
            let value: unknown;
            try { value = JSON.parse(await readBody(request, options.bodyTimeoutMs ?? 3000)); }
            catch (error) {
              if (error instanceof SelectionError) throw error;
              throw new SelectionError(400, "Invalid JSON or UTF-8");
            }
            if (!isBatch(value)) return failure(422, "Invalid unit snapshot schema");
            if (stopping) return failure(503, "Receiver stopping");
            const accepted = value;
            const received = performance.now();
            const line = `${JSON.stringify(accepted)}\n`;
            // Like the chat receiver, acknowledge only after a complete JSON line has drained to stdout.
            // Four admitted requests also bound this queue when the output consumer is slow.
            const write = writeQueue.then(async () => {
              if (outputFailed) throw new SelectionError(503, "Receiver output unavailable");
              try { await output.write(line); }
              catch {
                outputFailed = true;
                diagnostic("Unit widget receiver: stdout failed; new batches will receive HTTP 503");
                throw new SelectionError(503, "Receiver output unavailable");
              }
              const delay = Math.max(0, Math.ceil(performance.now() - received));
              store.ingest({ ...accepted,
                snapshots: accepted.snapshots.map((s) => ({ ...s, age_ms: s.age_ms + delay })) });
            });
            writeQueue = write.catch(() => {});
            await write;
            return new Response(null, { status: 204 });
          } finally { --active; }
        }
        if (request.method !== "GET") return failure(405, "Use GET");
        const asset = assets.get(url.pathname);
        if (asset) return new Response(Bun.file(new URL(`./web/${asset[0]}`, import.meta.url)), {
          headers: { "Content-Type": asset[1]!, "Cache-Control": "no-cache",
            "Content-Security-Policy": "default-src 'self'; img-src 'self'; " +
              "style-src 'self' 'unsafe-inline'; connect-src 'self'" },
        });
        const badge = /^\/(icons|badges)\/(class|creature)\/([0-9]{1,2})$/.exec(url.pathname);
        if (badge) {
          const kind = badge[2] as "class" | "creature";
          const id = Number(badge[3]);
          if (badge[1] === "badges") return new Response(badgeSvg(kind, id), {
            headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=3600",
              "X-Content-Type-Options": "nosniff" },
          });
          const icon = await options.icons?.getBadge(kind, id);
          if (!icon) return failure(404, "Icon unavailable");
          return new Response(new Uint8Array(icon.bytes), { headers: { "Content-Type": icon.type,
            "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
        }
        const match = /^\/icons\/([1-9][0-9]{0,9})$/.exec(url.pathname);
        if (match) {
          const id = Number(match[1]);
          if (id > 0xffffffff) return failure(400, "Invalid spell ID");
          const icon = await options.icons?.get(id);
          if (!icon) return failure(404, "Icon unavailable");
          return new Response(new Uint8Array(icon.bytes), { headers: { "Content-Type": icon.type,
            "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" } });
        }
        if (url.pathname === "/api/characters") {
          const source = url.searchParams.get("source");
          if (!source || source.length > 256) return failure(400, "Source required");
          return Response.json({ characters: store.characters(source, url.searchParams.get("character") ?? undefined) },
            { headers: { "Cache-Control": "no-store" } });
        }
        if (["/api/units", "/api/units/stream"].includes(url.pathname)) {
          const { source, guid } = store.resolve(url.searchParams);
          if (url.pathname === "/api/units") return Response.json(store.view(source, guid), {
            headers: { "Cache-Control": "no-store" },
          });
          if (streams.size >= 128) return failure(503, "Stream capacity reached");
          server.timeout(request, 0);
          let close = () => {};
          const connection = snapshotStream(store, source, guid, request.signal, () => streams.delete(close));
          close = connection.close;
          if (!connection.closed) streams.add(close);
          return new Response(connection.stream, { headers: { "Content-Type": "text/event-stream",
            "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
        }
        return failure(404, "Not found");
      } catch (error) {
        if (error instanceof SelectionError) return failure(error.status, error.message);
        diagnostic("Unit widget request failed");
        return failure(500, "Internal error");
      }
    },
  });
  return { server, store, get activeRequests() { return active; }, stop() {
    stopPromise ??= (async () => {
      stopping = true;
      for (const close of streams) close();
      await server.stop(true);
      await writeQueue;
      try { await output.close?.(); }
      finally { options.icons?.close(); }
    })();
    return stopPromise;
  } };
}
