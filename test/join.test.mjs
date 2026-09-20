// Live join: a device announces itself on the bus (or POST /instances) while the show runs and is
// appended to the scene — existing pixel indices untouched, the hub's clock continuous, inputs
// left bound with their history — then leaves by `bye`, by TTL, or by DELETE; joins persist to
// the layout with ?save=1. A phone-as-a-pixel round trip: hello → welcome(index) → its colour
// arrives in the bus frames at that index and follows its pose.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import dgram from "node:dgram";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artDmxPacket } from "../src/senders/artnet.mjs";
import { parseYAML } from "../src/yaml.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✓", m)) : (fail++, console.log("  ✗", m)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const freeUdp = () => new Promise((res) => { const s = dgram.createSocket("udp4"); s.bind(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const wsFrame = (payload, opcode = 0x1) => { const n = payload.length, key = crypto.randomBytes(4), head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; })()]); const m = Buffer.alloc(n); for (let i = 0; i < n; i++) m[i] = payload[i] ^ key[i & 3]; return Buffer.concat([head, key, m]); };
async function wsConnect(port) {
  const sock = net.connect(port, "127.0.0.1"); await new Promise((r) => sock.on("connect", r));
  sock.write(`GET /bus HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let buf = Buffer.alloc(0); const texts = [], frames = [];
  await new Promise((res) => sock.on("data", function h(d) { buf = Buffer.concat([buf, d]); const i = buf.indexOf("\r\n\r\n"); if (i >= 0) { sock.off("data", h); buf = buf.subarray(i + 4); res(); } }));
  const parse = () => { for (;;) { if (buf.length < 2) return; const op = buf[0] & 0x0f; let len = buf[1] & 0x7f, o = 2; if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); o = 4; } else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); o = 10; } if (buf.length < o + len) return; if (op === 0x1) texts.push(buf.subarray(o, o + len).toString()); else if (op === 0x2) frames.push(Buffer.from(buf.subarray(o, o + len))); buf = buf.subarray(o + len); } };
  parse(); sock.on("data", (d) => { buf = Buffer.concat([buf, d]); parse(); });
  return { sock, texts, frames, send: (obj) => sock.write(wsFrame(Buffer.from(JSON.stringify(obj)))), msgs: (type) => texts.map((t) => { try { return JSON.parse(t); } catch { return null; } }).filter((m) => m?.type === type) };
}

const httpPort = await freePort(), artPort = await freeUdp();
const dir = mkdtempSync(path.join(tmpdir(), "vox-join-"));
const layout = path.join(dir, "j.yaml");
writeFileSync(layout, `# join test
name: join-test
fixtures:
  col: { type: tube, params: { cols: 8, rows: 4, panels: 1 } }
instances:
  - { fixture: col, name: c0, pos: [0, 0, 0] }
  - { fixture: col, name: c1, pos: [2000, 0, 0] }
inputs:
  - { name: console, protocol: artnet, port: ${artPort}, priority: 100, timeoutMs: 400 }
join: { ttlS: 2 }
show: { holdS: 100, fadeS: 1, scenes: [{ name: sweep, pattern: planeSweep, params: { speedMM: 20, spacingMM: 400, widthMM: 100 } }] }
`);
const server = spawn("node", ["examples/mobius-heart/run.mjs", layout], { cwd: ROOT, env: { ...process.env, PORT: String(httpPort), VOX_NO_QR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; server.stdout.on("data", (d) => (log += d)); server.stderr.on("data", (d) => (log += d));
let sc = null;
for (let i = 0; i < 80 && !sc; i++) { try { sc = await (await fetch(`http://localhost:${httpPort}/scene.json`)).json(); } catch { await sleep(100); } }
ok(sc && sc.count === 64 && sc.meta.join?.enabled && sc.meta.join.ttlS === 2, "hub up: 2 columns (64 px), joins open with a 2 s ttl");
const url = (p) => `http://localhost:${httpPort}${p}`;

// an Art-Net source drives pixel 0 — its history must survive a join (inputs stay bound)
const tx = dgram.createSocket("udp4");
const dmx = new Uint8Array(9).fill(200); // universe 0, three pixels only — the rest stays the show's
for (let i = 0; i < 3; i++) { tx.send(artDmxPacket(0, i, dmx), artPort, "127.0.0.1"); await sleep(40); }
const st0 = await (await fetch(url("/inputs"))).json();
ok(st0.inputs[0].live && st0.inputs[0].writes >= 3, "Art-Net input live before the join");

// a phone joins as a pixel over the bus
const viewer = await wsConnect(httpPort), phone = await wsConnect(httpPort);
await sleep(150);
phone.send({ type: "hello", id: "phone-ab12", fixture: { type: "dot" }, track: true, ttlS: 2, pos: [1000, 1200, 500] });
await sleep(400);
const w = phone.msgs("welcome")[0];
ok(w && w.index === 64 && w.count === 1 && w.total === 65 && w.instance === 2, `welcome: the phone is pixel ${w?.index} of ${w?.total} (appended, nothing shifted)`);
const sc1 = await (await fetch(url("/scene.json"))).json();
ok(sc1.count === 65 && sc1.meta.instances[2].name === "phone-ab12" && sc1.meta.instances[2].track === "phone-ab12" && sc1.meta.trackers.some((t) => t.name === "phone-ab12") && sc1.pixels[64].p[0] === 1000, "scene: a dot instance at the hello position, tracked by a tracker of its own; the columns' pixels 0-63 unchanged");
ok(viewer.msgs("scene").length >= 1, "viewers were told the scene changed");
const st1 = await (await fetch(url("/inputs"))).json();
ok(st1.inputs[0].writes >= st0.inputs[0].writes && st1.inputs[0].name === "console", `inputs were not rebound by the join (writes ${st0.inputs[0].writes} → ${st1.inputs[0].writes})`);
tx.send(artDmxPacket(0, 9, dmx), artPort, "127.0.0.1"); await sleep(150);
const f = viewer.frames.at(-1);
ok(f && f.length === 65 * 3 && f[0] === 200, "bus frames are 65 px now, Art-Net still owns pixel 0");
// the phone's pixel follows its pose: at y just below a sweep band vs far away → different colours
phone.send({ type: "pose", id: "phone-ab12", pos: [1000, 0, 500], rotDeg: [0, 0, 0] }); await sleep(120);
const a = viewer.frames.at(-1).subarray(64 * 3, 65 * 3).join();
phone.send({ type: "pose", id: "phone-ab12", pos: [1000, 200, 500], rotDeg: [0, 0, 0] }); await sleep(120);
const b = viewer.frames.at(-1).subarray(64 * 3, 65 * 3).join();
ok(a !== b, `the phone's pixel colour follows where it is (${a} → ${b})`);
ok(/join:\s+phone-ab12 \(joined-phone-ab12, 1 px, tracked\)/.test(log), "the hub logged the join");

// continuity: the sweep on pixel 30 must not jump when someone joins (hub clock carried)
const before = viewer.frames.at(-1)[30 * 3 + 1];
const p2 = await wsConnect(httpPort); await sleep(100);
p2.send({ type: "hello", id: "wand-9", fixture: { type: "rope", params: { path: [[0, 0, 0], [0, 300, 0]], count: 3, radiusMM: 0 } }, output: { protocol: "ddp", host: "127.0.0.1", port: 4999 } });
await sleep(300);
const after = viewer.frames.at(-1)[30 * 3 + 1];
ok(Math.abs(after - before) < 60, `the show didn't restart on a join (pixel 30 green ${before} → ${after})`);
const w2 = p2.msgs("welcome")[0];
ok(w2 && w2.index === 65 && w2.count === 3, "a wand with inline geometry + its own DDP patch joined after the phone");
const li = await (await fetch(url("/instances"))).json();
ok(li.instances.length === 4 && li.instances[3].joined && !li.instances[0].joined && li.instances[3].output?.protocol === "ddp", "/instances lists them, marking which joined, with their patch");

// bye removes; the phone learns its index didn't change (it was before the wand)
p2.send({ type: "bye", id: "wand-9" }); await sleep(300);
ok((await (await fetch(url("/scene.json"))).json()).count === 65, "bye: the wand is gone, 65 px");
// leaving silently: ttl 2 s without pose/heartbeat removes the phone
phone.sock.destroy(); await sleep(3200);
const sc3 = await (await fetch(url("/scene.json"))).json();
ok(sc3.count === 64 && !sc3.meta.trackers?.length, "ttl: a silent phone is removed, its tracker too");
ok(/leave:\s+wand-9 \(bye\)/.test(log) && /leave:\s+phone-ab12 \(silent 2 s\)/.test(log), "the hub logged both leaves");

// HTTP: POST /instances?save=1 persists into the layout file
const r = await (await fetch(url("/instances?save=1"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: "lamp", fixtureName: "col", pos: [4000, 0, 0] }) })).json();
ok(r.ok && r.index === 64 && r.count === 32 && r.saved, "POST /instances adds an instance of an existing fixture and saves");
const saved = parseYAML(readFileSync(layout, "utf8"));
ok(saved.instances.length === 3 && saved.instances[2].name === "lamp" && readFileSync(layout, "utf8").startsWith("# join test"), "…the layout file has it (header kept)");
const d = await fetch(url("/instances?name=lamp"), { method: "DELETE" });
ok(d.status === 200 && (await (await fetch(url("/scene.json"))).json()).count === 64, "DELETE /instances removes it");
const bad = await (await fetch(url("/instances"), { method: "POST", body: JSON.stringify({ id: "x", fixtureName: "nope" }) })).json();
ok(/unknown fixture/.test(bad.error) && (await (await fetch(url("/scene.json"))).json()).count === 64, "a bad hello is refused and changes nothing");

tx.close(); viewer.sock.destroy(); p2.sock.destroy();
try { server.kill("SIGTERM"); } catch {}
console.log(`\n${fail === 0 ? "✅" : "❌"} join: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
