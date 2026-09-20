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
function apply(doc, { announce = true } = {}) {
  const { scene, show, shade, resolved } = build(doc);
  state.hub?.stop();
  state.dispatcher?.close();
  state.inputs?.close();
  for (const h of state.psn) h.close();
  state.psn = [];
  state.doc = doc; state.scene = scene; state.show = show;
  state.dispatcher = (scene.meta.instances || []).some((i) => i.output?.protocol) ? createDispatcher(scene) : null;
  // Inputs: the layout's `inputs:` + env shorthands, merged per `merge:` (rebound on every reload).
  const inputSpecs = [...(scene.meta.inputs || []), ...envInputs.filter((e) => !(scene.meta.inputs || []).some((i) => i.name === e.name))];
  state.inputs = inputSpecs.length ? createInputs({ specs: inputSpecs, merge: scene.meta.merge, scene, bus, onControl: (m) => { for (const k of ["mode", "fader", "a", "b"]) if (m[k] != null) applyControl(k, String(m[k])); } }) : null;
  scene.meta.inputs = inputSpecs;
  const structRoutes = structureRoutes(scene); // serves the sculpture's CAD; stamps urls (before serializing)
  const vantRoutes = vantageRoutes(scene); // 360° backdrops for the vantages (site context)
  routes.length = 0;
  routes.push(
    { path: "/scene.json", content: JSON.stringify(scene), contentType: "application/json" },
    { path: "/control", handler: controlHandler },
    { path: "/layout", handler: layoutHandler },
    { path: "/poses", handler: (req, res) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify({ trackers: state.scene.meta.trackers || [], poses: poses.status() })); } },
    { path: "/inputs", handler: (req, res) => { res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(state.inputs ? state.inputs.status() : { inputs: [] })); } },
    ...structRoutes,
    ...vantRoutes,
  );
  state.hub = createHub({ scene, shade, fps: 30, bus, senders: senders(), sources: state.inputs?.sources || null, poses });
  state.hub.start();
  // Moving fixtures: instances with `track:` follow a tracker's pose (src/poses.mjs).
  state.mover = createMover({ scene, resolved });
  for (const tr of scene.meta.trackers || []) {
    if (poses.get(tr.name)) applyPose(poses.get(tr.name)); // a tracker we already know about: place its instances now
    if (tr.source === "psn") {
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
}

// Control endpoint: the viewer's / phone's crossfader + auto toggle drive `control`.
// A pose arrived for tracker `id`: record it, move every instance tracking it, tell the viewers.
const poseSent = new Map(); // id → last broadcast time (≤ 30 Hz per tracker on the bus)
function onPose(id, { pos, rotDeg }, source = "ws") {
  const tr = (state.scene?.meta.trackers || []).find((t) => t.name === id);
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
const bus = createBus({ port: PORT, staticDir: path.join(HERE, "../../viewer"), routes, onMessage: (m) => { if (m.text && handlePoseText(m.text)) return; state.inputs?.onMessage(m); } }); // pages push frames, poses and control in through the same socket
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
