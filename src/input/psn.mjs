// PosiStageNet (PSN) receiver — the entertainment industry's tracking protocol (BlackTrax,
// zactrack, Stage Precision, consoles): UDP multicast 236.10.10.10:56565, v2 data + info packets.
// A tracker's position (metres) and orientation (axis-angle, radians) become a voxeled pose.
import dgram from "node:dgram";
import { matToEulerDeg } from "../vec.mjs";

export const PSN_GROUP = "236.10.10.10", PSN_PORT = 56565;
const DATA = 0x6755, INFO = 0x6756;

// chunk header: u16 id, u16 (len:15 | hasSubchunks:1)
function* chunks(buf, off, end) {
  while (off + 4 <= end) {
    const id = buf.readUInt16LE(off), w = buf.readUInt16LE(off + 2), len = w & 0x7fff, sub = !!(w & 0x8000);
    yield { id, len, sub, start: off + 4, end: Math.min(end, off + 4 + len) };
    off += 4 + len;
  }
}
const f32 = (b, o) => b.readFloatLE(o);

export function parsePSN(buf) {
  if (buf.length < 4) return null;
  const root = buf.readUInt16LE(0);
  if (root !== DATA && root !== INFO) return null;
  const out = { type: root === DATA ? "data" : "info", trackers: {}, header: null };
  for (const c of chunks(buf, 4, buf.length)) {
    if (c.id === 0x0000 && c.len >= 12) out.header = { timestamp: Number(buf.readBigUInt64LE(c.start)), version: `${buf[c.start + 8]}.${buf[c.start + 9]}`, frame: buf[c.start + 10], frames: buf[c.start + 11] };
    else if (c.id === 0x0001) {
      for (const t of chunks(buf, c.start, c.end)) {
        const tr = (out.trackers[t.id] ||= { id: t.id });
        for (const s of chunks(buf, t.start, t.end)) {
          if (out.type === "data") {
            if (s.id === 0x0000 && s.len >= 12) tr.pos = [f32(buf, s.start), f32(buf, s.start + 4), f32(buf, s.start + 8)];           // metres
            else if (s.id === 0x0001 && s.len >= 12) tr.speed = [f32(buf, s.start), f32(buf, s.start + 4), f32(buf, s.start + 8)];
            else if (s.id === 0x0002 && s.len >= 12) tr.ori = [f32(buf, s.start), f32(buf, s.start + 4), f32(buf, s.start + 8)];      // axis-angle, rad
            else if (s.id === 0x0003 && s.len >= 4) tr.validity = f32(buf, s.start);
          } else if (s.id === 0x0000) tr.name = buf.toString("utf8", s.start, s.end).replace(/\0+$/, "");
        }
      }
    } else if (out.type === "info" && c.id === 0x0002) out.systemName = buf.toString("utf8", c.start, c.end).replace(/\0+$/, "");
  }
  return out;
}

// axis-angle (rotation vector) → voxeled rotDeg (Z·Y·X Euler)
export function axisAngleToRotDeg([x, y, z]) {
  const a = Math.hypot(x, y, z);
  if (a < 1e-9) return [0, 0, 0];
  const [ux, uy, uz] = [x / a, y / a, z / a], c = Math.cos(a), s = Math.sin(a), C = 1 - c;
  const R = [
    [c + ux * ux * C, ux * uy * C - uz * s, ux * uz * C + uy * s],
    [uy * ux * C + uz * s, c + uy * uy * C, uy * uz * C - ux * s],
    [uz * ux * C - uy * s, uz * uy * C + ux * s, c + uz * uz * C],
  ];
  return matToEulerDeg(R);
}

// PSN tracker → voxeled pose. `up: "y"` (default) keeps PSN axes; `up: "z"` converts a Z-up system.
export function psnToPose(tr, { scaleToMM = 1000, up = "y" } = {}) {
  if (!tr.pos) return null;
  let p = tr.pos.map((v) => v * scaleToMM), rot = tr.ori ? axisAngleToRotDeg(tr.ori) : [0, 0, 0];
  if (up === "z") { p = [p[0], p[2], -p[1]]; rot = tr.ori ? axisAngleToRotDeg([tr.ori[0], tr.ori[2], -tr.ori[1]]) : rot; }
  return { pos: p.map((v) => +v.toFixed(2)), rotDeg: rot.map((v) => +v.toFixed(3)) };
}

// Build a PSN data packet (for tests and for voxeled-as-a-tracking-source later).
export function psnDataPacket(trackers, { timestamp = 0n, frame = 0 } = {}) {
  const chunk = (id, body, sub = false) => { const h = Buffer.alloc(4); h.writeUInt16LE(id, 0); h.writeUInt16LE((body.length & 0x7fff) | (sub ? 0x8000 : 0), 2); return Buffer.concat([h, body]); };
  const hdr = Buffer.alloc(12); hdr.writeBigUInt64LE(BigInt(timestamp), 0); hdr[8] = 2; hdr[9] = 0; hdr[10] = frame; hdr[11] = 1;
  const f = (v) => { const b = Buffer.alloc(12); b.writeFloatLE(v[0], 0); b.writeFloatLE(v[1], 4); b.writeFloatLE(v[2], 8); return b; };
  const list = Buffer.concat(trackers.map((t) => chunk(t.id, Buffer.concat([chunk(0x0000, f(t.pos)), ...(t.ori ? [chunk(0x0002, f(t.ori))] : [])]), true)));
  return chunk(DATA, Buffer.concat([chunk(0x0000, hdr), chunk(0x0001, list, true)]), true);
}

export function createPSNInput({ port = PSN_PORT, group = PSN_GROUP, host = "0.0.0.0", onTrackers } = {}) {
  const sock = dgram.createSocket({ type: "udp4", reuseAddr: true });
  const stats = { packets: 0, trackers: new Set(), names: {}, lastAt: 0 };
  sock.on("message", (msg) => {
    const p = parsePSN(msg);
    if (!p) return;
    stats.packets++; stats.lastAt = Date.now();
    for (const t of Object.values(p.trackers)) { stats.trackers.add(t.id); if (t.name) stats.names[t.id] = t.name; }
    if (p.type === "data") onTrackers?.(p.trackers, stats.names);
  });
  sock.bind(port, host, () => { if (group) { try { sock.addMembership(group); } catch {} } });
  return { sock, stats, close: () => { try { sock.close(); } catch {} } };
}
