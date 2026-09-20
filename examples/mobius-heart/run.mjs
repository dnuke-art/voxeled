// run.mjs — the full demo. Load a YAML layout (a rig of fixture instances + a show), run it on
// the hub, and fan identical frames to the browser viewer (WebSocket) and optionally to real
// fixtures over Art-Net / DDP. The rig, fixture params, and scenes all live in the layout file —
// and the layout is LIVE: the builder (viewer key E) edits it through GET/POST /layout, and editing
// the file in your editor reloads it; either way the scene rebuilds without a restart.
//
//   node examples/mobius-heart/run.mjs                                    # default two-hearts.yaml
//   VOX_LAYOUT=examples/mobius-heart/layouts/facing-hearts.yaml npm run demo
//   VOX_PATTERN=worldWipe node examples/mobius-heart/run.mjs              # one pattern, no crossfade
//   ARTNET=192.168.1.50 DDP=192.168.1.60 node examples/mobius-heart/run.mjs
import path from "node:path";
import { readFileSync, writeFileSync, watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseYAML } from "../../src/yaml.mjs";
import { stringifyYAML, yamlHeader } from "../../src/yaml-emit.mjs";
import { resolveLayout } from "../../src/layout.mjs";
import { FIXTURES } from "./fixtures.mjs";
import { createBus } from "../../src/bus.mjs";
import { createHub } from "../../src/hub.mjs";
import { createShow } from "../../src/mixer.mjs";
import { PATTERNS } from "../../src/patterns.mjs";
import { createArtNetSender } from "../../src/senders/artnet.mjs";
import { createDDPSender } from "../../src/senders/ddp.mjs";
import { createDispatcher } from "../../src/output/dispatch.mjs";
import { createInputs } from "../../src/input/index.mjs";
import { createPoses, createMover, parsePoseMessage } from "../../src/poses.mjs";
import { createPSNInput, psnToPose } from "../../src/input/psn.mjs";
import { qrEncode, qrToAscii } from "../../src/qr.mjs";
import { structureRoutes } from "../../src/structures.mjs";
import { vantageRoutes } from "../../src/site.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8080);

// Layout: first CLI arg (e.g. `node run.mjs path/to.yaml`), else VOX_LAYOUT, else two-hearts.
const layoutPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : process.env.VOX_LAYOUT
    ? path.resolve(process.env.VOX_LAYOUT)
    : path.join(HERE, "layouts/two-hearts.yaml");
const rel = path.relative(process.cwd(), layoutPath);

// The show's crossfade, or a single pattern override for debugging.
const control = { mode: "auto", fader: 0, a: 0, b: 1 };
const single = process.env.VOX_PATTERN && PATTERNS[process.env.VOX_PATTERN];
if (process.env.VOX_PATTERN && !single) {
  console.error(`unknown pattern "${process.env.VOX_PATTERN}". options: ${Object.keys(PATTERNS).join(", ")}`);
  process.exit(1);
}
// Env shorthands for inputs (the layout's `inputs:` is the full form): TCP colour input (TiXL),
// native DDP Display. They merge like any other input (priority 100, so they win over the show).
const envInputs = [];
if (process.env.VOX_LISTEN) envInputs.push({ name: "tcp", protocol: "tcp", port: +process.env.VOX_LISTEN, priority: 100 });
if (process.env.VOX_DDP_IN) envInputs.push({ name: "ddp", protocol: "ddp", port: +process.env.VOX_DDP_IN, priority: 100 });

// Senders from the environment persist across layout reloads; the patch dispatcher is per scene.
const envSenders = [];
if (process.env.ARTNET) envSenders.push(createArtNetSender({ host: process.env.ARTNET }));
if (process.env.DDP) envSenders.push(createDDPSender({ host: process.env.DDP }));

// ── the live layout: doc → scene + show + hub, rebuilt on every edit ──────────────
const state = { doc: null, header: "", scene: null, show: null, hub: null, dispatcher: null, inputs: null, mover: null, psn: [], lastWritten: null };
const poses = createPoses(); // tracked things (wands, phones, PSN tags) — survives layout reloads
const routes = []; // mutated in place on every apply — the bus reads it per request
const senders = () => (state.dispatcher ? [...envSenders, state.dispatcher] : envSenders);

function build(doc) {
  const { scene, show: showCfg, resolved } = resolveLayout(doc, { fixtures: FIXTURES, patterns: PATTERNS, baseDir: path.dirname(layoutPath) });
  const scenes = showCfg?.scenes?.length ? showCfg.scenes : [{ name: "chase", render: PATTERNS.ribbonChase() }];
  const show = createShow({ scenes, holdS: showCfg?.holdS ?? 4, fadeS: showCfg?.fadeS ?? 2.5, control });
  scene.meta.show = { scenes: show.names, single: !!single };
  return { scene, show, shade: single ? single() : show.shade, resolved };
}

// Apply a layout doc: validate by building it, then swap the running scene/show/patch/routes.
// Throws (and changes nothing) if the layout is invalid.
// The scene rebuilds WITHOUT a hiccup: the hub keeps its clock (patterns and the crossfade
// continue), inputs stay bound and keep their history when their specs didn't change, PSN
// receivers likewise, and tracked instances are re-placed from the poses we already hold.
function apply(doc, { announce = true } = {}) {
  const { scene, show, shade, resolved } = build(doc);
  const t0 = state.hub?.t0 ?? null;
  state.hub?.stop();
  state.dispatcher?.close();
  state.doc = doc; state.scene = scene; state.show = show;
  state.dispatcher = (scene.meta.instances || []).some((i) => i.output?.protocol) ? createDispatcher(scene) : null;
  // Inputs: the layout's `inputs:` + env shorthands, merged per `merge:`.
  const inputSpecs = [...(scene.meta.inputs || []), ...envInputs.filter((e) => !(scene.meta.inputs || []).some((i) => i.name === e.name))];
  const sameInputs = state.inputs && JSON.stringify(state.inputs.specs) === JSON.stringify(inputSpecs) && JSON.stringify(state.inputMerge) === JSON.stringify(scene.meta.merge);
  if (sameInputs) state.inputs.rescene(scene);
  else {
    state.inputs?.close();
    state.inputs = inputSpecs.length ? createInputs({ specs: inputSpecs, merge: scene.meta.merge, scene, bus, onControl: (m) => { for (const k of ["mode", "fader", "a", "b"]) if (m[k] != null) applyControl(k, String(m[k])); } }) : null;
    state.inputMerge = scene.meta.merge;
  }
  scene.meta.inputs = inputSpecs;
  const structRoutes = structureRoutes(scene); // serves the sculpture's CAD; stamps urls (before serializing)
  const vantRoutes = vantageRoutes(scene); // 360° backdrops for the vantages (site context)
  routes.length = 0;
  routes.push(
    { path: "/scene.json", content: JSON.stringify(scene), contentType: "application/json" },
    { path: "/control", handler: controlHandler },
    { path: "/layout", handler: layoutHandler },
    { path: "/instances", handler: instancesHandler },
    { path: "/poses", handler: (req, res) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ trackers: state.scene.meta.trackers || [], poses: poses.status() })); } },
    { path: "/inputs", handler: (req, res) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(state.inputs ? state.inputs.status() : { inputs: [] })); } },
    ...structRoutes,
    ...vantRoutes,
  );
  state.hub = createHub({ scene, shade, fps: 30, bus, senders: senders(), sources: state.inputs?.sources || null, poses, t0 });
  state.hub.start();
  // Moving fixtures: instances with `track:` follow a tracker's pose (src/poses.mjs).
  state.mover = createMover({ scene, resolved });
  const psnSpecs = (scene.meta.trackers || []).filter((t) => t.source === "psn");
  const samePsn = JSON.stringify(psnSpecs) === JSON.stringify(state.psnSpecs || null);
  if (!samePsn) { for (const h of state.psn) h.close(); state.psn = []; state.psnSpecs = psnSpecs; }
  for (const tr of scene.meta.trackers || []) {
    if (poses.get(tr.name)) applyPose(poses.get(tr.name)); // a tracker we already know about: place its instances now
    if (tr.source === "psn" && !samePsn) {
      const h = createPSNInput({ port: tr.port, group: tr.group, onTrackers: (trackers, names) => {
        for (const t of Object.values(trackers)) {
          const match = tr.id == null ? true : (String(t.id) === String(tr.id) || names[t.id] === tr.id);
          if (!match) continue;
          const pose = psnToPose(t, { scaleToMM: tr.scaleToMM, up: tr.up });
          if (pose) onPose(tr.name, pose, "psn");
          if (tr.id == null) break; // no id given: the first tracker in the packet is ours
        }
      } });
      h.sock.on("error", (e) => console.error(`✗ tracker ${tr.name}: ${e.message}`));
      state.psn.push(h);
    }
  }
  if (announce) bus.broadcastText({ type: "scene", count: scene.count, instances: scene.meta.instances.length });
  for (const [id, j] of joined) welcome(id, j.socket); // joined devices learn their (possibly shifted) pixel index
}

// ── join: devices that announce themselves while the show runs ──────────────────────────
// {type:"hello", id, fixture:{type,params} | fixtureName, output?, pos?, rotDeg?, track?, ttlS?}
// on the bus (or POST /instances) appends an instance — geometry, patch, and a tracker if it
// moves — with every existing pixel index untouched and the show clock continuous. The device
// gets {type:"welcome", id, index, count}: a phone that joined as a `dot` reads its own colour
// from the bus frames at that index. {type:"bye"} (or silence past ttlS) removes it again.
const joined = new Map(); // id → { socket, ttlS, lastSeen, inline }
function firstPixelOf(k) { let i = 0; for (let j = 0; j < k; j++) i += state.mover.count(j); return i; }
function welcome(id, socket) {
  const k = state.scene.meta.instances.findIndex((i) => i.name === id);
  if (k < 0 || !socket) return;
  bus.sendText(socket, { type: "welcome", id, instance: k, index: firstPixelOf(k), count: state.mover.count(k), total: state.scene.count, trackers: state.scene.meta.trackers || [] });
}
function addInstance(h, socket = null) {
  const jp = state.scene.meta.join;
  if (!jp?.enabled) throw new Error("this layout does not accept joins (join: false)");
  if (!h.id || typeof h.id !== "string" || !/^[\w.-]{1,40}$/.test(h.id)) throw new Error("hello needs an id (letters, digits, - _ .)");
  const doc = state.doc;
  doc.instances ||= []; doc.fixtures ||= {}; doc.trackers ||= [];
  const existing = doc.instances.findIndex((i) => i.name === h.id);
  if (existing < 0 && joined.size >= jp.max) throw new Error(`join limit reached (${jp.max})`);
  let fixtureName = h.fixtureName || null, inline = false;
  if (h.fixture && typeof h.fixture === "object") { fixtureName = `joined-${h.id}`; doc.fixtures[fixtureName] = { type: h.fixture.type, ...(h.fixture.params ? { params: h.fixture.params } : {}), ...(h.output ? { output: h.output } : {}) }; inline = true; }
  else if (!fixtureName) { fixtureName = doc.fixtures[jp.fixture] ? jp.fixture : `joined-${h.id}`; if (!doc.fixtures[fixtureName]) { doc.fixtures[fixtureName] = { type: jp.fixture }; inline = true; } }
  if (!doc.fixtures[fixtureName]) throw new Error(`unknown fixture "${fixtureName}"`);
  const track = h.track === true ? h.id : typeof h.track === "string" ? h.track : null;
  if (track && !doc.trackers.some((t) => t.name === track)) doc.trackers.push({ name: track, source: "ws", heightMM: jp.heightMM });
  const inst = { fixture: fixtureName, name: h.id, pos: h.pos || [0, jp.heightMM, 0], rotDeg: h.rotDeg || [0, 0, 0], ...(track ? { track } : {}), ...(h.output && !inline ? { output: h.output } : {}) };
  if (existing >= 0) doc.instances[existing] = inst; else doc.instances.push(inst);
  const prev = joined.get(h.id);
  joined.set(h.id, { socket: socket || prev?.socket || null, ttlS: h.ttlS ?? jp.ttlS, lastSeen: Date.now(), inline, fixtureName, track });
  try { apply(doc); } catch (e) { joined.delete(h.id); if (existing < 0) doc.instances.pop(); if (inline) delete doc.fixtures[fixtureName]; throw e; }
  if (h.pos || h.rotDeg) { if (track) onPose(track, { pos: inst.pos, rotDeg: inst.rotDeg }, "hello"); }
  const k = state.scene.meta.instances.findIndex((i) => i.name === h.id);
  console.log(`  join:    ${h.id} (${fixtureName}, ${state.mover.count(k)} px${track ? ", tracked" : ""}) — ${state.scene.count.toLocaleString()} px now`);
  return { instance: k, index: firstPixelOf(k), count: state.mover.count(k), total: state.scene.count };
}
function removeInstance(id, why = "bye") {
  const j = joined.get(id), doc = state.doc;
  const k = (doc.instances || []).findIndex((i) => i.name === id);
  if (k < 0) return false;
  doc.instances.splice(k, 1);
  if (j?.inline) delete doc.fixtures[j.fixtureName];
  if (j?.track && !doc.instances.some((i) => i.track === j.track)) { doc.trackers = (doc.trackers || []).filter((t) => t.name !== j.track); poses.delete(j.track); }
  joined.delete(id);
  apply(doc);
  console.log(`  leave:   ${id} (${why}) — ${state.scene.count.toLocaleString()} px now`);
  return true;
}
setInterval(() => { const now = Date.now(); for (const [id, j] of joined) if (j.ttlS > 0 && now - j.lastSeen > j.ttlS * 1000) { try { removeInstance(id, `silent ${j.ttlS} s`); } catch (e) { console.warn(`leave ${id}: ${e.message}`); } } }, 2000);
function handleJoinText(text, socket) {
  let m; try { m = JSON.parse(text); } catch { return false; }
  if (!m || typeof m !== "object") return false;
  if (m.type === "hello") { try { addInstance(m, socket); welcome(m.id, socket); } catch (e) { bus.sendText(socket, { type: "error", of: "hello", error: e.message }); console.warn(`join ${m.id}: ${e.message}`); } return true; }
  if (m.type === "bye") { try { removeInstance(m.id, "bye"); } catch (e) { console.warn(`leave ${m.id}: ${e.message}`); } return true; }
  if (m.type === "heartbeat" && joined.has(m.id)) { joined.get(m.id).lastSeen = Date.now(); return true; }
  return false;
}
function instancesHandler(req, res, params) {
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
  if (req.method === "GET") return json(200, { instances: state.scene.meta.instances.map((i, k) => ({ ...i, index: firstPixelOf(k), count: state.mover.count(k), joined: joined.has(i.name) })), join: state.scene.meta.join });
  if (req.method === "DELETE") { const name = params.get("name"); try { return json(removeInstance(name, "http") ? 200 : 404, { ok: true, name }); } catch (e) { return json(400, { error: e.message }); } }
  if (req.method !== "POST") return json(405, { error: "GET, POST or DELETE" });
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    let h; try { h = JSON.parse(body || "{}"); } catch { return json(400, { error: "body must be JSON" }); }
    try {
      const r = addInstance(h);
      if (params.get("save") === "1") { writeFileSync(layoutPath, stringifyYAML(state.doc, { header: state.header })); state.lastWritten = readFileSync(layoutPath, "utf8"); }
      json(200, { ok: true, ...r, saved: params.get("save") === "1" });
    } catch (e) { json(400, { error: e.message }); }
  });
}

// Control endpoint: the viewer's / phone's crossfader + auto toggle drive `control`.
// A pose arrived for tracker `id`: record it, move every instance tracking it, tell the viewers.
const poseSent = new Map(); // id → last broadcast time (≤ 30 Hz per tracker on the bus)
function onPose(id, { pos, rotDeg }, source = "ws") {
  const tr = (state.scene?.meta.trackers || []).find((t) => t.name === id);
  if (joined.has(id)) joined.get(id).lastSeen = Date.now(); // a joined device's poses keep it alive
  const p = poses.set(id, { pos, rotDeg, aimAxis: tr?.aim, source });
  applyPose(p);
}
function applyPose(p) {
  const moved = [];
  (state.scene?.meta.instances || []).forEach((it, k) => { if (it.track === p.id) { state.mover.place(k, p.pos, p.rotDeg); state.hub.reposition(k); moved.push(k); } });
  const now = Date.now();
  if (now - (poseSent.get(p.id) || 0) >= 33) { poseSent.set(p.id, now); bus.broadcastText({ type: "pose", id: p.id, pos: p.pos, rotDeg: p.rotDeg, instances: moved }); }
}
function handlePoseText(text) {
  let m; try { m = JSON.parse(text); } catch { return false; }
  const pose = parsePoseMessage(m);
  if (!pose) return false;
  try { onPose(pose.id, pose, "ws"); } catch (e) { console.warn(`pose ${pose.id}: ${e.message}`); }
  return true;
}
function applyControl(k, v) {
  if (k === "mode") control.mode = v === "manual" ? "manual" : "auto";
  else if (k === "fader") control.fader = Math.max(0, Math.min(1, +v));
  else if (k === "a") control.a = +v;
  else if (k === "b") control.b = +v;
}
function controlHandler(req, res, params) {
  for (const k of ["mode", "fader", "a", "b"]) if (params.has(k)) applyControl(k, params.get(k));
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(control));
}

// Builder endpoint. GET → the layout doc (+ what fixtures/patterns exist, and the expanded
// instances with their `src`). POST a doc → applied live; `?write=1` also saves it to the file.
function layoutHandler(req, res, params) {
  const json = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.method === "GET") {
    return json(200, {
      path: layoutPath, doc: state.doc, fixtures: Object.keys(FIXTURES), patterns: Object.keys(PATTERNS),
      instances: state.scene.meta.instances.map((i) => ({ name: i.name, fixture: i.fixture, pos: i.pos, rotDeg: i.rotDeg, src: i.src })),
    });
  }
  if (req.method !== "POST") return json(405, { error: "GET or POST" });
  let body = "";
  req.on("data", (d) => { body += d; if (body.length > 8e6) req.destroy(); });
  req.on("end", () => {
    let doc;
    try { doc = JSON.parse(body); } catch { return json(400, { error: "body must be a JSON layout doc" }); }
    try { apply(doc); } catch (e) { return json(400, { error: e.message }); }
    let written = false;
    if (params.get("write") === "1") {
      const text = stringifyYAML(doc, { header: state.header });
      state.lastWritten = text;
      writeFileSync(layoutPath, text);
      written = true;
      console.log(`  layout:  saved ${rel} — ${state.scene.meta.instances.length} instance(s), ${state.scene.count.toLocaleString()} px`);
    }
    json(200, { ok: true, written, count: state.scene.count, instances: state.scene.meta.instances.length });
  });
}

// ── boot ─────────────────────────────────────────────────────────────────────────
const bus = createBus({ port: PORT, staticDir: path.join(HERE, "../../viewer"), routes, onMessage: (m) => { if (m.text && (handleJoinText(m.text, m.socket) || handlePoseText(m.text))) return; state.inputs?.onMessage(m); } }); // pages push frames, poses and control in through the same socket
bus.server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { console.error(`\n✗ port ${PORT} is already in use — another demo is likely running. Stop it, or run with PORT=<n>.`); process.exit(1); }
  throw e;
});

try {
  const text = readFileSync(layoutPath, "utf8");
  state.header = yamlHeader(text);
  apply(parseYAML(text), { announce: false });
} catch (e) {
  console.error(`layout error in ${rel}:\n  ${e.message}`);
  process.exit(1);
}

// Edit the file in your editor → the scene reloads (the file's directory is watched, so editors
// that save by rename still trigger). Our own saves are recognised and skipped.
let watchTimer = null;
try {
  watch(path.dirname(layoutPath), (_ev, fn) => {
    if (fn !== path.basename(layoutPath)) return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      let text;
      try { text = readFileSync(layoutPath, "utf8"); } catch { return; }
      if (text === state.lastWritten) return;
      try {
        state.header = yamlHeader(text);
        apply(parseYAML(text));
        console.log(`  layout:  reloaded ${rel} — ${state.scene.meta.instances.length} instance(s), ${state.scene.count.toLocaleString()} px`);
      } catch (e) { console.error(`  layout:  ✗ ${e.message}  (kept the previous scene)`); }
    }, 250);
  });
} catch { /* watching is best-effort */ }

const { scene, show } = state;
console.log(`♥ voxeled — Möbius LED Heart demo`);
console.log(`  layout:  ${rel} — "${scene.name}"  (live: edit the file, or build in the viewer with E)`);
console.log(`  rig:     ${scene.meta.instances.length} instance(s) · ${scene.count.toLocaleString()} px`);
console.log(single ? `  pattern: ${process.env.VOX_PATTERN} (single)` : `  show:    ${show.names.join("  →  ")}  (auto-crossfade)`);
const outDesc = senders().length
  ? senders().map((s) => (s.kind === "dispatch" ? `patch[${s.summary.join(", ")}]` : `${s.kind}→${s.target}`)).join("  ")
  : "none (set ARTNET=host / DDP=host, or add per-fixture `output` in the layout)";
console.log(`  output:  ${outDesc}`);
if (scene.meta.join?.enabled) console.log(`  join:    open — phones (scan the QR → join) and wands announce themselves and are added live (${scene.meta.join.fixture}, ttl ${scene.meta.join.ttlS} s, max ${scene.meta.join.max})`);
if (scene.meta.trackers?.length) console.log(`  track:   ${scene.meta.trackers.map((t) => `${t.name} (${t.source}${t.source === "psn" ? ` ${t.group}:${t.port}` : ""}) → ${scene.meta.instances.filter((i) => i.track === t.name).map((i) => i.name).join(", ") || "patterns only"}`).join("  ·  ")}`);
if (state.inputs) {
  const m = state.inputs.sources;
  console.log(`  inputs:  ${state.inputs.list.map((i) => `${i.name} (${i.protocol}${i.port ? " " + i.port : ""}, prio ${i.priority}${i.universes ? `, ${i.universes} universes` : ""}${i.covered < scene.count ? `, ${i.covered} px` : ""})`).join("  ·  ")}`);
  console.log(`           merge: ${m.mode} · fallback ${m.fallback} — the internal show runs wherever no input is live`);
}
console.log(`  viewer:  ${bus.url}`);
// Public interaction, LAN edition: a phone on the same Wi-Fi scans this and gets the scene
// picker + crossfader (viewer/phone.html on the hub's /control seam). Hosted is the same seam.
if (bus.lanUrl && !process.env.VOX_NO_QR) {
  console.log(`  phone:   ${bus.lanUrl}phone.html   (scan to control the piece)`);
  console.log(qrToAscii(qrEncode(`${bus.lanUrl}phone.html`)).replace(/^/gm, "     "));
}

process.on("SIGINT", () => {
  state.hub?.stop();
  state.inputs?.close();
  for (const h of state.psn) h.close();
  bus.close();
  for (const s of senders()) s.close();
  console.log("\nbye");
  process.exit(0);
});
