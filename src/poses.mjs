// Poses — where tracked things ARE. The pose-side twin of inputs: a registry of named trackers
// (a wand, a phone, a PSN tag), each with a live position (mm), orientation (rotDeg, Z·Y·X like
// instances) and an aim direction (the tracker's `aim` axis rotated into the world). Two uses:
//   moving fixtures  an instance with `track: <name>` is re-placed from its fixture-local geometry
//                    every time that tracker's pose arrives (createMover) — the wand's own LEDs
//                    light where it is, world patterns sweep over it, it occludes in the simulator
//   pose as control  patterns read ctx.poses.get(name): a lantern carried by hand, a torch beam,
//                    a paintbrush leaving trails on the piece
import { add, matVec, eulerMatrix, norm, transpose3 } from "./vec.mjs";

export function createPoses() {
  const map = new Map();
  return {
    // pos [mm], rotDeg [deg]; aimAxis is the tracker's pointing axis in its own frame (default +Y)
    set(id, { pos, rotDeg = [0, 0, 0], aimAxis = [0, 1, 0], source = "ws" } = {}) {
      if (!Array.isArray(pos) || pos.length !== 3 || pos.some((x) => typeof x !== "number" || !isFinite(x))) throw new Error(`pose "${id}": pos must be [x, y, z] mm`);
      const R = eulerMatrix(rotDeg);
      const p = { id, pos: pos.slice(), rotDeg: rotDeg.slice(), R, aim: norm(matVec(R, aimAxis)), t: Date.now(), source, updates: (map.get(id)?.updates || 0) + 1 };
      map.set(id, p);
      return p;
    },
    get: (id) => map.get(id) || null,
    list: () => [...map.values()],
    status: () => [...map.values()].map((p) => ({ id: p.id, pos: p.pos, rotDeg: p.rotDeg, ageMs: Date.now() - p.t, updates: p.updates, source: p.source })),
    delete: (id) => map.delete(id),
  };
}

// Re-place instance k of a resolved scene from its fixture-local geometry: p = R·local + pos.
// Mutates scene.pixels in place (patterns read them live), the instance record, and any
// per-fixture structures riding with it. `resolved` = resolveLayout's instances (local fixtures).
export function createMover({ scene, resolved }) {
  const starts = [];
  let i = 0;
  for (const inst of resolved) { starts.push(i); i += inst.fixture.pixels.length; }
  return {
    place(k, pos, rotDeg) {
      const inst = resolved[k];
      if (!inst) throw new Error(`no instance #${k}`);
      const R = eulerMatrix(rotDeg), base = starts[k], local = inst.fixture.pixels;
      for (let j = 0; j < local.length; j++) {
        const px = scene.pixels[base + j], lp = local[j];
        px.p = add(matVec(R, lp.p), pos);
        px.n = matVec(R, lp.n);
      }
      const rec = scene.meta.instances[k];
      rec.pos = pos.slice(); rec.rotDeg = rotDeg.slice();
      inst.pos = rec.pos; inst.rotDeg = rec.rotDeg;
      for (const st of scene.meta.structures || []) if (st.inst === k && st.parent) st.parent = { pos: rec.pos, rotDeg: rec.rotDeg };
      return { rotInv: transpose3(R), pos: rec.pos };
    },
    count: (k) => resolved[k]?.fixture.pixels.length ?? 0,
  };
}

// A pose message as it travels the bus (and what PSN / the phone are normalized to):
//   { type: "pose", id, pos: [x, y, z], rotDeg: [rx, ry, rz] }      mm, degrees
export function parsePoseMessage(m) {
  if (!m || m.type !== "pose" || typeof m.id !== "string") return null;
  const pos = m.pos, rotDeg = m.rotDeg || [0, 0, 0];
  if (!Array.isArray(pos) || pos.length !== 3 || !pos.every((x) => typeof x === "number" && isFinite(x))) return null;
  if (!Array.isArray(rotDeg) || rotDeg.length !== 3 || !rotDeg.every((x) => typeof x === "number" && isFinite(x))) return null;
  return { id: m.id, pos, rotDeg };
}
