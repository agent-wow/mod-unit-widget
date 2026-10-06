# mod-unit-widget

Live WotLK-style character and selected-target frames for OBS. Includes an AzerothCore C++ module,
standalone Bun receiver, and transparent browser overlay. Tracks all online characters using existing
module hooks; no client addon, core patch, database table, or SQL installation is needed.

The module is independent of `mod-chat-widget` and `mod-watch` and can run alongside either. Choose the
character directly in the widget URL, including a character being observed with `.watch`.

## Installation

Place this directory at `modules/mod-unit-widget`. Configure/build/install AzerothCore through your normal
module deployment workflow. The core discovers `Addmod_unit_widgetScripts` and installs the distributed
configuration. Copy `mod_unit_widget.conf.dist` to `mod_unit_widget.conf` and set:

```ini
UnitWidget.Enable = 1
UnitWidget.Endpoint = "http://127.0.0.1:3001/units"
UnitWidget.SourceId = "realm-1"
UnitWidget.BearerToken = ""
```

All options are startup-only. Restart worldserver after installation or configuration changes. An empty
endpoint disables capture and the delivery worker. Give each concurrently running server a unique source ID.
External modules are ignored by the parent AzerothCore repository; include this whole directory in your
module repository or deployment archive.

Install Bun 1.4.2 or newer on the receiving machine. From `receiver/`, run:

```sh
bun run --silent start
```

The receiver can be copied to another machine without AzerothCore, MySQL, frontend compilation, or runtime
package installation. Change the module endpoint and receiver bind address for remote operation. The
receiver's default port is 3001, so the chat receiver can keep port 3000.

Add an OBS **Browser** source with this URL (replace Alice with a real character):

```text
http://127.0.0.1:3001/widget?source=realm-1&character=Alice&frame=both
```

Start with **900 × 420** pixels. For independent placement, use `frame=player` and `frame=target` in separate
**450 × 420** Browser sources. The scene background remains transparent. Missing targets keep their reserved
position in the paired layout. Character names are case-insensitive within a source; URL-encode names and
GUIDs. See [receiver documentation](receiver/README.md) for discovery, icon configuration, and the HTTP contract.

## Displayed information

- Name, level, player class icon or creature-type icon, reaction color, and elite/rare/boss classification.
- Current and maximum health and active mana/rage/energy/focus/runic power. Rage and runic power use client
  units rather than the server's internal tenths. Units without an active resource have no resource bar.
- Combat, dead/ghost, PvP, AFK, and DND indicators where applicable.
- The character's combo points on its current target, death-knight rune types/cooldowns, and druid mana
  while using another resource. The target's private class-resource indicators are not exported.
- Visible buff/debuff slots, stacks or charges, and allowed countdowns. Stackable auras use their stack
  count; other auras use charges. Hidden-duration and permanent auras have no countdown.
- Timed casts and channels, including pushback/shortening, completion, cancellation and interruption.
  Channel bars drain; ordinary cast bars fill. Instant spells do not produce artificial bars. Hidden
  channels are omitted. Cast and aura names use the server's English spell data, including custom spells.

The styling approximates WotLK unit frames with CSS and static icons; it does not render animated 3D
portraits or reproduce client addons. Pet, focus, target-of-target and party frames are not included.
Data is authoritative server state, not a packet-perfect recording of the client's UI. The selected target
must be in world and present in that character's client visibility set. Class resources describe the
character itself; entering a vehicle does not replace the frame with a vehicle or add a pet frame.

## Timing and delivery

The world-update hook samples after map workers join, at 100 ms by default. Spell hooks copy scalar
observations on the caster's thread into a bounded tracker; they never retain a Unit or Spell pointer.
Periodic sampling reconciles current spells and captures targets selected mid-cast. If a channel start was
not retained, recovery uses its current remaining time as the initial total. Bars interpolate between
snapshots; timings include capture/queue age and receiver/browser elapsed time without clock synchronization.
One-way network latency is not measurable from a snapshot and can still introduce a small display delay.

Only a background worker performs HTTP. New state replaces older pending state for the same character,
without moving its place in the queue. Limits are 10000 pending characters, 128 KiB per snapshot, and a
configurable 16 MiB serialized queue budget (JSON/container overhead is additional but count-bounded).
Batches contain at most 100 characters and approximately 512 KiB. Capacity overflow drops the new sample;
continued sampling provides another opportunity. No durable history is written by the module.

HTTP 2xx acknowledges delivery. Network failures, 408, 429 and 5xx retry with 1–30 second exponential backoff,
honoring `Retry-After` up to 60 seconds. Other failures discard that batch and back off. Retries use the latest
pending state; observations older than five seconds are discarded. Duplicate sequence IDs are harmless.
HTTPS verifies certificates and hostnames; optional `UnitWidget.CAFile` supplies a custom CA bundle. Redirects
are not followed. Connect/request deadlines default to 750/1500 ms. Shutdown allows two seconds to drain and
cancels active requests; unsent state is disposable. Like the underlying Asio transport, OS resolver cleanup
can depend on the platform's DNS resolver. Diagnostics do not contain credentials or frame payloads.

The receiver pushes full snapshots using SSE. A reconnect starts from current state. When live capture is
five seconds old, the browser clears transient information and the target, dims the character identity,
and reports stale data. Explicit logout shows Offline; transfers show Unavailable. Reconnection and login
recover automatically. Keep the receiver on a trusted network: viewing APIs intentionally have no token.
The receiver processes ingestion batches without request logging; diagnostics go to stderr.

## Configuration

| Module option | Default | Meaning |
| --- | --- | --- |
| `UnitWidget.Enable` | `1` | Enable when an endpoint is supplied |
| `UnitWidget.Endpoint` | empty | Full HTTP/HTTPS ingestion URL |
| `UnitWidget.SourceId` | `realm-<RealmID>` | Unique server identity |
| `UnitWidget.BearerToken` | empty | Optional ingestion credential |
| `UnitWidget.CAFile` | empty | Additional HTTPS CA file |
| `UnitWidget.UpdateIntervalMs` | `100` | Sampling interval, 50–1000 ms |
| `UnitWidget.QueueBytes` | `16777216` | Serialized queue budget, 512 KiB–256 MiB |
| `UnitWidget.ConnectTimeoutMs` | `750` | DNS/TCP/TLS deadline |
| `UnitWidget.RequestTimeoutMs` | `1500` | Entire request; at least connect timeout, at most 3000 ms |

## Development and verification

From `receiver/`:

```sh
bun install --frozen-lockfile
bun run check
bun run test
```

The receiver tests use ephemeral loopback listeners, injected clocks/providers, and temporary icon caches.
They cover schema validation, isolation, sequence ordering, generation retirement, staleness, capacity,
stream reconnection/backpressure, icon confinement, caching and offline operation. No realm is required.

C++ tests live outside `src/` and register with AzerothCore's existing `BUILD_TESTING` target. After an
explicitly requested test configuration/build, run `unit_tests --gtest_filter='UnitWidget*'`. Tests cover
resource/aura projection, fair coalescing, retries/expiry, cast transitions, and the copied HTTP/TLS transport.
Run the repository C++ codestyle checker from this module directory to inspect its `src/` files.

For a synthetic browser preview, start the receiver then run `bun run demo` from `receiver/`. Open the
Alice, Valeera, Malfurion, Darion, Fallen and Offline character URLs. Stopping the demo demonstrates staleness.
The demo continually posts fabricated data under `realm-1`; run it against a separate test receiver.

Before deployment, compare with a 3.3.5a client: target/clear/switch NPCs and players, select a caster mid-cast,
interrupt and chain the same spell, channel and take pushback, refresh/stack/dispel auras, shapeshift, spend
combo points and runes, die/release/resurrect, change maps, logout/login, and interrupt receiver connectivity.

## License and attribution

Authored code is GPL-2.0-or-later. `UnitWidgetHttp.*` and `UnitWidgetHttpTest.cpp` adapt the transport and tests
from [agent-wow/mod-chat-widget](https://github.com/agent-wow/mod-chat-widget), original commit `81b5154`
by hazim-j (Hazim Jumali). The TLS test fixtures originate there too. Keep this attribution when redistributing.
The vendored nlohmann/json 3.12.0 header retains Niels Lohmann's MIT license. Spell icon artwork is retrieved
at runtime from Wowhead/ZAM or provided locally; this repository does not bundle that artwork.
