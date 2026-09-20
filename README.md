# voxeled

**Open, integration-friendly volumetric LED show control.**

Drive real fixtures from *spatial* animations authored in **real-world units** — so motion reads smoothly across LEDs that aren't evenly spaced. Reuse the geometry and fixtures you already have (Blender, glTF/USD, GDTF/MVR). Preview in the browser and light up the real thing from the *same frames*.

![status](https://img.shields.io/badge/status-early%20design-orange)
![license](https://img.shields.io/badge/license-MIT-blue)
![PRs](https://img.shields.io/badge/PRs-welcome-brightgreen)

> **Status: authoring works end to end.** A layout file (fixtures + placements + structures + patch + show) → a hub → identical frames to a WebGL preview / **appearance simulator** and to Art-Net, DDP and dan-mx fixtures (`npm run demo`; 22 test suites incl. a headless-Chrome render gate). Geometry comes in from mechanical CAD (chip-island STL/OBJ/GLB import), Blender, Grasshopper, glTF, Chromatik `.lxm`, or a path + rope description; an in-viewer **builder** places, arrays, wires and saves it; voxeled is also a native **DDP Display**. Still ahead: the camera automapper, dynamic scenes, GDTF/MVR, the hosted layer. Long-horizon code samples further down are marked **illustrative**. Start with the [authoring guide](docs/GUIDE.md).

## Documentation

- **[Authoring guide](docs/GUIDE.md)** — the whole workflow: concepts, frames & units, the complete
  layout reference (fixture types, instances & generators, emitter, patch, show), getting geometry
  in, structures, paths & ropes, the builder, baking/export, running, a worked example (Thread), gotchas.
- [Scene & layout formats](docs/FORMAT.md) · [Demo walkthrough](docs/DEMO-mobius-heart.md) ·
  [Visibility & the simulator](docs/visibility.md) · [Protocols](docs/interop/protocols.md) ·
  [Chromatik `.lxm`/`.lxf`](docs/interop/lxm.md) · [Design](docs/DESIGN.md) ·
  [The landscape — where voxeled sits](docs/LANDSCAPE.md)
- Integrations: [Blender](integrations/blender/) · [Grasshopper](integrations/grasshopper/) · [TiXL](integrations/tixl/)

## Try it — Möbius LED Heart

The first working slice maps and drives a real piece, the [Möbius LED Heart](https://github.com/dnewcome/mobius-led-heart):

```bash
node examples/mobius-heart/run.mjs      # or: npm run demo   (Node ≥18, no dependencies)
# open http://localhost:8080  ·  drag the crossfader  ·  press N for normals
```

Because the heart is generated from a parametric ribbon, voxeled maps it by *evaluating that parametrization* — every LED gets an exact position **and** emission normal (`F = T × D`), no camera scan needed. The default demo places **two hearts 10 ft apart** in one world space and **auto-crossfades a show** across them — including a wipe that accounts for the real gap between them (world space) and a synced version that ignores it (fixture space). The rig — how many hearts, where they sit, and the scene list — is a small [YAML layout file](examples/mobius-heart/layouts/two-hearts.yaml) you can edit (`VOX_LAYOUT=…`). Identical frames drive the browser preview and real fixtures over Art-Net/DDP (`ARTNET=host DDP=host …`). The viewer bundles three.js locally, so it runs **fully offline** — no CDN. `npm test` covers the whole stack, including a headless-Chrome render gate. Full walkthrough: [`docs/DEMO-mobius-heart.md`](docs/DEMO-mobius-heart.md).

---

## Why

There are good LED tools, but each one boxes you in:

- **LX Studio / Chromatik** nails the right *idea* — pixels as a positioned 3D point cloud, patterns as spatial functions — but it's a monolithic Java desktop app. Custom patterns compile against the app, geometry import is painful, and it doesn't round-trip to any standard format. Powerful, but hard to integrate with anything else.
- **MADRIX 5** does true volumetric (voxel) rendering beautifully — and is Windows-only, closed, and gated behind a USB dongle priced by channel count.
- **xLights** is open and capable, but its mental model is a 2D buffer you *project* onto geometry — awkward for genuine volumes — and it's built for a sequence-and-play pipeline, not real-time embedding.

None of them combine **real-world-unit spatial animation** with **open, cross-platform, integration-friendly** interchange. That gap is the whole point of voxeled.

**The wedge is integration.** voxeled is not one big app — it's an **ecosystem of small cooperating parts** around a stable, open contract: WebGL visualizers, Blender plugins, protocol senders/sinks, and the network glue between them.

## Core ideas

- **3D is the native render space.** Every pixel is a *positioned point* with a *normal* (which way its light points). Patterns are spatial functions of world position + time — `f(x, y, z, t) → color` — not per-index effects on a rectangle. This is the one thing worth keeping from LX, and it's the core value.
- **Real-world units, everywhere.** Positions are in millimeters. A "sweep 200 mm/s up the rig" reads correctly whether pixels are 10 mm or 300 mm apart.
- **A live hub + a normalized pixel bus.** One process holds the scene, runs the pattern engine, and fans identical frames out to every consumer at once. **Preview == output.**
- **Own the format, import the world.** A small, versioned, pixel-first scene format is the source of truth — with importers for glTF/USD (meshes), and GDTF/MVR (pro fixtures + rigs, positions already in mm). Reuse assets; don't reinvent them, and don't get locked into someone else's schema.

## Architecture

```
     authoring / import                    runtime spine                          outputs
 ┌────────────────────────┐        ┌───────────────────────────┐        ┌───────────────────────────┐
 │ Blender plugin (GN)    │        │        voxeled hub        │        │  WebGL visualizer(s)      │
 │ glTF / USD import      │        │  ┌─────────────────────┐  │ frames │  (WebSocket)              │
 │ GDTF / MVR import      │──scene─▶│  │ sparse point cloud  │  │───────▶├───────────────────────────┤
 │ camera automapper      │ (.vxl) │  │ spatial pattern eng.│  │───────▶│  DDP · sACN · Art-Net     │
 │                        │        │  │ normalized pixel bus│  │ frames │  senders → real fixtures  │
 └────────────────────────┘        │  └─────────────────────┘  │        └───────────────────────────┘
                                    └───────────────────────────┘
       geometry + normals              same frames to everyone          preview and reality match
```

Every arrow is a boundary you can plug into. A visualizer is just a bus consumer. A new protocol is just a sender. A new geometry source is just something that emits a scene.

## Lineage

voxeled grows directly out of [**thread-3d**](https://github.com/dnewcome/thread-3d) — a real-time Three.js visualizer for a 12-strand, 7,200-LED spiral sculpture, driven live over Art-Net. thread-3d proved the core loop (CAD model → LED point cloud → live-lit 3D view) and surfaced the exact problems voxeled exists to generalize:

- **CAD → points was bespoke.** thread-3d extracts LED positions by parsing an STL, detecting strand breaks from centroid jumps, and binning triangles evenly per strand — clever, but hardcoded to `12 × 600` and dependent on triangle export order. voxeled replaces this with a declarative scene format + reusable importers.
- **Positions, but no normals.** thread-3d recovers positions, not a per-LED *emission direction* — and because the LEDs ride a swept tube, averaging that tube's radial face normals cancels out. "Which way does the light point" is precisely the bit voxeled makes first-class: the answer is the **sculpture's surface normal** at each point (outward from the form), not the tube's. See the normals discussion in [`docs/DESIGN.md`](docs/DESIGN.md).
- **Browsers can't receive UDP,** so thread-3d had to be an Electron app to open the Art-Net socket. voxeled fixes this at the architecture level: the **hub** owns the UDP/Art-Net/DDP side and streams frames to browser visualizers over **WebSocket** — so viewers are pure web pages, and thread-3d's renderer becomes just one more bus consumer.

## The scene format (proposed)

A voxeled scene co-locates **geometry**, **per-output addressing**, and **user parameters** in one declarative file — borrowing Chromatik's best idea, kept small and stable. Geometry can be authored inline or *referenced* from imported assets.

```toml
# scene.vxl — illustrative
units = "mm"                          # real-world units are the whole point

[[fixture]]
name = "left-arch"
mesh = "arches.glb#LeftArch"          # reuse imported geometry, don't redraw it

  [[fixture.strip]]
  count   = 144
  path    = "curve:LeftArch.Rail"     # positions sampled along the curve
  normals = "surface"                 # emission direction from the mounting face,
                                       # NOT the strip's travel direction

  [fixture.output]
  protocol   = "ddp"                  # DDP-first for high pixel counts
  host       = "192.168.1.50"
  offset     = 0
  byte_order = "grb"
```

Each pixel resolves to, at minimum, **`position + normal + address`**. The normal is a first-class field — carried through glTF as the standard `NORMAL` attribute / USD `normals` primvar so it survives round-trips. Because voxeled keeps position **and** orientation, it can go a step further than a point cloud and reason about **visibility** — projecting the map through a virtual camera to ask *which LEDs are actually seen from a vantage* (self-occlusion, silhouette, back-faces). Occlusion, projection-mapping, and camera automapping are one primitive; see [`docs/visibility.md`](docs/visibility.md) (`VOX_PATTERN=spotlight`). And the viewer's **simulator** (**S**) turns that into *appearance*: each LED is rendered as an oriented emissive body — a viewing-angle lobe derived from the datasheet angle (120° ⇒ Lambertian; laser to diffused rope from one shader), a dark backside, self-occlusion, bloom for diffusion — so you see what the piece actually looks like from a vantage, not just where its pixels are. Emitter profiles are data on the fixture ([`docs/FORMAT.md`](docs/FORMAT.md#emitter--how-the-leds-emit-simulation)).

The format is documented in [`docs/FORMAT.md`](docs/FORMAT.md), and any scene **exports to glTF today** (`make export`): the map opens as named point-cloud objects, at real-world scale with normals + a baked look, in Blender / TouchDesigner / three.js — verified by loading it back through a standard glTF loader.

A pattern is a spatial function, not a per-index loop:

```js
// world-space, real units — 200 mm/s wave sweeping up the rig
export const wave = ({ x, y, z }, t) =>
  hsv(0.6, 1, clamp(Math.sin((y - t * 200) / 40)))
```

## Protocols

| Protocol | Why | voxeled |
|---|---|---|
| **DDP** | Offset-addressed flat framebuffer — no 512-channel fragmentation, no DMX refresh cap. Best for high pixel counts. | **primary** |
| **sACN / E1.31** | Industry-standard IP-DMX, clean multicast, priority — pro/console interop. | planned |
| **Art-Net** | Broadest reach; legacy consoles and controllers. | planned |
| **OPC** | Dead-simple, creative-coding/DIY (FadeCandy lineage). | maybe |

## Integrations

- **TiXL** ([`integrations/tixl/`](integrations/tixl/)) — a `LoadVoxeledScene` operator imports a
  `.vxl` scene as TiXL **Points** (world position + emission-normal orientation), so you author and
  animate the map with TiXL's own effects and drive it through TiXL's native Art-Net — or hand
  colored points back to voxeled (`VoxeledOutput` → `VOX_LISTEN`) for the full mixed-protocol patch.
  Each point carries its fixture index (via `FixtureIndex` / the `F2` channel) so `FilterPoints` can
  group per fixture. **Confirmed rendering on TiXL 4.1.**
- **Blender** ([`integrations/blender/`](integrations/blender/)) — an addon that bakes LEDs *with
  emission normals*: mesh vertices / faces (panels) / islands (modelled chips), curves as ropes on
  tubes, empties as aimed LEDs → `.vxl.json`, which any layout places with `type: vxl`. Tested
  headless against Blender 5.2. (glTF export *and* import work too.)
- **Rhino / Grasshopper** ([`integrations/grasshopper/`](integrations/grasshopper/)) — a Python
  script component: points + normals + strand from your definition → `.vxl.json`.
- **TouchDesigner / three.js** — via glTF export *and* import (see the scene-format section).
- **Builder mode** (`E` in the viewer) — author the installation *in* voxeled: click-select,
  gizmo move/rotate, duplicate/delete/add, turn an entry into a **matrix**, save — editing the same
  git-diffable layout YAML the hub runs (`GET/POST /layout`, live, file-watched). Rings and arrays
  are one line of YAML ([placement generators](docs/FORMAT.md#placement-generators--arrays-rings)).
- **LEDs placed on a structure** — name a path (inline, or from a file like thread-3d's
  `tubes.json`) and a `rope` fixture follows it: LEDs offset from the axis, wrapped at an angle,
  normals radial — the Thread workflow as data ([paths & ropes](docs/FORMAT.md#paths--ropes--placing-leds-on-a-structure)).
  `along:` spaces whole instances along a path.
- **The sculpture's own CAD** — a layout's `structures:` draw the steel (STL/GLB/OBJ) around the LEDs:
  translucent context in the viewer, an opaque **occluder** in the simulator. The demo ships the
  heart's rails + rods from its build123d model (`M` to toggle).
- **Any mechanical CAD (SolidWorks / Fusion / Onshape / STEP-STL)** — the **chip-island importer**:
  export the model with its LED chips as bodies, `vox import model.stl`, and every chip becomes an
  LED with an inferred emission normal and a recovered strand order — no plugin in anyone's CAD.
  `vox check` validates, `vox preview` shows it. The toolchain and its "bake in the tool, one baked
  interchange" principle are in [`docs/FORMAT.md`](docs/FORMAT.md#bringing-models-in--the-toolchain).
- **LX Studio / Chromatik** — import a `.lxm` model into voxeled (`src/io/lxm-import.mjs`); its
  fixtures, transforms, and per-fixture output patch become a voxeled scene — and voxeled *assigns
  the emission normals LX discards* (a Chromatik cube imports with its four correct outward face
  normals). Handles built-in `GridFixture` **and** `JsonFixture` `.lxf` templates — a small
  expression evaluator generates their `strip`/recursive geometry. Verified on stock Chromatik rigs;
  format reverse-engineered in [`docs/interop/lxm.md`](docs/interop/lxm.md).
- **Protocols** — Art-Net, DDP, and **[dan-mx](https://github.com/dnewcome/dan-mx)** (a custom IP LED
  protocol, with opt-in RLE/DELTA compression + in-band colour space & transfer), all driven from one
  patched scene. voxeled is also a native **DDP Display** (`VOX_DDP_IN=4048`): xLights, FPP, LedFx,
  Chromatik or any DDP sender can drive the preview, the simulator and the patch — DDP in, any
  protocol out. See [`docs/interop/protocols.md`](docs/interop/protocols.md) for the whole family.

## Where voxeled sits

The full tier-by-tier survey (hobby sequencers → art engines → real-time engines → media servers → consoles/previz) and what "pro show control" would still need is in [`docs/LANDSCAPE.md`](docs/LANDSCAPE.md).

| | **voxeled** | xLights | MADRIX 5 | LX / Chromatik |
|---|---|---|---|---|
| Render space | native 3D point cloud | 2D buffer → projected | 3D voxel matrix | 3D point cloud |
| Real-world-unit patterns | ✅ core | partial | grid / voxel | ✅ |
| Open + cross-platform | ✅ MIT | ✅ open source | ❌ Windows, dongle | ✅ (but monolithic) |
| Embeddable / API-first | ✅ hub + bus | build-pipeline API | ❌ | ❌ (drive via OSC) |
| Imports glTF / GDTF / MVR | planned | ❌ | ❌ | ❌ (own `.lxf`) |
| Camera automapping | planned, built-in | 3rd-party workflow | ❌ | ❌ |
| Visibility / occlusion-aware | ✅ virtual camera | ❌ | ❌ | ❌ (point cloud) |
| Appearance sim (view angle · backside · occlusion · diffusion) | ✅ emitter profiles | ❌ | partial (3D voxels) | ❌ (flat points) |

*(Comparison is about fit for this niche, not overall quality — these are all good tools.)*

## The north star: camera automapping & dynamic scenes

Two differentiators the incumbents leave open:

- **Built-in camera automapper.** Stop hand-placing thousands of pixels. Light them in a **Gray-code** sequence, detect each in a camera frame, and **triangulate** across ≥2 views into a real 3D point cloud (single camera → 2D map). Strong prior art (aaknitt/pixel_mapper, Lightwork) but no polished, integrated product.
- **Dynamic scenes.** Positions that update *live* — from camera tracking or from MVR-xchange feeding CAD position changes over the network — so a moving rig re-maps continuously. Today's tools do a one-time static scan; nothing does this well.

## Roadmap

- **Phase 0 — the spine** ✅: scene format → hub → spatial patterns → normalized bus → WebGL preview + DDP/Art-Net/dan-mx senders, mixed per-fixture patch. Preview and reality visibly match.
- **Phase 1 — bring your geometry**: glTF import ✅, the chip-island mesh importer for any mechanical CAD ✅, LX/Chromatik `.lxm` import ✅, Blender addon ✅, Grasshopper component ✅, paths + ropes (LEDs derived from a structure) ✅, structures (the piece's own CAD as context + occluder) ✅, the in-viewer builder (place / array / wire / save, live layout file) ✅; still ahead: fixture packages + a data-driven registry, then GDTF/MVR.
- **Phase 2 — automap**: Gray-code structured-light camera mapper, multi-view triangulation, export to native + glTF. (The virtual-camera visibility primitive ✅ is this math already — automapping is it run in reverse.)
- **Phase 3 — live**: scenes & crossfades ✅, the appearance simulator ✅, external frame input (TiXL over TCP, any DDP sender — voxeled as a DDP Display) ✅, **inputs + merge** — Art-Net (with ArtPoll discovery), sACN, DDP, TCP and pages on the bus driving the piece simultaneously, per-pixel priority / HTP / LTP with timeouts and failover to the show, input maps for real controller wiring ✅; **moving fixtures + poses** ✅ — `trackers:` (PosiStageNet, JSON poses on the bus, the phone as a wand) drive tracked instances live and feed patterns (a lantern in a hand, a torch beam, a paintbrush); still ahead: live re-localization / MVR-xchange, DAW-style channels + modulators (LFOs / envelopes / audio), the live-frame VJ jack-in (NDI).
- **Phase 4 — hosted & public**: the same hub behind a URL, so a piece has an *address*. First slice landed ✅: the demo prints a QR code; a phone on the LAN scans it and gets a scene picker + crossfader on the hub's `/control` seam (`viewer/phone.html`). Two things the address unlocks:
  - **Public interaction** — a QR code on the sculpture opens a phone page (no app) that jacks into the hub's control seam: pick or trigger scenes, nudge the crossfader, send a colour, or make *your tap a wave that starts from where you're standing* — the map knows where that is. Per-piece, rate-limited, moderated. (We've done QR-driven interaction on past pieces; this makes it a built-in rather than a one-off.)
  - **Collaborative pattern design** — patterns are already pure `f(pixel, t, ctx)` and the viewer + simulator already run in the browser, so collaborators write and preview a pattern *against the piece's real map, in the simulator, in a browser tab* — no install — then submit it as a scene to the show. Sandboxed (a Worker), versioned, previewable before it ever touches an LED.
  - The LEDs never depend on the internet: the local hub keeps driving the piece and falls back to its own show if the link drops; the hosted side is control-plane + preview + the piece's public face.
- **Phase 5 — site context**: see the piece *in place* before it's built. First slice landed ✅: a
  **geo-anchor** (`site: { lat, lon, headingDeg }`) maps voxeled's mm frame onto the world, and
  **vantages** — places to stand, each with a 360° backdrop (an equirectangular photo, or a
  compass-aligned cubemap that `vox streetview <lat> <lon>` fetches through the official Street View
  Static API) — put the camera at that eye with the piece rendered over the photo at the true bearing
  and size (**V** in the viewer; `layouts/site.yaml`). Still ahead: **Google Photorealistic 3D
  Tiles** in three.js (fly to street level in the real city, real buildings occluding the piece), a
  site scan / LiDAR as an occluding structure, and photo-matching a vantage from a single photo.
  Street View itself has no supported 3D-overlay path, so the panorama is a backdrop, not the widget.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full design notes and the reasoning behind these decisions.

## Design principles

1. **Open by default** — MIT, cross-platform, no dongles, no lock-in.
2. **Interoperate, don't imprison** — import the standards; keep your own file the source of truth.
3. **3D is native**, not a projection of a 2D buffer.
4. **Space over index** — patterns are spatial functions in real-world units.
5. **Preview == output** — the same frames drive the visualizer and the fixtures.
6. **An ecosystem of small parts**, not a monolith.

## Contributing

Very early — issues, ideas, and prior-art pointers are welcome while the spine takes shape. If you've fought the CAD-model → LED-points-with-correct-normals problem, or camera automapping, come say hi in the issues.

## License

[MIT](LICENSE) © Dan Newcome
