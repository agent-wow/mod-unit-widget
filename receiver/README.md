# Unit widget receiver

Standalone Bun receiver for `mod-unit-widget`, with live state, SSE, an icon cache, and OBS frames.
Runtime dependencies are built into Bun 1.4.2+. Copy this directory to the receiving machine and run:

```sh
bun run --silent start
```

## Settings

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `UNIT_WIDGET_HOST` | `127.0.0.1` | Bind address; `0.0.0.0` allows remote IPv4 clients |
| `UNIT_WIDGET_PORT` | `3001` | TCP port, 1–65535 |
| `UNIT_WIDGET_BEARER_TOKEN` | empty | Optional ingestion token, matching the module |
| `UNIT_WIDGET_ICON_MODE` | `hybrid` | `hybrid` or `offline` |
| `UNIT_WIDGET_ICON_DIR` | `./icons` | Local images and optional `manifest.json` |
| `UNIT_WIDGET_ICON_CACHE` | `./data/icons.sqlite` | Persistent icon cache; `:memory:` is supported |

Paths are relative to the process's working directory. Settings are read at startup. Diagnostics go to stderr.
Every authenticated, schema-valid `POST /units` body is written as one JSON line to stdout before acknowledgement,
including duplicate or expired snapshots. Headers and bearer credentials are not logged. This matches the chat
receiver; redirect stdout to a file or pipe to collect batches. Live state stays in memory and repopulates after
a receiver restart; stdout is not used for recovery. A failed stdout write returns `503` and stops admission until
restart. A slow stdout consumer backpressures ingestion, with at most four requests pending; time spent waiting
still counts toward snapshot staleness.
Widget/read endpoints intentionally require no token; the ingestion credential only protects `POST /units`.
Use a trusted network or a reverse proxy for deployment-specific access controls and HTTPS. Disable proxy
buffering for the SSE route. Bind and endpoint addresses must be reachable from the appropriate machines.

## OBS URLs

```text
http://127.0.0.1:3001/widget?source=realm-1&character=Alice&frame=both
http://127.0.0.1:3001/widget?source=realm-1&character=Alice&frame=player
http://127.0.0.1:3001/widget?source=realm-1&character=Alice&frame=target
```

Use 900 × 420 for both or 450 × 420 for a single frame. Scaling the Browser source in OBS scales the whole
widget. CSS variables `--frame-width`, `--frame-gap`, and `--font` are available to OBS Custom CSS. For example:

```css
:root { --frame-width: 430px; --frame-gap: 24px; --font: "Trebuchet MS", sans-serif; }
```

Select a source plus exactly one `character` or `guid`. A name resolves case-insensitively and then stays
pinned to its GUID for the page's lifetime. Unknown names retry automatically; ambiguous names require a
GUID. GUID selection can wait for a not-yet-seen character. There is never an unfiltered fallback.

Discover characters with `GET /api/characters?source=realm-1`; optional `character=Alice` filters by name.

## Icons

Precedence: **local manifest → persistent cache → Wowhead → fallback**. Offline mode disables external
requests while still allowing existing cached images. A missing or invalid local image falls through. Player
avatars use WoW class icons; NPC avatars use creature-type icons. When artwork is unavailable, local vector
pictograms replace it, without letter avatars. Spell icons retain labeled placeholders.

Copy `icons/manifest.example.json` to `icons/manifest.json`, change the spell IDs and filenames, then place
PNG/JPEG/WebP images beside the manifest. Only flat filenames are allowed; paths and symlinks outside the
icon directory are rejected. Each image is limited to 128 KiB. Restart after changing the manifest.
Use `class-<class-id>` and `creature-<creature-type>` keys to override avatar artwork, such as `class-1`
for warriors or `creature-7` for humanoids. Supported classes are 1–9 and 11; creature types are 1–9 and 11–13.

Hybrid mode requests `https://nether.wowhead.com/wotlk/tooltip/spell/<spell-id>` and reads its `icon` field.
It then requests `https://wow.zamimg.com/images/wow/icons/large/<icon-name>.jpg`. Class and creature avatars
use fixed, allowlisted artwork names from that same CDN, without a tooltip lookup. Only spell IDs and icon
names are sent externally; character identities and gameplay values are never sent. Remote tooltip HTML and
scripts are not used. The browser receives images from this receiver's `/icons/<spell-id>`, `/icons/class/<id>`,
and `/icons/creature/<id>` routes. Local SVG fallbacks are served at `/badges/class/<id>` and `/badges/creature/<id>`.

Lookup requests are deduplicated, limited to four concurrent downloads and 32 pending lookups, and have
three-second deadlines and 128 KiB response limits. Redirects are rejected. Failures are cached for one
minute. Successful JPEGs are stored in a 32 MiB SQLite cache, evicting least recently used images. Cache and
manifest errors at startup stop the receiver; runtime icon errors produce placeholders without delaying
frame ingestion. Wowhead availability and spell coverage are not guaranteed; local overrides support
custom spell artwork.

## Protocol

`POST /units` requires uncompressed UTF-8 `application/json`; optional authentication uses
`Authorization: Bearer <token>`. Schema version 1 uses this envelope:

```json
{
  "schema_version": 1,
  "source_id": "realm-1",
  "process_id": "server-startup-identifier",
  "snapshots": []
}
```

Each snapshot has `guid`, `name`, `presence` (`online`, `offline`, `unavailable`), `sequence` (a positive
uint64 decimal **string**), `age_ms`, `player`, and `target`. Online snapshots have a player frame and a
nullable target. Offline/unavailable snapshots have both frames null. Sequences increase within a server
process and identify complete state replacements, not patches. `age_ms` measures capture-to-dispatch time.

Frames contain identity/classification/reaction, health, active power, statuses, visible auras, nullable cast,
and `extra` class resources. Durations are milliseconds; hidden/permanent aura durations are null and
indefinite channel duration is -1. See [schema.ts](src/schema.ts) for the complete types and validation.
[fixtures.ts](examples/fixtures.ts) contains representative valid snapshots.

Fresh snapshots supersede prior state only when their sequence increases. Duplicate, older, retired-process,
and already-five-second-old snapshots are acknowledged but ignored. The first fresh snapshot from a new
process clears the source's old character state and retires its previous process ID. One active process
per source is required. Live capacity is 10000 characters, an estimated 64 MiB of state, 128 sources, and
128 retired process IDs per source; capacity failure leaves the previous state intact. Entries and idle
source identities expire after 15 minutes during ingestion/discovery. Empty batches are valid and do not
extend freshness or change generations.

| HTTP status | Meaning |
| --- | --- |
| `204` | Valid batch processed; ignored duplicates/expired frames are also acknowledged |
| `400` | Invalid JSON/UTF-8 or selector |
| `401` | Missing or incorrect ingestion token |
| `404` | Unknown route/name or unavailable icon |
| `405` | Unsupported method |
| `408` | Upload exceeds its three-second deadline |
| `409` | Ambiguous character name |
| `413` | Upload exceeds 2 MiB |
| `415` | Unsupported media type or compression |
| `422` | Invalid version or nested snapshot data |
| `503` | Capacity, admission, stdout failure, or shutdown; `Retry-After: 1` |

Four uploads may be active, including requests waiting on stdout. At most 100 snapshots are accepted per batch;
validation and stdout writing complete before state changes. Receiver shutdown closes streams and active
connections and drains queued output within the process's five-second shutdown budget. Unacknowledged uploads can retry.

`GET /api/units` and `GET /api/units/stream` accept the same source/name-or-GUID selector. Snapshot responses
contain the original fields plus `source_id`, `process_id`, `stale`, and receiver-adjusted `age_ms`. An
unknown GUID returns null. A stale online frame has null player/target; identity remains for the dimmed
placeholder. Explicit offline status remains offline. No live state is restored from disk.

Streams use `event: snapshot` with the complete JSON snapshot (or null). They send the current state on
connection, then changes and stale transitions. There is no history replay or `Last-Event-ID` dependency.
Streams have a 256 KiB buffering budget and disconnect slow consumers; reconnection obtains the latest
snapshot. Up to 128 streams are allowed, with 15-second keepalives. Read APIs send `Cache-Control: no-store`.

## Demo and tests

```sh
bun run demo
```

The demo posts synthetic data to `http://127.0.0.1:3001/units`; override with `UNIT_WIDGET_DEMO_ENDPOINT`.
It respects `UNIT_WIDGET_BEARER_TOKEN`. Use a separate receiver from your realm because it claims the
`realm-1` source generation. Characters: Alice (mage), Valeera (rogue), Malfurion (druid), Darion (death
knight), Fallen (ghost), Offline, and `A very long character name for layout checks` (64 auras).
Stop the demo to check the five-second stale transition. The receiver continues running until stopped.

```sh
bun install --frozen-lockfile
bun run check
bun run test
```

Tests require permission to bind ephemeral loopback sockets. No game server or external provider is used.
