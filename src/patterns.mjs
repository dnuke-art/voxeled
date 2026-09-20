// Spatial patterns — the core value voxeled keeps from LX Studio.
//
// A pattern is a pure function (pixel, t, ctx) -> [r,g,b] in 0..1. It is a function of the
// pixel's WORLD POSITION (mm) and/or its ribbon coordinate — never a per-index effect on a
// rectangle. Defined in real-world units, motion reads smoothly across irregular spacing.
// HSV -> RGB, all components 0..1.
export function hsv(h, s, v) {
  h = ((h % 1) + 1) % 1;
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Planes of light sweeping up the piece at a real speed (mm/s), repeating every `spacingMM` so
// there is always a band on the piece. Purely world-space — proves the animation is spatial, not
// indexed: it reads correctly across the non-flat, twisting ribbon.
export function planeSweep({ speedMM = 300, spacingMM = 500, widthMM = 120, hue = 0.95 } = {}) {
  return (px, t) => {
    const u = (px.p[1] - t * speedMM) / spacingMM; // +Y is up; repeating coordinate up the piece
    const f = u - Math.floor(u); // 0..1 within a band cell
    const d = Math.min(f, 1 - f) * spacingMM; // mm to the nearest band centre
    const band = Math.exp(-((d / widthMM) ** 2)); // soft gaussian bands, sweeping forever
    return hsv(hue, 0.85, clamp01(band));
  };
}

// A hue chase around the loop in ribbon-arclength s. With the Möbius ½-twist, the wave flows
// around and returns on the "other" apparent side — the geometric payoff, made visible.
export function ribbonChase({ loops = 3, speed = 0.15, sat = 1 } = {}) {
  return (px, t) => hsv(px.s * loops - t * speed, sat, 1);
}

// Encode each pixel's emission normal as colour (x,y,z → r,g,b). Always fully lit — the direct
// visual proof of the map: the colour field you see *is* the emission-direction field. As the
// piece turns, watch the colours track the surface (and flip across the Möbius twist).
export function normalRGB() {
  return (px) => [(px.n[0] + 1) / 2, (px.n[1] + 1) / 2, (px.n[2] + 1) / 2];
}

// A plane of light wiping along a world axis — the multi-instance showcase, and where the
// "account for distance" toggle lives:
//   space:'world'   → samples the pixel's WORLD position. One wave crosses instance A, then the
//                     real empty gap between instances (dark, taking real time), then instance B.
//                     The 10-ft spacing is physically accounted for.
//   space:'fixture' → samples the pixel's FIXTURE-LOCAL position (via ctx.local). Every instance
//                     shows the identical wave in sync; the distance between them is ignored.
export function worldWipe({ axis = 0, speedMM = 700, spacingMM = 1600, widthMM = 300, space = "world", hue = 0.33 } = {}) {
  return (px, t, ctx) => {
    const pos = space === "fixture" && ctx?.local ? ctx.local(px) : px.p;
    const u = (pos[axis] - t * speedMM) / spacingMM;
    const f = u - Math.floor(u);
    const d = Math.min(f, 1 - f) * spacingMM;
    return hsv(hue, 0.9, clamp01(Math.exp(-((d / widthMM) ** 2))));
  };
}

// ── visibility patterns: "the piece as a real object seen from a vantage" ──────────────
// Both run one whole-scene depth pass per frame (cached on ctx.frame — the hub renders pixels in
// order, so the first pixel of each frame computes it and the rest reuse it), then read per-pixel.
import { frameCamera, computeVisibility } from "./visibility.mjs";

// A helper that recomputes visibility once per frame for an orbiting auto-framed camera.
function perFrameVisibility({ orbitDegPerSec = 12, angleDeg = 20, elevDeg = 14, fovDeg = 55, res = 128, splat = 2, backface = true }) {
  let cachedFrame = -1, vis = null;
  return (t, ctx) => {
    if (ctx.frame !== cachedFrame || !vis) {
      const cam = frameCamera(ctx.scene, { angleDeg: angleDeg + orbitDegPerSec * t, elevDeg, fovDeg });
      vis = computeVisibility(ctx.scene, cam, { width: res, height: res, splat, backface });
      cachedFrame = ctx.frame;
    }
    return vis;
  };
}

// Light only the pixels the camera can SEE — occluded strands (hidden behind the piece) and
// back-facing pixels go dark. Orbit the vantage and LEDs wink in and out as the sculpture turns:
// the Thread problem, computed instead of hand-managed. Front-facing brightness falls off at grazing.
export function spotlight({ orbitDegPerSec = 12, angleDeg = 20, elevDeg = 14, fovDeg = 55, res = 128, splat = 2, hue = 0.13, hidden = [0.03, 0, 0] } = {}) {
  const vis = perFrameVisibility({ orbitDegPerSec, angleDeg, elevDeg, fovDeg, res, splat, backface: true });
  return (px, t, ctx) => {
    const v = vis(t, ctx)[px.i];
    if (!v || !v.visible) return hidden; // occluded or facing away
    return hsv(hue, 0.5, clamp01(0.35 + 0.65 * v.facing)); // grazing angles dimmer
  };
}

// Projection-map a scrolling texture through the camera onto the visible surface — voxeled as the
// house system a VJ jacks into: a 2D frame sampled onto the real 3D piece, occlusion respected.
export function projector({ orbitDegPerSec = 0, angleDeg = 20, elevDeg = 14, fovDeg = 55, res = 128, splat = 2, scroll = 0.12, off = [0, 0, 0] } = {}) {
  const vis = perFrameVisibility({ orbitDegPerSec, angleDeg, elevDeg, fovDeg, res, splat, backface: true });
  const tex = (u, v, t) => hsv(u + t * scroll, 0.9, clamp01(1 - Math.abs(v - 0.5) * 1.3)); // a scrolling horizontal band
  return (px, t, ctx) => {
    const p = vis(t, ctx)[px.i];
    return p && p.visible ? tex(p.uv[0], p.uv[1], t) : off;
  };
}

// ── cylinder / volume patterns: the payoff of pixels that aren't a line ───────────────
// A rolled tube gives every pixel s (up the column), v (around it) and a radial normal; a room
// full of them gives world angle about the floor's centre. These use all three.

// A soft periodic band: phase in periods → 0..1 brightness, `width` the lit fraction of a period.
const band = (phase, width) => { const f = phase - Math.floor(phase), d = Math.min(f, 1 - f); return Math.exp(-((d / (width * 0.5)) ** 2)); };

// Scene centre + floor radius, computed once per scene (cached on ctx).
function sceneFrame(ctx) {
  if (ctx._frame) return ctx._frame;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const px of ctx.scene.pixels) for (let k = 0; k < 3; k++) { if (px.p[k] < lo[k]) lo[k] = px.p[k]; if (px.p[k] > hi[k]) hi[k] = px.p[k]; }
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  return (ctx._frame = { lo, hi, c, floorR: Math.max(hi[0] - lo[0], hi[2] - lo[2]) / 2 || 1 });
}

// A barber-pole spiral on every fixture: a stripe that winds around (v) as it climbs (s) and
// rotates with time. `turns` stripes around, `pitch` wraps over the fixture's length, `speed` in
// turns/s (negative = the other hand). On a heart the stripe runs across the ribbon as it goes round.
export function helix({ turns = 1, pitch = 3, speed = 0.5, width = 0.35, hue = 0.55, hueAlong = 0.25, dir = 1 } = {}) {
  return (px, t) => {
    const phase = px.v * turns + dir * px.s * pitch - t * speed;
    return hsv(hue + px.s * hueAlong, 0.9, clamp01(band(phase, width)));
  };
}

// A lantern carried through the room: a point light on an orbit (or a figure of eight), lighting
// each LED by how much its NORMAL faces the lamp (Lambert) and how far away it is. The near side
// of every column glows, the far side stays dark, and the lit crescent walks around each tube as
// the lamp passes — nothing a linear array can do. `path: orbit | eight`, radius defaults to the
// installation's floor radius, height in mm; `ambient` keeps the far sides just visible.
// `lampFrom: <tracker>` puts the lamp in someone's hand (a phone, a wand): ctx.poses (src/poses.mjs).
export function lantern({ path = "orbit", radiusMM = null, heightMM = 1200, speed = 20, falloffMM = 4000, hue = 0.09, sat = 0.55, ambient = 0.03, gain = 2.5, lampFrom = null, offsetMM = 0 } = {}) {
  return (px, t, ctx) => {
    const F = sceneFrame(ctx), R = radiusMM ?? F.floorR * 0.8, a = (t * speed * Math.PI) / 180;
    const held = lampFrom && ctx.poses?.get(lampFrom);
    const L = held ? [held.pos[0] + held.aim[0] * offsetMM, held.pos[1] + held.aim[1] * offsetMM, held.pos[2] + held.aim[2] * offsetMM]
      : path === "eight"
      ? [F.c[0] + R * Math.sin(a), heightMM, F.c[2] + R * Math.sin(2 * a) * 0.6]
      : [F.c[0] + R * Math.cos(a), heightMM, F.c[2] + R * Math.sin(a)];
    const d = [L[0] - px.p[0], L[1] - px.p[1], L[2] - px.p[2]], dist = Math.hypot(d[0], d[1], d[2]) || 1;
    const facing = (px.n[0] * d[0] + px.n[1] * d[1] + px.n[2] * d[2]) / dist;         // cos of the angle to the lamp
    const fall = 1 / (1 + (dist / falloffMM) ** 2);
    return hsv(hue, sat, clamp01(ambient + gain * Math.max(0, facing) * fall));
  };
}

// Spiral arms sweeping over the floor around the installation's centre, climbing each column as
// they pass (`twist` wraps per column length) and wrapping around each tube (`wrap` turns of v) —
// a world-space vortex that every column shares, with its own local spiral riding on top.
export function swirl({ arms = 2, spacingMM = 3000, speed = 0.25, twist = 1, wrap = 1, width = 0.4, hue = 0.72, hueSpin = 0.3 } = {}) {
  return (px, t, ctx) => {
    const F = sceneFrame(ctx);
    const th = Math.atan2(px.p[2] - F.c[2], px.p[0] - F.c[0]) / (2 * Math.PI);      // world angle, turns
    const r = Math.hypot(px.p[0] - F.c[0], px.p[2] - F.c[2]) / spacingMM;            // world radius, in arm spacings
    const phase = arms * th + r + px.s * twist + px.v * wrap - t * speed;
    return hsv(hue + th * hueSpin, 0.85, clamp01(band(phase, width)));
  };
}

// Rain: drops falling down each column, the drop lighting only the side it's on and wrapping as it
// falls — world-random per fixture instance so the columns don't fall in lockstep.
export function drops({ rate = 0.6, speed = 0.5, lengthS = 0.15, spin = 2, hue = 0.58, tail = 0.5 } = {}) {
  return (px, t) => {
    const k = ((px.inst || 0) * 7919 + 1) % 97 / 97;                                 // per-instance phase
    const period = 1 / rate, u = (t * rate + k) % 1, head = 1 - u * (1 + lengthS) * speed * period; // s of the drop's head
    const below = head - px.s;                                                        // >0: pixel is under the head (the tail)
    const along = below >= 0 && below < lengthS ? (1 - below / lengthS) : 0;
    const side = 0.5 + 0.5 * Math.cos(2 * Math.PI * (px.v - u * spin));             // the drop rides one side, spinning
    return hsv(hue, 0.8, clamp01((along ** (1 / tail)) * (0.15 + 0.85 * side)));
  };
}

// A torch beam from a tracked thing: aim a wand (or a phone) at a column and it lights. Pixels
// within `spreadDeg` of the tracker's aim ray glow, brightest on the axis, fading with distance;
// the side facing the wand is lit more than the far side (normal · direction to the wand).
export function point({ from, spreadDeg = 12, reachMM = 8000, hue = 0.16, sat = 0.5, gain = 1.6, ambient = 0 } = {}) {
  const cosSpread = Math.cos((spreadDeg * Math.PI) / 180);
  return (px, t, ctx) => {
    const P = from && ctx.poses?.get(from);
    if (!P) return hsv(hue, sat, ambient);
    const d = [px.p[0] - P.pos[0], px.p[1] - P.pos[1], px.p[2] - P.pos[2]], dist = Math.hypot(d[0], d[1], d[2]) || 1;
    const c = (d[0] * P.aim[0] + d[1] * P.aim[1] + d[2] * P.aim[2]) / dist;                  // cos angle off the aim ray
    if (c < cosSpread) return hsv(hue, sat, ambient);
    const beam = (c - cosSpread) / (1 - cosSpread);
    const facing = Math.max(0.15, -(px.n[0] * d[0] + px.n[1] * d[1] + px.n[2] * d[2]) / dist); // the side facing the wand
    const fall = 1 / (1 + (dist / reachMM) ** 2);
    return hsv(hue, sat, clamp01(ambient + gain * beam * facing * fall));
  };
}

// A paintbrush: whatever a tracked thing is waved near stays lit and fades. Stateful per pattern
// instance (a last-touched time per pixel), keyed on the pixel index — the hub renders every pixel
// each frame, so the stamp is refreshed as the wand passes.
export function paint({ from, radiusMM = 500, decayS = 6, hue = 0.85, hueDrift = 0.05, sat = 0.9 } = {}) {
  let stamp = null, hues = null;
  return (px, t, ctx) => {
    const N = ctx.scene.pixels.length;
    if (!stamp || stamp.length !== N) { stamp = new Float32Array(N).fill(-1e9); hues = new Float32Array(N); }
    const P = from && ctx.poses?.get(from);
    if (P) {
      const dist = Math.hypot(px.p[0] - P.pos[0], px.p[1] - P.pos[1], px.p[2] - P.pos[2]);
      if (dist < radiusMM) { stamp[px.i] = t; hues[px.i] = hue + t * hueDrift; }
    }
    const age = t - stamp[px.i];
    return age < 0 ? [0, 0, 0] : hsv(hues[px.i], sat, clamp01(Math.exp(-age / decayS)));
  };
}

export const PATTERNS = { ribbonChase, worldWipe, planeSweep, normalRGB, spotlight, projector, helix, lantern, swirl, drops, point, paint };
