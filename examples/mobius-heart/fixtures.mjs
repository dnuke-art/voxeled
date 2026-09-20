// Fixture-type registry: how a layout's `type:` becomes geometry. Shared by run.mjs (server)
// and export.mjs. Add new fixture types here — each is a (params) => { pixels, meta } function.
import { readFileSync } from "node:fs";
import path from "node:path";
import { sampleHeart } from "./heart.mjs";
import { gltfToFixture } from "../../src/io/gltf-import.mjs";
import { meshToFixture } from "../../src/io/mesh-import.mjs";
import { ropeFixture } from "../../src/fixtures/rope.mjs";
import { tubeFixture } from "../../src/fixtures/tube.mjs";
import { add, matVec, eulerMatrix, matMul, matToEulerDeg } from "../../src/vec.mjs";

// How a fixture EMITS — the simulator's physics knobs (viewer sim mode; see docs/FORMAT.md).
//   viewingAngleDeg — datasheet full angle at 50% intensity: 120 = a typical SMD LED (Lambertian),
//                     ~10 = a spot, ~1 = laser-like, ~170 = a diffused rope/tube.
//   sizeFrac        — emitter body edge as a fraction of pixel pitch (1.0 = contiguous panel tiles)
//   coreFrac        — lit fraction of the body (the LED chip/lens within the tile)
//   softness        — edge diffusion of the lit core (0 = hard chip, 1 = soft blob)
//   gain / glow     — emissive intensity / bloom contribution
const PANEL_LED = { viewingAngleDeg: 120, sizeFrac: 1.0, coreFrac: 0.42, softness: 0.35, gain: 1.7, glow: 1.0 };
const BARE_LED = { viewingAngleDeg: 120, sizeFrac: 0.6, coreFrac: 0.6, softness: 0.5, gain: 1.6, glow: 1.0 };
const withEmitter = (f, emitter) => ({ ...f, meta: { ...(f.meta || {}), emitter } });

export const FIXTURES = {
  // A flexible LED panel ribbon: contiguous tiles, each with a 120° SMD LED at its centre.
  "mobius-heart": (params) => withEmitter(sampleHeart(params), PANEL_LED),
  // Import any glTF/GLB as a fixture: LED points + normals from the file (Blender, etc.).
  //   { type: gltf, params: { file: path/to.glb } }   (path resolved from the working dir)
  gltf: (params) => withEmitter(gltfToFixture(readFileSync(path.resolve(params.baseDir || ".", params.file)), params), BARE_LED),
  // Mechanical CAD export (STL/OBJ/GLB) with each LED chip as its own body → chip-island import.
  //   { type: mesh, params: { file: model.stl, scaleToMM: 1, normalSign: outward, order: chain, maxTris: 40 } }
  mesh: (params) => withEmitter(meshToFixture(readFileSync(path.resolve(params.baseDir || ".", params.file)), { ...params, file: params.file }), params.emitter || BARE_LED),
  // LEDs along a path (a diffused rope on a tube, a strip along an edge): see src/fixtures/rope.mjs.
  //   { type: rope, params: { path: tube-1, count: 600, pitchMM: 152, radiusMM: 26, angleDeg: 60 } }
  rope: (params) => ropeFixture(params),
  // A flexible matrix panel rolled into a column (8×32 panels, 1–3 end to end in a diffuser tube): src/fixtures/tube.mjs.
  //   { type: tube, params: { cols: 8, rows: 32, panels: 3, pitchMM: 10, seamMM: 10 } }
  // One pixel at the origin — a phone that joined as a pixel (its screen shows the colour), a single lamp.
  // Normal +Z (out of a screen); with the phone's pose (+Y = its top edge) a flat phone faces up.
  dot: (params) => withEmitter({ pixels: [{ i: 0, p: [0, 0, 0], n: [0, 0, 1], s: 0, v: 0 }], meta: { source: "dot", pitchMM: params.sizeMM || 70, points: 1 } }, params.emitter || { viewingAngleDeg: 160, sizeFrac: 1, coreFrac: 0.9, softness: 0.8, gain: 1.4, glow: 1.0 }),
  tube: (params) => (params.emitter ? withEmitter(tubeFixture(params), params.emitter) : tubeFixture(params)),
  // A baked fixture file (.vxl.json) — what the Blender addon and the Grasshopper component write,
  // or a scene from `vox import`. Must carry normals (`vox check` enforces it).
  //   { type: vxl, params: { file: piece.vxl.json } }
  vxl: (params) => {
    const fx = JSON.parse(readFileSync(path.resolve(params.baseDir || ".", params.file), "utf8"));
    if (!Array.isArray(fx.pixels) || !fx.pixels.length) throw new Error(`${params.file}: no pixels`);
    if (fx.pixels.some((p) => !p.n)) throw new Error(`${params.file}: pixels without emission normals — run vox check`);
    // A scene exported by export.mjs carries its structures (the steel) placed by the instances
    // they rode with. Fold that placement into each entry so the baked fixture brings its steel
    // along wherever it is placed next.
    const structures = (fx.meta?.structures || []).map((s) => {
      const { parent, url, inst, ...own } = s;
      if (!parent) return own;
      const Rp = eulerMatrix(parent.rotDeg || [0, 0, 0]), Ro = eulerMatrix(own.rotDeg || [0, 0, 0]);
      return { ...own, pos: add(matVec(Rp, own.pos || [0, 0, 0]), parent.pos || [0, 0, 0]), rotDeg: matToEulerDeg(matMul(Rp, Ro)) };
    });
    return withEmitter({ pixels: fx.pixels, meta: { ...(fx.meta || {}), instances: undefined, structures } }, params.emitter || fx.meta?.emitter || BARE_LED);
  },
};
