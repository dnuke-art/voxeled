# voxeled formats & interchange

voxeled's value is **the map** — where every LED is in real 3D space — as an open, reusable
artifact. This documents the canonical scene format and the interchange bridges.

## Coordinate conventions

- **Units:** millimetres, unless a scene's `units` says otherwise.
- **Axes:** right-handed, **+Y up**. The ground plane is XZ.
- **Normals:** unit vectors, pointing in each LED's **emission direction** (outward from the form).

## `.vxl.json` — the canonical scene (v0.0.1)

A *resolved scene* is the source of truth: a flat list of pixels in world space, plus the rig
metadata that produced them. It is plain JSON (`*.vxl.json`).

```jsonc
{
  "voxeled": "0.0.1",           // format version
  "name": "two-hearts",
  "units": "mm",
  "count": 9216,                // pixels.length
  "meta": {
    "pitchMM": 10,              // real inter-pixel spacing (viewers size LEDs from this)
    "instances": [              // the rig: one entry per placed fixture instance
      { "name": "left",  "fixture": "heart", "pos": [-1524,0,0], "rotDeg": [0,0,0] },
      { "name": "right", "fixture": "heart", "pos": [ 1524,0,0], "rotDeg": [0,0,0] }
    ]
    // …plus whatever the layout/generator recorded (spacing, fixture params, etc.)
  },
  "pixels": [
    // each pixel, minimum = position + normal:
    { "i": 0, "inst": 0, "p": [0.09, 288.34, -55], "n": [0.9955,-0.0946,-0.0041], "s": 0.0013, "v": -0.9167 }
    // i    global index (→ output byte offset i*3 for now)
    // inst which instance it belongs to (lets patterns re-base to fixture-local space)
    // p    world position (mm)
    // n    unit emission normal
    // s,v  optional fixture-local coords (here: arclength-around-loop, across-band)
  ]
}
```

**Addressing / patch.** The scene owns the *wiring*, not just the geometry: each fixture (or
instance) can carry an `output` block — protocol + address — and a single installation may mix
protocols. voxeled's dispatcher executes them. See [Patch — output mapping](#patch--output-mapping).
Without an `output` block, addressing is index-implied (pixel `i` → DDP offset `i·3` / Art-Net
universe `i/170`).

**Layout files** (`*.yaml`) are the *authoring* form — fixtures + instances + a show — from which
a `.vxl.json` is resolved. See [`DEMO-mobius-heart.md`](DEMO-mobius-heart.md) for the layout schema.

## Patch — output mapping

A fixture (or a single instance) carries an `output` block; voxeled's dispatcher
(`src/output/dispatch.mjs`) groups pixels by instance and fans each to its protocol — **one
installation can mix protocols**. Fixture-level `output` is the default; per-instance `output`
overrides it field-by-field (so every physical fixture can have its own host/universe).

```yaml
fixtures:
  heart:
    type: mobius-heart
    params: { ... }
    output: { protocol: artnet, host: 10.0.0.5, universe: 0, byteOrder: grb }  # fixture default
instances:
  - { fixture: heart, name: left,  pos: [...] }                                # inherits
  - { fixture: heart, name: right, pos: [...], output: { host: 10.0.0.6, universe: 4 } }  # override
```

| field | protocols | meaning |
|---|---|---|
| `protocol` | all | `artnet` \| `ddp` \| `danmx` \| a registered custom name |
| `host`, `port` | all | target IP + UDP port (defaults: artnet/danmx 6454, ddp 4048) |
| `byteOrder` | artnet, ddp | `rgb` \| `grb` \| `bgr` \| `rgbw` \| `grbw` … (white = min(r,g,b)) |
| `universe`, `channel` | artnet | start universe (0-based) + channel (1-based); pixels roll across universes |
| `offset` | ddp | start byte offset in the receiver framebuffer |
| `startPixel` | danmx | start pixel index in the dan-mx frame |

Built-in protocols: **Art-Net** (pixels merged into 512-ch universes per host/universe),
**DDP** (offset framebuffer, MTU-chunked), and **dan-mx**
([github.com/dnewcome/dan-mx](https://github.com/dnewcome/dan-mx)) — voxeled emits byte-compatible
RAW/RGB888 `DMX2` frames, MTU-chunked. **Custom protocols** plug in via
`createDispatcher(scene, { customProtocols: { name: (sock, plan, bytes, seq) => {…} } })` —
written once in voxeled, so every consumer (including the TiXL bridge) gets it for free.

Mixed-protocol demo (Art-Net + dan-mx + DDP from one show):
`node examples/mobius-heart/run.mjs examples/mobius-heart/layouts/patched.yaml`.

## Inputs — external streams driving the piece (the patch, receiving end)

```yaml
inputs:
  - { name: console, protocol: artnet, port: 6454, priority: 100, timeoutMs: 800, map: { strings: 12, universesPerString: 4, perUniverse: 150, stripB: doc } }
  - { name: web, protocol: ws, priority: 10 }
merge: { mode: priority, fallback: show, timeoutMs: 1000 }
```

| field | default | meaning |
|---|---|---|
| `protocol` | — | `artnet` (6454) · `sacn` (5568) · `ddp` (4048) · `tcp` (9600) · `ws` (the bus) |
| `name`, `port`, `host` | protocol, standard port, 0.0.0.0 | one `ws` input at most |
| `priority`, `timeoutMs` | 0, `merge.timeoutMs` | who wins; when a silent source hands its pixels back |
| `map` | sequential 170/universe | artnet/sacn/ws: `segments: […]` or `strings: N, universesPerString, perUniverse, perString, stripB, flip, groups: { size, order }, universe, pixel` |
| `universes` | the map's | sacn: multicast groups to join |
| `merge.mode` | `priority` | `priority` · `htp` · `ltp` |
| `merge.fallback` | `show` | `show` · `black` · `hold` for pixels no live source covers |

Details and the wire behaviour: [interop/protocols.md](interop/protocols.md#inputs-and-merge--several-streams-driving-one-piece).

## Trackers — moving fixtures and things people carry

```yaml
trackers:
  - { name: wand-1, source: phone, heightMM: 1200 }                    # phone.html: floor-plan drag + gyro
  - { name: hand,   source: ws }                                        # any client: {"type":"pose","id":"hand","pos":[x,y,z],"rotDeg":[rx,ry,rz]}
  - { name: tag,    source: psn, port: 56565, group: 236.10.10.10, id: 3, up: y }   # PosiStageNet tracker (id or name)
instances:
  - { fixture: wand, name: wand-1, track: wand-1 }                      # follows the tracker: its LEDs move in the world
show:
  scenes:
    - { name: lantern, pattern: lantern, params: { lampFrom: wand-1 } } # patterns read poses too
```

| field | default | meaning |
|---|---|---|
| `source` | `ws` | `ws` (pose JSON on the bus) · `phone` (the phone page becomes this tracker) · `psn` (PosiStageNet) |
| `aim` | `[0, 1, 0]` | the tracker's pointing axis in its own frame (a stick's +Y) |
| `heightMM` | 1200 | phone: the wand's height above the floor |
| `id`, `port`, `group`, `scaleToMM`, `up` | first tracker, 56565, 236.10.10.10, 1000, `y` | psn: which PSN tracker (numeric id or name), where, and its units/axes |
| instance `track` | — | the instance's `pos`/`rotDeg` follow this tracker (re-placed from fixture-local geometry per pose) |

A pose is `pos` (mm) + `rotDeg` (Z·Y·X, like instances); the registry also derives `aim` (the axis
rotated into the world). Viewers get `{type:"pose"}` messages and animate the instance; `/poses`
reports every tracker. Patterns: `lantern { lampFrom }`, `point { from }`, `paint { from }`.

## Emitter — how the LEDs emit (simulation)

The map says where each LED is and which way it faces; the **emitter profile** says how it *emits*,
so the viewer's simulator (**S**) can show what the piece actually looks like — viewing-angle
falloff, the dark backside of every LED, occlusion by the bodies themselves, and diffusion glow.
It rides alongside `output` with the same precedence: fixture-type default (built into the
geometry, e.g. the heart's panel LED) < layout `fixtures.X.emitter` < per-instance `emitter`,
merged field-by-field, and lands in `meta.instances[k].emitter`.

```yaml
fixtures:
  heart:
    type: mobius-heart
    emitter: { softness: 0.6 }                                   # tweak the type default
instances:
  - { fixture: heart, name: left,  pos: [...] }
  - { fixture: heart, name: right, pos: [...], emitter: { viewingAngleDeg: 20 } }  # a spot variant
```

| field | default | meaning |
|---|---|---|
| `viewingAngleDeg` | 120 | datasheet **full** angle at 50% intensity. The lobe is `cosθ^p`, `p = ln½ / ln cos(angle/2)` — so **120° is exactly Lambertian**, ~10° a spot, ~1° laser-like, ~170° a diffused rope/tube. Behind the LED (θ > 90°) it is dark. |
| `sizeFrac` | 0.9 | emitter *body* edge as a fraction of pixel pitch (1.0 = contiguous panel tiles that form a surface; ~0.5 = a bare chip on a strand) |
| `coreFrac` | 0.5 | lit fraction of the body (the chip/lens); the rest is dark backing |
| `softness` | 0.4 | edge diffusion of the lit core (0 = hard chip, 1 = soft blob) |
| `gain` | 1.6 | emissive intensity (HDR; > 1 feeds bloom) |
| `glow` | 1.0 | bloom contribution (the diffusion halo) |

One shader covers the whole range because only the numbers change: a laser, a spot, a bare SMD
LED, a diffused strip, and a glowing rope are the same body with different `viewingAngleDeg` /
`softness` / `sizeFrac`. Each body is opaque and faces its normal — its front emits
`color × lobe(view angle) × core`, its back is dark backing, and both write depth, so the bodies
occlude one another (a panel ribbon's quads *are* the ribbon, dark on the back).

## Paths & ropes — placing LEDs on a structure

Thread's steel was the *input*; its LEDs were *derived* — diffused ropes wrapped along the tubes at
angles fixed from as-built photos. That workflow is data now: a layout names **paths** (polylines
in mm — inline, or loaded from a JSON file such as thread-3d's `tubes.json`), and a **`rope`**
fixture follows one: parallel-transport frames along the path, each LED offset `radiusMM` from
the axis in the direction `angleDeg` (+ `twistDegPerM · s`) around it, its emission normal
**radial** — away from the tube it's fixed to. `s` runs 0→1 along the rope.

```yaml
paths:
  tube-1: { file: ../../../thread-3d/model/out/tubes.json, index: 0, scaleToMM: 1000 }  # from a file
  edge:   [[0, 0, 0], [1200, 0, 0], [1200, 800, 0]]                                     # inline, mm
fixtures:
  rope-A: { type: rope, params: { path: tube-1, pitchMM: 152, radiusMM: 26, angleDeg: 60 } }
  rope-B: { type: rope, params: { path: tube-1, pitchMM: 152, radiusMM: 26, angleDeg: 180 } }
instances:
  - { fixture: rope-A, name: A }
  - { fixture: rope-B, name: B }
  - { fixture: heart, along: { path: edge, count: 4, orient: tangent } }   # instances spaced ALONG a path
```

`rope` params: `path` (name or points), `count` **or** `pitchMM`, `radiusMM`, `angleDeg` — one
angle, or a **list** for several ropes on the same tube (each its own `strand`) — `angleFrom` (a
path: angle 0 points *toward* it — Thread measures rope angles from the inboard direction, tube →
spine; without it angle 0 = `up` projected ⟂ the tangent, as in `place_leds.py`), `twistDegPerM`,
`startMM`/`endMM`, `up`. Ropes default to a diffused emitter (170°, soft). The **`along:`**
generator spaces instances along a path with their +Z following the tangent (`orient: none` keeps
the entry's `rotDeg`). Example: `layouts/ropes.yaml` — three ropes at 60°/180°/300° on one
S-curved tube.

A piece's layout belongs in the piece's own repo next to its model (Thread: `thread-3d/voxeled/
thread.yaml` — 3 tubes + spine from `tubes.json`/`align.json`, three ropes each, 7,200 LEDs, the
steel GLB; rope-derived positions land within a median 6 mm of the as-designed `leds_v2` map).
File params (`file:` in `mesh` / `vxl` / `gltf` fixtures, paths, structures) resolve **relative to
the layout file**.

## Placement generators — arrays, rings

One `instances:` entry can stand for many. Generators expand into plain instances at load time, so
everything downstream (emitters, patch, structures, the simulator) is unchanged; each expanded
instance carries `src: { i, k }` (layout entry, element) so the builder can edit the source.

```yaml
instances:
  - { fixture: heart, name: solo, pos: [0, 0, 0], rotDeg: [0, 30, 0] }             # explicit
  - fixture: panel                                                               # a MATRIX
    name: wall
    pos: [0, 0, 0]
    rotDeg: [0, 90, 0]                       # the matrix lives in the entry's frame
    array: { count: [4, 3, 1], spacing: [600, 600, 0], center: true }
    each: { emitter: { viewingAngleDeg: 100 } }   # applied to every element
  - fixture: heart                                                               # a RING (around Y)
    ring: { count: 8, radiusMM: 2500, startDeg: 0, facing: center }             # facing: center|out|tangent|none
```

Elements are named `<name>-<x>-<y>[-<z>]` (arrays) / `<name>-<k>` (rings). In the builder,
**make array** writes an `array:` onto the selected entry; moving a generated element moves the
generator's origin.

## Structures — the sculpture itself around the LEDs

The map says where the LEDs are; a **structure** is the *rest* of the piece — the steel ribbon, the
tubes and spine — as a CAD mesh drawn around them. In the viewer's dots mode it's translucent
context; in the **simulator** it's an opaque, depth-writing body, so the steel hides the LEDs behind
it exactly as the real piece does (toggle with **M**). STL, GLB/glTF and OBJ load; STEP does not —
export a mesh from your CAD (the heart's `heart_rails.stl` / `heart_rods.stl` came straight out of
its build123d model, in mm, in the same frame as the ribbon, so they overlay with no offset).

```yaml
fixtures:
  heart:
    type: mobius-heart
    structures:                                   # per FIXTURE: rides with every instance
      - { file: ../assets/heart_rails.stl, opacity: 0.35 }
      - { file: ../assets/heart_rods.stl }
structures:                                       # per SCENE: once, in world space
  - { file: ../assets/frame.glb, scaleToMM: 1000, pos: [0, 0, 0], rotDeg: [0, 90, 0] }
```

| field | default | meaning |
|---|---|---|
| `file` | — | STL / GLB / glTF / OBJ, resolved relative to the layout file |
| `scaleToMM` | 1 (glTF: 1000) | file units → mm (STL/OBJ carry none; glTF is metres) |
| `pos`, `rotDeg` | 0 | the mesh's own placement (mm, Euler degrees Z·Y·X like instances) |
| `opacity`, `color` | 0.3, `#6b7a99` | the translucent dots-mode look (sim mode is always opaque body) |

Per-fixture structures land in `meta.structures[]` once per instance with the instance transform
as `parent`; the hub serves each unique file at `/structure/<i>.<ext>` (`src/structures.mjs`).
`vox import … --structure model.stl[,frame.glb] [--structure-scale N]` attaches structures to an
imported scene, and `vox preview` serves them.

## Site context — the piece in the world, seen from where people stand

Two blocks anchor a layout to a real place and let you *stand* there in the viewer (**V**):

```yaml
site: { lat: 37.7749, lon: -122.4194, headingDeg: 0, groundMM: 0 }   # origin at lat/lon; −Z faces this compass bearing
vantages:
  - { name: sidewalk, lat: 37.77481, lon: -122.4194, eyeHeightMM: 1600, image: photos/sidewalk.jpg }  # equirectangular 360°
  - { name: corner,   lat: 37.7750,  lon: -122.4190, eyeHeightMM: 2500, cube: streetview/corner }     # n/e/s/w/u/d faces
  - { name: across,   pos: [-6000, 1600, 9000], image: photos/across.jpg, headingDeg: 210, fovDeg: 70 } # or a spot in mm
```

| field | default | meaning |
|---|---|---|
| `site.lat`, `site.lon` | — | where voxeled's origin sits |
| `site.headingDeg` | 0 | compass bearing (0 north, 90 east) of the piece's local −Z |
| `site.groundMM` | 0 | world Y of the ground; eye = ground + `eyeHeightMM` |
| `lat`/`lon` **or** `pos` | — | where the viewer stands (geo via the anchor, or mm directly) |
| `eyeHeightMM` | 1600 | eye above ground (Street View cars: ~2500) |
| `image` | — | an equirectangular 360° photo (jpg/png/webp); its centre column faces `headingDeg` |
| `cube` | — | a directory of compass-aligned faces `n e s w u d .jpg/.png` (`u`/`d` shot facing north, pitch ±90) |
| `headingDeg` | 0 | compass bearing of the image's centre column (a photo-sphere's `PoseHeadingDegrees`) |
| `fovDeg` | 60 | initial vertical field of view |

The hub serves the imagery at `/vantage/<i>[.ext | /<face>.ext]`; the viewer wraps it around the
camera as a 200 m sphere/box drawn first without depth, so LEDs, structures and the simulator render
over the photo at the true bearing and size. Drag to look, wheel to zoom, **V** cycles vantages;
`?stand=<name>&bearing=<deg>&pitch=<deg>&fov=<deg>` reproduces a view. Street View is one source
(`vox streetview <lat> <lon> -o dir`, the official Static API, six 90° faces, needs
`GOOGLE_MAPS_API_KEY`); a night 360° photo from your phone at the spot is a better one — Street
View is daytime and LED art is seen at night. No depth comes with a photo, so the real buildings
don't occlude the piece; for that, bring a site scan/CAD in as a scene-level structure.

## Bringing models in — the toolchain

The principle: **bake in the tool, one baked interchange.** Every modeling tool has its own idea
of curves, surfaces and placement rules, and none of them speak each other's — so voxeled doesn't
try to carry those across. Instead every on-ramp produces the same *baked* fixture: **points +
emission normals + data order + strand id** (plus pitch, emitter, wiring) — the `.vxl` fixture
above, with glTF as its visual twin. Procedural stays where it belongs: in the tool (Grasshopper),
or in voxeled's own layouts.

| where the artist is | on-ramp | normals · order |
|---|---|---|
| **SolidWorks / Fusion / Onshape / any STEP-STL shop** | **chip-island import** (`vox import model.stl`) — no plugin: export the model with the LED chips as bodies | chip thin axis (inferred) · chained |
| **Blender** (also the universal hub: it imports STEP/3DM/OBJ) | the **addon** ([integrations/blender](../integrations/blender/)): mesh vertices / faces / islands, curves as ropes, empties → `.vxl.json` (`type: vxl`); or glTF (`type: gltf`) / the mesh (`type: mesh`) | vertex/face/thin-axis/radial · vertex or curve order |
| **Rhino / Grasshopper** | the **script component** ([integrations/grasshopper](../integrations/grasshopper/)): points + normals + strand → `.vxl.json` (`type: vxl`) | as authored (estimated if absent) |
| **LX Studio / Chromatik** | `vox import model.lxm --fixtures ~/Chromatik/Fixtures` ([interop/lxm.md](interop/lxm.md)) | assigned (LX has none) · as generated |
| anything else | `.vxl.json` by hand (it's JSON: `pixels[].p`, `.n`, …) | as authored |

```bash
vox import model.stl --scale 1000 -o piece.vxl.json     # metres → mm; prints the report below
vox check piece.vxl.json                                 # is it safe to hand to voxeled (and to strangers)?
vox preview piece.vxl.json                               # → the viewer; ?sim=1 for the simulator
```

### Chip-island import (`src/io/mesh-import.mjs`)

Mechanical designers already model every LED chip as a small body, for fit. Export that model as
a mesh (STL — binary or ASCII — OBJ, or GLB) and each chip comes out as its own closed island of
triangles. The importer:

1. **clusters** the triangle soup into connected islands (shared vertices) — one island per chip
   (Thread's SolidWorks export: 87,120 triangles → 7,260 islands of exactly 12);
2. turns each island into an LED: **position** = centroid; **emission normal** = the chip's *thin*
   axis (smallest principal component of its vertices) — a mesh carries no orientation, so the
   **sign** is a policy: `--normal-sign outward` (default: away from the piece's centroid),
   `inward`, or a fixed `+x … -z`. Verify with the viewer's **N** quills; `vox check` reminds you
   the normals were inferred;
3. **infers the data order** the mesh doesn't carry: `--order chain` (default) estimates the pitch,
   then walks nearest neighbours from each strand endpoint, preferring to keep going straight, so
   every strand comes out as an ordered run with `s` = 0→1 along it (Thread: 12 strands of ~600,
   spacing σ = 0.04·pitch). `--order file` trusts the export order and breaks strands at jumps
   (the thread-3d method).

Knobs: `--scale <mm per unit>` (STL/OBJ carry no units; glTF is metres and handled), `--min-tris`
/`--max-tris` (keep only chip-sized islands when the structure is in the same mesh),
`--emitter '{"viewingAngleDeg":170,…}'` to attach an emitter profile. In a layout the same importer is
a fixture type:

```yaml
fixtures:
  thread:
    type: mesh
    params: { file: model.stl, scaleToMM: 1000, normalSign: outward, order: chain, maxTris: 40 }
    emitter: { viewingAngleDeg: 170, sizeFrac: 0.8, softness: 0.7 }   # a diffused rope
```

### `vox check`

Fails on: no pixels; **any pixel without an emission normal** (the format requires it — facing,
visibility and the simulator all depend on it). Warns on: non-unit normals; neighbouring normals that
flip (> 45°) along the data order; order jumps / irregular spacing (a scrambled order); duplicate
points; missing pitch; units that look like metres; a missing emitter profile; normals that were
inferred rather than authored.

## glTF export (`.glb`) — the map travels

`node examples/mobius-heart/export.mjs [layout.yaml]` (or `make export`) writes a binary glTF 2.0
file that opens in Blender, TouchDesigner, three.js, or any glTF tool. Mapping:

| voxeled | glTF |
|---|---|
| each fixture **instance** | a named **node** with a **POINTS** mesh (mode 0) |
| pixel **position** (mm) | `POSITION` accessor, VEC3 float, **scaled to metres** (÷1000) |
| pixel **normal** | `NORMAL` accessor, VEC3 float (unit) |
| snapshot **colour** | `COLOR_0` accessor, VEC4 float |
| full scene `meta` + version | `asset.extras.voxeled` (lossless round-trip) |

So a rig imports as named point-cloud objects at real-world scale, each carrying normals and a
baked look. The `extras.voxeled` block lets a voxeled-aware tool recover the exact scene.

Verified: the exporter is round-trip-checked in `test/gltf.test.mjs` (spec-compliant GLB), and the
output loads + renders in three.js `GLTFLoader` (independent of voxeled's own viewer).

## glTF import (`.glb` → fixture)

The reverse bridge: author geometry anywhere (Blender), bring it in as a fixture. Inspect a file
with `node examples/mobius-heart/import.mjs file.glb` (or `make import GLB=…`); a layout uses it via
the `gltf` fixture type:

```yaml
fixtures:
  ring: { type: gltf, params: { file: examples/mobius-heart/assets/torus.glb } }
```

Every point of every mesh primitive becomes an LED. `NORMAL` is used if present (else estimated
outward from the centroid); positions are scaled glTF-metres → mm and node transforms are baked in.
Imported fixtures mix freely with native ones in one rig — see
[`layouts/imported.yaml`](../examples/mobius-heart/layouts/imported.yaml) (a glTF torus between two
Möbius hearts, all driven by one show).

Verified: export → import round-trips positions to **< 1 mm** with normals preserved
(`test/gltf-import.test.mjs`), and it reads a foreign POSITION-only GLB, filling the normals.

## Roadmap for interchange

- **MVR/GDTF import** — pull a pro-lighting rig (fixtures + mm positions) from Vectorworks/Depence.
- **Explicit patch** — per-pixel universe/channel/offset so the map carries its wiring.
- **Stable versioning** — `voxeled` bumps on breaking changes; importers check it.
