# LED transport protocols

voxeled owns the **patch**: every fixture instance's `output` block names a protocol + address, and
`src/output/dispatch.mjs` fans one scene's frames out to all of them at once (Art-Net *and* DDP *and*
dan-mx from the same pixels). This is the reference for what those protocols are and how to patch
them.

The six protocols that show up in this world split into **two families**:

| protocol | family | transport | addressing | colour semantics | voxeled |
|---|---|---|---|---|---|
| **Art-Net** | DMX-over-IP | UDP 6454 | universe + channel (512) | none (8-bit values) | ✅ sender |
| **sACN / E1.31** | DMX-over-IP | UDP 5568 (multicast) | universe + priority | none | mappable¹ |
| **KiNET** | DMX-over-IP | UDP 6038 | port + channel | none | mappable¹ |
| **OPC** | pixel stream | TCP/UDP 7890 | channel + implicit index | none (RGB888) | mappable¹ |
| **DDP** | pixel stream | UDP 4048 | 32-bit **byte** offset | data-type byte | ✅ sender **+ receiver** |
| **dan-mx** | pixel stream | UDP | 16-bit **pixel** start + count | colour_space + transfer | ✅ sender |

¹ *mappable* = the LX `.lxm` importer decodes its address fields, and it can be added as a sender or
via `customProtocols` — not yet a built-in sender.

## The two families

- **DMX-over-IP** (Art-Net, sACN, KiNET) comes from the **stage-lighting** world. The unit is a
  512-channel DMX *universe*; you address a fixture by `universe + channel`. Great when a console or
  pro nodes are in the signal path. 8-bit, no colour science.
- **Pixel-streaming** (OPC, DDP, dan-mx) comes from the **LED-art / maker** world. The unit is a
  *framebuffer of RGB*; you address by an offset into it. This is where dense addressable strips and
  sculptural LED live.

## Per protocol

- **Art-Net** — the ubiquitous DMX-over-Ethernet standard; consoles, nodes, and most software speak
  it. voxeled rolls channels across universes automatically (`dispatch.mjs`).
- **sACN (E1.31)** — the other DMX-over-IP standard, multicast with a priority field for backup
  arbitration (`sacnPriority` in the LX patch).
- **KiNET** — Philips Color Kinetics' proprietary protocol for their PDS supplies/fixtures; common
  in architectural installs using CK gear, otherwise legacy.
- **OPC (Open Pixel Control)** — the dead-simple FadeCandy-era protocol: a 4-byte header + RGB. No
  colour semantics, no compression. (LX fixtures default to its port, 7890.)
- **DDP (Distributed Display Protocol)** — the modern pixel-streaming lingua franca, authored by
  **Mark Lottor / 3waylabs** (of Cubatron LED-art fame). A 32-bit data offset lets you address into
  a large framebuffer, which is why **WLED** and **FPP/Falcon** all speak it. If you want interop,
  this is the one. voxeled implements it (`senders/ddp.mjs`).

## voxeled as a DDP Display (receiver)

Run the hub with **`VOX_DDP_IN=4048`** and voxeled *is* a DDP Display
([3waylabs spec](http://www.3waylabs.com/ddp/), `src/input/ddp.mjs`): point any DDP sender at it —
xLights, FPP/Falcon, LedFx, Chromatik, WLED-style tools, TouchDesigner — and its frames land on
the bus (preview + simulator) **and** on the patch dispatcher, so **DDP in becomes Art-Net /
dan-mx / DDP out per fixture**: voxeled is a protocol bridge with a map in the middle.

What's implemented, per the spec: writes to ID 1 / 255 by data offset + length into a
framebuffer (any order, partial updates kept); **PUSH** displays — also a bare broadcast PUSH;
senders that never PUSH are displayed when their next frame starts at offset 0; data types RGB,
RGBW (white folded in), grayscale, "as configured"; **Query/Reply** for JSON **status** (251 — how
senders discover it: `{"status":{"man":"voxeled","mod":"hub","push":true,…}}`), JSON **config**
(250 — `ports[0].l` = pixel count), a framebuffer read-back on ID 1, and the spec's empty Reply for
unsupported IDs; back-to-back duplicate suppression by sequence number. Timecode is parsed and
ignored (immediate display); storage-sourced data and DMX transit (254) are accepted but not mapped.

(The web page can't do this itself — browsers have no UDP — which is exactly why the hub is the
native DDP endpoint and the web app is its face.)

## Inputs and merge — several streams driving one piece

Everything that can send pixels can drive voxeled, *at the same time*, the way a pro rig merges
sources. The layout's `inputs:` lists the streams; `merge:` says how they combine:

```yaml
inputs:
  - { name: console, protocol: artnet, port: 6454, priority: 100, timeoutMs: 800,
      map: { strings: 12, universesPerString: 4, perUniverse: 150, stripB: doc, groups: { size: 3, order: [0, 1, 2, 3] } } }
  - { name: xlights, protocol: ddp,  port: 4048, priority: 60 }         # whole frames in scene order
  - { name: tixl,    protocol: tcp,  port: 9600, priority: 80 }         # length-prefixed frames (TiXL VoxeledOutput)
  - { name: desk,    protocol: sacn, port: 5568, priority: 90, universes: [1, 2, 3] }   # E1.31, joins the multicast groups
  - { name: web,     protocol: ws,   priority: 10 }                     # the bus: pages push frames / Art-Net / JSON
merge: { mode: priority, fallback: show, timeoutMs: 1000 }
```

| | |
|---|---|
| `priority` | per pixel, the highest-priority **live** source that has written it wins |
| `htp` / `ltp` | highest-takes-precedence (per-channel max) / latest-takes-precedence (most recent write) |
| `timeoutMs` | a source with no data for this long goes silent and hands its pixels back — the failover |
| `fallback` | for pixels no live source covers: `show` (the internal patterns keep running there), `black`, or `hold` |

Universe protocols (Art-Net, sACN) go through an **input map** — the receiving end of the patch —
which says which pixel each channel *is*: sequential (170 px per universe, default), explicit
`segments: [{ universe, channel, pixel, count, dir }]`, or the `strings:` form every pixel
controller has, with the two things that always bite made explicit: a string wired as two strips
from both ends (`stripB: doc | luxpi | none`) and the controller's string order versus the
layout's (`groups.order`), plus `flip`. Wrong guesses become one-line edits instead of code.

The hub answers **ArtPoll** (so consoles and senders discover it as a node) and joins sACN
multicast. The **bus** is also an input: a WebSocket client may send binary messages — a raw RGB
frame in scene order, or Art-Net packets (a relay page) — and JSON text: `{ "type": "control",
fader, mode, a, b }` drives the crossfader; any other JSON (a game's pedestal buttons, state) is
relayed to every other client, so the bus is the room the pages share. `/inputs` reports each
source's liveness and rate; the viewer's HUD shows it.

`VOX_LISTEN=<port>` / `VOX_DDP_IN=<port>` are shorthands that add a `tcp` / `ddp` input at
priority 100 — they now merge over the show instead of replacing it.

## Poses — tracking in (PosiStageNet, the bus, the phone)

Where things *are* is an input too. `trackers:` in the layout names them; an instance with
`track:` follows one, and patterns read them (`lantern { lampFrom }`, `point`, `paint`).

- **PosiStageNet** (`source: psn`) — the entertainment tracking protocol (BlackTrax, zactrack,
  Stage Precision…): UDP multicast 236.10.10.10:56565, v2 data packets; tracker position (metres)
  and orientation (axis-angle) become a pose; `id` picks a tracker by number or name, `up: z`
  converts a Z-up system.
- **The bus** (`source: ws`) — any WebSocket client sends `{"type":"pose","id":…,"pos":[mm],"rotDeg":[deg]}`;
  the hub re-broadcasts poses (≤ 30 Hz per tracker) so every viewer animates the instance.
- **The phone** (`source: phone`) — `phone.html` posts its own pose: position from a floor-plan
  drag, orientation from the gyro/compass (pitch = tilt, yaw = compass, zeroed with *face the piece*).

`/poses` lists trackers and their live poses.

**Joining live.** `{"type":"hello", id, fixture | fixtureName, output?, pos?, rotDeg?, track?, ttlS?}` on
the bus (or `POST /instances`) appends a fixture to the running scene and answers
`{"type":"welcome", id, instance, index, count, total}`; `{"type":"bye"}` / `DELETE /instances?name=` /
silence past `ttlS` (poses, `{"type":"heartbeat"}` refresh it) remove it. Existing pixel indices never
move; the hub's clock, crossfade, and bound inputs continue. An ESP32 wand: connect to `ws://hub:8080/bus`,
send hello with its geometry and `output: { protocol: ddp, host: <its ip> }`, then poses — it gets its own
pixels back over DDP.

## dan-mx — the opinionated dialect

[dan-mx](https://github.com/dnewcome/dan-mx) is the same pixel-streaming idea as DDP, redesigned with
things the standards leave out. voxeled emits it **byte-compatibly** with the dan-mx Python + ESP32
receivers (verified by cross-decoding voxeled's frames through the reference `StreamDecoder`):

- **In-band colour semantics** — the 14-byte header carries an explicit `color_space` (RGB888 /
  RGB565 / G6R5B5 / RGB888-linear) *and* a `transfer` function (linear / gamma-2.2 / sRGB). No other
  pixel protocol names the transfer function, so voxeled — which mixes in **linear RGB** — can carry
  that linear intent to the wire instead of losing it to the controller's hidden gamma.
- **Compression** — an `encoding` field: **RLE** (whole-pixel run-length) and **DELTA** (XOR against
  the previous frame, then RLE'd, so unchanged pixels collapse to zero-runs), with a **keyframe**
  every N frames to recover from UDP loss. `dispatch.mjs` keeps a stateful `DanmxStream` per fixture
  so DELTA works across frames.

The trade-off is **interop**: dan-mx speaks only to its own receivers. Use DDP where interop matters;
use dan-mx to experiment with colour/bandwidth on your own nodes. voxeled emitting both is the proof
of its "own the patch, mix protocols" claim.

### Patching it (opt-in per instance)

```yaml
instances:
  - { fixture: strip, name: wled,  output: { protocol: ddp,   host: 10.0.0.6, offset: 0 } }
  - { fixture: strip, name: panel, output: { protocol: artnet, host: 10.0.0.5, universe: 2, channel: 1, byteOrder: grb } }
  - { fixture: strip, name: mine,  output: { protocol: danmx, host: 10.0.0.7,
        encoding: delta, colorSpace: rgb888, transfer: srgb, keyframeInterval: 30 } }
```

dan-mx defaults to `encoding: raw` (byte-for-byte identical to before); set `auto` (smallest of
RAW/RLE/DELTA per frame), `rle`, or `delta` to opt into compression. `colorSpace`/`transfer` default
to `rgb888`/`linear`.
