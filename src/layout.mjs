// Layout (a "rig") — place INSTANCES of fixtures in shared world space.
//
// A fixture is geometry authored once in its own local frame (e.g. one heart). An instance is
// that fixture placed by a world transform (translation in mm + Euler rotation in degrees). This
// is voxeled's version of MVR's model: fixtures + placements. Because instances live in one
// shared world space, a world-space pattern automatically accounts for the real distance between
// them — 2 hearts 10 ft apart really are 10 ft apart to the pattern.
import { add, matVec, eulerMatrix } from "./vec.mjs";
import { buildScene } from "./format.mjs";
import { resolveStructure } from "./structures.mjs";
import { loadPaths, resolvePath, samplePath } from "./paths.mjs";
import { resolveSite, resolveVantages } from "./site.mjs";

// instances: [{ name, fixtureName, fixture:{pixels,meta}, pos:[x,y,z]mm, rotDeg:[rx,ry,rz] }]
// Each instance carries its OWN resolved fixture, so a rig can mix different fixtures.
export function buildSceneFromLayout({ name, units = "mm", instances, meta = {} }) {
  const pixels = [];
  let i = 0;
  instances.forEach((inst, k) => {
    const rot = eulerMatrix(inst.rotDeg || [0, 0, 0]);
    const pos = inst.pos || [0, 0, 0];
    for (const lp of inst.fixture.pixels) {
      const p = add(matVec(rot, lp.p), pos); // world position
      const n = matVec(rot, lp.n); // rotate the emission normal (translation doesn't affect it)
      pixels.push({
        i: i++,
        inst: k, // which instance — lets fixture-space patterns re-base to local coords
        p: p.map((x) => +x.toFixed(2)),
        n: n.map((x) => +x.toFixed(4)),
        s: lp.s,
        v: lp.v,
        ...(lp.strand != null ? { strand: lp.strand } : {}), // keep the run id (ropes, importers) through the flatten
      });
    }
  });

  // Real pixel pitch (mm) so the viewer can size LEDs by spacing, not by rig extent.
  const pitches = instances.map((inst) => inst.fixture.meta?.pitchMM).filter((p) => p > 0);

  return buildScene({
    name,
    units,
    pixels,
    meta: {
      ...meta,
      pitchMM: pitches.length ? Math.min(...pitches) : undefined,
      instances: instances.map((inst) => ({
        name: inst.name,
        fixture: inst.fixtureName,
        pos: inst.pos || [0, 0, 0],
        rotDeg: inst.rotDeg || [0, 0, 0],
        ...(inst.output ? { output: inst.output } : {}),
        ...(inst.emitter ? { emitter: inst.emitter } : {}), // how this instance's LEDs emit (sim)
        ...(inst.src ? { src: inst.src } : {}),
        ...(inst.track ? { track: inst.track } : {}), // a live pose drives this instance's transform
      })),
    },
  });
}

// Placement generators — one layout entry can stand for many instances:
//   array: { count: [nx, ny, nz], spacing: [sx, sy, sz], center: false }   a matrix in the entry's frame
//   ring:  { count, radiusMM, startDeg: 0, facing: center|out|tangent|none } a circle around the entry's pos (Y up)
// `each: { … }` applies per generated instance (e.g. a rotDeg). Every expanded instance carries
// `src: { i, k }` — the layout entry index and element index — so the builder can edit the source.
//   along: { path: name|[[x,y,z]…], count, orient: tangent|none, startMM, endMM } instances spaced along a path
export function expandInstances(list, { paths = {} } = {}) {
  const out = [];
  list.forEach((inst, i) => {
    const base = inst.pos || [0, 0, 0], rotDeg = inst.rotDeg || [0, 0, 0], R = eulerMatrix(rotDeg);
    const stem = inst.name || inst.fixture;
    const { array, ring, along, each, ...rest } = inst;
    if (along) {
      const P = resolvePath(along.path, paths);
      const samples = samplePath(P, { count: along.count, spacingMM: along.spacingMM, startMM: along.startMM, endMM: along.endMM });
      samples.forEach((sm, k) => {
        // orient: the instance's +Z follows the tangent (yaw about Y, pitch about X)
        const T = sm.t;
        const rot = (along.orient || "tangent") === "tangent" ? [(-Math.asin(Math.max(-1, Math.min(1, T[1]))) * 180) / Math.PI, (Math.atan2(T[0], T[2]) * 180) / Math.PI, rotDeg[2]] : rotDeg;
        out.push({ ...rest, ...(each || {}), name: `${stem}-${k}`, pos: add(base, matVec(R, sm.p)), rotDeg: each?.rotDeg || rot.map((x) => +x.toFixed(3)), src: { i, k } });
      });
      return;
    }
    if (array) {
      const [nx = 1, ny = 1, nz = 1] = array.count || [1, 1, 1];
      const [sx = 0, sy = 0, sz = 0] = array.spacing || [0, 0, 0];
      const off = array.center ? [((nx - 1) * sx) / 2, ((ny - 1) * sy) / 2, ((nz - 1) * sz) / 2] : [0, 0, 0];
      let k = 0;
      for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, k++) {
        const local = [x * sx - off[0], y * sy - off[1], z * sz - off[2]];
        out.push({ ...rest, ...(each || {}), name: `${stem}-${x}-${y}${nz > 1 ? `-${z}` : ""}`, pos: add(base, matVec(R, local)), rotDeg: each?.rotDeg || rotDeg, src: { i, k } });
      }
    } else if (ring) {
      const n = Math.max(1, ring.count | 0), r = ring.radiusMM || 0, start = ring.startDeg || 0, facing = ring.facing || "center";
      for (let k = 0; k < n; k++) {
        const a = start + (360 * k) / n, rad = (a * Math.PI) / 180;
        const local = [r * Math.sin(rad), 0, r * Math.cos(rad)];
        const yaw = facing === "center" ? a + 180 : facing === "out" ? a : facing === "tangent" ? a + 90 : rotDeg[1];
        out.push({ ...rest, ...(each || {}), name: `${stem}-${k}`, pos: add(base, matVec(R, local)), rotDeg: [rotDeg[0], yaw, rotDeg[2]], src: { i, k } });
      }
    } else out.push({ ...inst, src: { i } });
  });
  return out;
}

// Turn a parsed YAML layout doc into a { scene, show } using registries:
//   fixtures: { [type]: (params) => ({ pixels, meta }) }   — how to build each fixture's geometry
//   patterns: { [name]: (params) => (px,t,ctx) => [r,g,b] } — for the optional `show:` block
//
// Layout doc shape:
//   name, units
//   fixtures: { <fixtureName>: { type, params } }
//   instances: [ { fixture: <fixtureName>, name, pos:[x,y,z], rotDeg:[rx,ry,rz] } ]
//   show: { holdS, fadeS, scenes: [ { name, pattern, params } ] }   (optional)
export function resolveLayout(doc, { fixtures = {}, patterns = {}, baseDir = null } = {}) {
  const fixDefs = doc.fixtures || {};
  // Named paths (`paths:` — inline points or JSON files such as thread-3d's tubes.json), available
  // to `rope` fixtures (params.path: name) and `along:` generators.
  const paths = loadPaths(doc.paths, { baseDir });
  const cache = {};
  const getFixture = (fixtureName) => {
    if (cache[fixtureName]) return cache[fixtureName];
    const def = fixDefs[fixtureName];
    if (!def) throw new Error(`layout references undefined fixture "${fixtureName}"`);
    const make = fixtures[def.type];
    if (!make) throw new Error(`unknown fixture type "${def.type}" (registered: ${Object.keys(fixtures).join(", ") || "none"})`);
    return (cache[fixtureName] = make({ ...(def.params || {}), paths, baseDir })); // file params resolve relative to the layout
  };

  const instances = expandInstances(doc.instances || [], { paths }).map((inst, k) => {
    if (!inst.fixture) throw new Error(`instance #${k} is missing a "fixture"`);
    const def = fixDefs[inst.fixture] || {};
    // The output patch merges the fixture-level default with per-instance overrides.
    const output = def.output || inst.output ? { ...(def.output || {}), ...(inst.output || {}) } : undefined;
    const fixture = getFixture(inst.fixture);
    // Emitter profile: fixture-type default (built into the geometry) < layout `fixtures.X.emitter`
    // < per-instance `emitter` override.
    const emitterSrc = [fixture.meta?.emitter, def.emitter, inst.emitter].filter(Boolean);
    const emitter = emitterSrc.length ? Object.assign({}, ...emitterSrc) : undefined;
    return {
      name: inst.name || `${inst.fixture}-${k + 1}`,
      track: inst.track,
      fixtureName: inst.fixture,
      fixture,
      pos: inst.pos,
      rotDeg: inst.rotDeg,
      output,
      emitter,
      src: inst.src, // which layout entry (and which generated element) this came from — for the builder
    };
  });
  if (!instances.length) throw new Error("layout has no instances");

  // Structures (the sculpture's own CAD): per-fixture ones ride along with every instance
  // (parent = the instance transform); scene-level ones sit once in world space.
  const structures = [];
  instances.forEach((inst, k) => {
    // from the layout's fixture definition, plus any the fixture itself brought (a baked .vxl scene)
    for (const s of [...(fixDefs[inst.fixtureName]?.structures || []), ...(inst.fixture.meta?.structures || [])])
      structures.push({ ...resolveStructure(s, { baseDir }, { pos: inst.pos || [0, 0, 0], rotDeg: inst.rotDeg || [0, 0, 0] }, `${inst.name}:${s.name || String(s.file).replace(/^.*[\\/]/, "")}`), inst: k });
  });
  for (const s of doc.structures || []) structures.push(resolveStructure(s, { baseDir }));

  // Site context: the geo-anchor and the places a viewer can stand (360° backdrops) — src/site.mjs.
  const site = resolveSite(doc.site);
  const vantages = resolveVantages(doc.vantages, { baseDir, site });
  // Inputs: external streams that drive the piece, merged by priority/htp/ltp (src/input/index.mjs).
  const inputs = resolveInputs(doc.inputs);
  // Trackers: where things are (src/poses.mjs). An instance with `track:` follows one.
  const trackers = resolveTrackers(doc.trackers);
  // Join: may devices (wands, phones) announce themselves and be added while the show runs?
  const join = doc.join === false ? { enabled: false } : { enabled: true, fixture: doc.join?.fixture || "dot", ttlS: doc.join?.ttlS ?? 30, heightMM: doc.join?.heightMM ?? 1200, max: doc.join?.max ?? 64 };
  for (const inst of instances) if (inst.track && !trackers.some((t) => t.name === inst.track)) throw new Error(`instance "${inst.name}" tracks "${inst.track}" but there is no such tracker (trackers: ${trackers.map((t) => t.name).join(", ") || "none"})`);
  const merge = doc.merge ? { mode: doc.merge.mode || "priority", fallback: doc.merge.fallback || "show", timeoutMs: doc.merge.timeoutMs ?? 1000 } : undefined;

  const scene = buildSceneFromLayout({
    name: doc.name || "layout",
    units: doc.units || "mm",
    instances,
    meta: {
      fixtureTypes: Object.fromEntries(Object.entries(fixDefs).map(([k, v]) => [k, v.type])),
      ...(structures.length ? { structures } : {}),
      ...(site ? { site } : {}),
      ...(vantages.length ? { vantages } : {}),
      ...(inputs.length ? { inputs } : {}),
      ...(trackers.length ? { trackers } : {}),
      join,
      ...(merge ? { merge } : {}),
    },
  });

  let show = null;
  if (doc.show) {
    const scenes = (doc.show.scenes || []).map((sc, k) => {
      const make = patterns[sc.pattern];
      if (!make) throw new Error(`scene #${k} uses unknown pattern "${sc.pattern}" (have: ${Object.keys(patterns).join(", ")})`);
      return { name: sc.name || sc.pattern, render: make(sc.params || {}) };
    });
    show = { scenes, holdS: doc.show.holdS ?? 4, fadeS: doc.show.fadeS ?? 2.5 };
  }

  return { scene, show, resolved: instances };
}

export const INPUT_PROTOCOLS = { artnet: 6454, sacn: 5568, ddp: 4048, tcp: 9600, ws: null };
export function resolveInputs(list) {
  const seen = new Set();
  return (list || []).map((inp, i) => {
    const protocol = inp.protocol;
    if (!(protocol in INPUT_PROTOCOLS)) throw new Error(`input #${i}: protocol must be one of ${Object.keys(INPUT_PROTOCOLS).join(", ")} (got "${protocol}")`);
    const name = inp.name || protocol;
    if (seen.has(name)) throw new Error(`duplicate input name "${name}"`);
    seen.add(name);
    const out = { name, protocol, priority: inp.priority ?? 0, ...(inp.timeoutMs != null ? { timeoutMs: inp.timeoutMs } : {}) };
    if (protocol !== "ws") out.port = inp.port || INPUT_PROTOCOLS[protocol];
    if (inp.host) out.host = inp.host;
    if (protocol === "artnet" || protocol === "sacn" || protocol === "ws") out.map = inp.map || {};
    if (protocol === "sacn" && inp.universes) out.universes = inp.universes;
    return out;
  });
}

export const TRACKER_SOURCES = ["ws", "phone", "psn"];
export function resolveTrackers(list) {
  const seen = new Set();
  return (list || []).map((t, i) => {
    const source = t.source || "ws";
    if (!TRACKER_SOURCES.includes(source)) throw new Error(`tracker #${i}: source must be one of ${TRACKER_SOURCES.join(", ")} (got "${source}")`);
    const name = t.name || `${source}-${i}`;
    if (seen.has(name)) throw new Error(`duplicate tracker name "${name}"`);
    seen.add(name);
    const out = { name, source, aim: t.aim || [0, 1, 0], heightMM: t.heightMM ?? 1200 };
    if (source === "psn") { out.port = t.port || 56565; out.group = t.group ?? "236.10.10.10"; out.id = t.id ?? null; out.scaleToMM = t.scaleToMM ?? 1000; out.up = t.up || "y"; }
    return out;
  });
}

