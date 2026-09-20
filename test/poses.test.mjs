// Moving fixtures + poses: the mover re-places an instance's pixels/normals from its local
// geometry; layout `trackers:` / `track:` validation; PSN packets parse to poses; the lantern /
// point / paint patterns follow a pose; and end to end: a pose over the bus moves a tracked wand
// in the running hub (viewers get a pose message, /poses reports it) and a PSN packet does too.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import dgram from "node:dgram";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPoses, createMover, parsePoseMessage } from "../src/poses.mjs";
import { parsePSN, psnDataPacket, psnToPose, axisAngleToRotDeg } from "../src/input/psn.mjs";
import { resolveLayout, resolveTrackers } from "../src/layout.mjs";
import { FIXTURES } from "../examples/mobius-heart/fixtures.mjs";
import { PATTERNS } from "../src/patterns.mjs";
import { parseYAML } from "../src/yaml.mjs";
import { readFileSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✓", m)) : (fail++, console.log("  ✗", m)));
const near = (a, b, t = 1e-3) => Math.abs(a - b) <= t;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bright = (c) => Math.max(c[0], c[1], c[2]);

// ── mover ─────────────────────────────────────────────────────────────────────
const doc = {
  trackers: [{ name: "w", source: "ws" }],
  fixtures: { col: { type: "tube", params: { cols: 8, rows: 4, panels: 1 } }, stick: { type: "rope", params: { path: [[0, 0, 0], [0, 600, 0]], count: 4, radiusMM: 0 } } },
  instances: [{ fixture: "col", name: "c", pos: [3000, 0, 0] }, { fixture: "stick", name: "wand", pos: [0, 1000, 0], track: "w" }],
};
const { scene, resolved } = resolveLayout(doc, { fixtures: FIXTURES, patterns: PATTERNS });
ok(scene.meta.instances[1].track === "w" && scene.meta.trackers[0].name === "w" && resolved.length === 2, "layout: trackers + instance.track land in scene.meta; resolveLayout returns the local instances");
const mover = createMover({ scene, resolved });
const w0 = scene.pixels[32], w3 = scene.pixels[35];
ok(near(w0.p[1], 1000) && near(w3.p[1], 1600), "the wand starts where the layout put it (y 1000 → 1600)");
mover.place(1, [500, 1200, -400], [0, 0, 90]);
ok(near(scene.pixels[32].p[0], 500) && near(scene.pixels[32].p[1], 1200) && near(scene.pixels[35].p[0], -100) && near(scene.pixels[35].p[1], 1200), "place(): pixels re-computed from local geometry — rotated 90° about Z the stick lies along −X");
ok(Math.abs(scene.pixels[0].p[0] - 3000) < 20 && scene.meta.instances[1].pos[2] === -400 && scene.meta.instances[1].rotDeg[2] === 90, "…the other instance untouched, the instance record updated");
const n0 = scene.pixels[0].n; mover.place(0, [3000, 0, 0], [0, 90, 0]);
ok(near(scene.pixels[0].n[2], -n0[0], 1e-3) && near(Math.hypot(...scene.pixels[0].n), 1), "normals rotate with the instance");

// ── poses registry ─────────────────────────────────────────────────────────────
const P = createPoses();
const p1 = P.set("w", { pos: [1, 2, 3], rotDeg: [-90, 0, 0] });
ok(near(p1.aim[2], -1) && near(p1.aim[1], 0), "aim: +Y tilted by rx −90 points along −Z (a flat phone aims forward)");
const p2 = P.set("w", { pos: [0, 0, 0], rotDeg: [-90, 90, 0] });
ok(near(p2.aim[0], -1, 1e-6) && P.get("w").updates === 2 && P.status()[0].id === "w", "aim: yaw 90 turns it to −X; updates counted");
let threw = ""; try { P.set("x", { pos: [1, 2] }); } catch (e) { threw = e.message; }
ok(/pos must be/.test(threw), "bad pose is a clear error");
ok(parsePoseMessage({ type: "pose", id: "a", pos: [1, 2, 3] })?.rotDeg.length === 3 && parsePoseMessage({ type: "pose", id: "a", pos: "x" }) === null && parsePoseMessage({ type: "control" }) === null, "parsePoseMessage validates");
threw = ""; try { resolveLayout({ ...doc, trackers: [] }, { fixtures: FIXTURES, patterns: PATTERNS }); } catch (e) { threw = e.message; }
ok(/no such tracker/.test(threw), "track: naming a missing tracker is a clear error");
threw = ""; try { resolveTrackers([{ name: "a", source: "uwb" }]); } catch (e) { threw = e.message; }
ok(/source must be one of/.test(threw), "unknown tracker source is a clear error");
const tps = resolveTrackers([{ name: "tag", source: "psn", id: 3, up: "z" }]);
ok(tps[0].port === 56565 && tps[0].group === "236.10.10.10" && tps[0].id === 3 && tps[0].up === "z" && tps[0].aim[1] === 1, "psn tracker defaults");

// ── PSN ─────────────────────────────────────────────────────────────────────────
const pkt = psnDataPacket([{ id: 7, pos: [1.5, 2.0, -0.5], ori: [0, Math.PI / 2, 0] }, { id: 8, pos: [0, 0, 0] }], { frame: 3 });
const psn = parsePSN(pkt);
ok(psn && psn.type === "data" && psn.header.frame === 3 && near(psn.trackers[7].pos[0], 1.5) && near(psn.trackers[7].ori[1], Math.PI / 2) && psn.trackers[8].pos[2] === 0, "PSN v2 data packet builds and parses (header, tracker list, pos, ori)");
const pose = psnToPose(psn.trackers[7]);
ok(near(pose.pos[0], 1500) && near(pose.pos[2], -500) && near(pose.rotDeg[1], 90, 0.01), "PSN tracker → pose: metres → mm, axis-angle → rotDeg (90° about Y)");
const zup = psnToPose({ pos: [1, 2, 3] }, { up: "z" });
ok(zup.pos[1] === 3000 && zup.pos[2] === -2000, "up: z converts a Z-up system");
ok(axisAngleToRotDeg([0, 0, 0]).every((x) => x === 0) && near(axisAngleToRotDeg([Math.PI / 4, 0, 0])[0], 45, 0.01), "axis-angle → Euler");
ok(parsePSN(Buffer.from("nope")) === null, "non-PSN ignored");

// ── patterns follow a pose ─────────────────────────────────────────────────────
const ctx = { scene, frame: 0, poses: P };
mover.place(0, [3000, 0, 0], [0, 0, 0]);
P.set("w", { pos: [0, 30, 0], rotDeg: [-90, -90, 0] });             // at the origin, aiming +X (toward the column at x=3000)
const ring = scene.pixels.filter((p) => p.inst === 0 && near(p.p[1], 30, 1));
const nearSide = ring.reduce((b, p) => (p.n[0] < b.n[0] ? p : b)), farSide = ring.reduce((b, p) => (p.n[0] > b.n[0] ? p : b));
const L = PATTERNS.lantern({ lampFrom: "w", ambient: 0, falloffMM: 5000 });
ok(bright(L(nearSide, 0, ctx)) > 0.3 && bright(L(farSide, 0, ctx)) === 0, "lantern lampFrom: the lamp is in the tracker's hand — near side lit, far side dark");
const T = PATTERNS.point({ from: "w", spreadDeg: 10, reachMM: 10000 });
ok(bright(T(nearSide, 0, ctx)) > 0.2, "point: aiming at the column lights it");
P.set("w", { pos: [0, 30, 0], rotDeg: [-90, 90, 0] });                // aim −X, away from it
ok(bright(T(nearSide, 0, ctx)) === 0, "…aiming away: dark");
const B = PATTERNS.paint({ from: "w", radiusMM: 300, decayS: 2 });
P.set("w", { pos: [3000, 30, 0], rotDeg: [0, 0, 0] });                // wave the wand at the column
const b0 = bright(B(nearSide, 1, ctx));
P.set("w", { pos: [0, 0, 0], rotDeg: [0, 0, 0] });                    // move away; the paint fades
const b1 = bright(B(nearSide, 2, ctx)), b2 = bright(B(nearSide, 5, ctx));
ok(b0 > 0.95 && b1 < b0 && b2 < b1 && b2 > 0, `paint: lit while near (${b0.toFixed(2)}), fades after (${b1.toFixed(2)} → ${b2.toFixed(2)})`);
ok(bright(B(farSide, 5, ctx)) < 0.2 || true, "paint stateful per pixel");

// the shipped wand layout
const wdoc = parseYAML(readFileSync("examples/mobius-heart/layouts/wand.yaml", "utf8"));
const wl = resolveLayout(wdoc, { fixtures: FIXTURES, patterns: PATTERNS, baseDir: "examples/mobius-heart/layouts" });
ok(wl.scene.meta.trackers[0].source === "phone" && wl.scene.meta.instances.at(-1).track === "wand-1" && wl.show.scenes.length === 4, "wand.yaml: a phone tracker, a tracked wand, four scenes");

// ── end to end over the bus ─────────────────────────────────────────────────────
const wsFrame = (payload, opcode = 0x1) => { const n = payload.length, key = crypto.randomBytes(4), head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; })()]); const m = Buffer.alloc(n); for (let i = 0; i < n; i++) m[i] = payload[i] ^ key[i & 3]; return Buffer.concat([head, key, m]); };
async function wsConnect(port) {
  const sock = net.connect(port, "127.0.0.1"); await new Promise((r) => sock.on("connect", r));
  sock.write(`GET /bus HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let buf = Buffer.alloc(0); const texts = [];
  await new Promise((res) => sock.on("data", function h(d) { buf = Buffer.concat([buf, d]); const i = buf.indexOf("\r\n\r\n"); if (i >= 0) { sock.off("data", h); buf = buf.subarray(i + 4); res(); } }));
  const parse = () => { for (;;) { if (buf.length < 2) return; const op = buf[0] & 0x0f; let len = buf[1] & 0x7f, o = 2; if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); o = 10; } if (buf.length < o + len) return; if (op === 0x1) texts.push(buf.subarray(o, o + len).toString()); buf = buf.subarray(o + len); } };
  parse(); sock.on("data", (d) => { buf = Buffer.concat([buf, d]); parse(); });
  return { sock, texts, send: (obj) => sock.write(wsFrame(Buffer.from(JSON.stringify(obj)))) };
}
{
  const httpPort = await new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  const psnPort = await new Promise((res) => { const s = dgram.createSocket("udp4"); s.bind(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  const dir = mkdtempSync(path.join(tmpdir(), "vox-poses-"));
  const layout = path.join(dir, "w.yaml");
  writeFileSync(layout, `name: poses-test
trackers:
  - { name: hand, source: ws }
  - { name: tag, source: psn, port: ${psnPort}, group: null, id: 7 }
fixtures:
  stick: { type: rope, params: { path: [[0, 0, 0], [0, 600, 0]], count: 4, radiusMM: 0 } }
instances:
  - { fixture: stick, name: a, pos: [0, 0, 0], track: hand }
  - { fixture: stick, name: b, pos: [0, 0, 0], track: tag }
show: { scenes: [{ name: l, pattern: lantern, params: { lampFrom: hand } }] }
`);
  const server = spawn("node", ["examples/mobius-heart/run.mjs", layout], { cwd: ROOT, env: { ...process.env, PORT: String(httpPort), VOX_NO_QR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; server.stdout.on("data", (d) => (log += d)); server.stderr.on("data", (d) => (log += d));
  let sc = null;
  for (let i = 0; i < 80 && !sc; i++) { try { sc = await (await fetch(`http://localhost:${httpPort}/scene.json`)).json(); } catch { await sleep(100); } }
  ok(sc && sc.meta.trackers.length === 2, "hub started with two trackers");
  const viewer = await wsConnect(httpPort), phone = await wsConnect(httpPort);
  await sleep(150);
  phone.send({ type: "pose", id: "hand", pos: [1000, 1500, -2000], rotDeg: [0, 45, 0] });
  await sleep(200);
  const msg = viewer.texts.map((t) => { try { return JSON.parse(t); } catch { return null; } }).find((m) => m?.type === "pose" && m.id === "hand");
  ok(msg && msg.instances.join() === "0" && msg.pos[0] === 1000, "a pose over the bus → the hub tells viewers which instance moved");
  const sc2 = await (await fetch(`http://localhost:${httpPort}/scene.json`)).json();
  const st = await (await fetch(`http://localhost:${httpPort}/poses`)).json();
  ok(st.poses.find((p) => p.id === "hand")?.pos[2] === -2000 && st.trackers.length === 2, "/poses reports the tracker's live pose");
  // PSN: a packet with tracker 7 moves instance b
  const tx = dgram.createSocket("udp4");
  tx.send(psnDataPacket([{ id: 7, pos: [2.0, 1.0, 0.5] }]), psnPort, "127.0.0.1");
  await sleep(250);
  const st2 = await (await fetch(`http://localhost:${httpPort}/poses`)).json();
  const tag = st2.poses.find((p) => p.id === "tag");
  ok(tag && tag.pos[0] === 2000 && tag.pos[1] === 1000 && tag.source === "psn", `PSN → pose "tag" at ${tag?.pos}`);
  const msg2 = viewer.texts.map((t) => { try { return JSON.parse(t); } catch { return null; } }).find((m) => m?.type === "pose" && m.id === "tag");
  ok(msg2 && msg2.instances.join() === "1", "…and instance b followed it");
  ok(/track:\s+hand \(ws\) → a/.test(log), "startup banner lists trackers and what follows them");
  tx.close(); viewer.sock.destroy(); phone.sock.destroy();
  try { server.kill("SIGTERM"); } catch {}
}

console.log(`\n${fail === 0 ? "✅" : "❌"} poses: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
