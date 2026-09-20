// Sources + merge — several live streams driving one piece at once, the way a pro rig does it.
// Each input is a SOURCE with a priority and a liveness timeout that writes into its own frame
// (whole frames, or universes through an input map). Every tick the hub composes the output:
//
//   priority  per pixel, the highest-priority LIVE source that has written that pixel wins
//   htp       highest-takes-precedence: per channel, the max over live sources
//   ltp       latest-takes-precedence: per pixel, whichever live source wrote it most recently
//
// Pixels no live source covers fall back to `fallback`: the internal show (default), black, or
// hold (keep the last output). A source goes silent after `timeoutMs` without data, so a sender
// that dies hands its pixels back — that is the failover.
export function createSources({ N: N0, mode = "priority", fallback = "show", timeoutMs = 1000 } = {}) {
  let N = N0;
  if (!["priority", "htp", "ltp"].includes(mode)) throw new Error(`merge mode must be priority | htp | ltp (got "${mode}")`);
  if (!["show", "black", "hold"].includes(fallback)) throw new Error(`merge fallback must be show | black | hold (got "${fallback}")`);
  const list = [];
  let counter = 0;
  const now = () => Date.now();

  function add(name, { priority = 0, timeoutMs: tmo = timeoutMs } = {}) {
    if (list.some((s) => s.name === name)) throw new Error(`duplicate input name "${name}"`);
    const s = {
      name, priority, timeoutMs: tmo,
      buf: new Uint8Array(N * 3), mask: new Uint8Array(N), stamp: new Uint32Array(N),
      lastAt: 0, writes: 0, rate: 0, _win: 0, _winAt: now(),
      get live() { return s.lastAt && now() - s.lastAt < s.timeoutMs; },
      touch() { s.lastAt = now(); s.writes++; s._win++; },
      // a whole frame in scene order (N or fewer pixels)
      writeFrame(rgb) {
        const n = Math.min(N, (rgb.length / 3) | 0);
        s.buf.set(rgb.subarray(0, n * 3));
        const c = ++counter;
        for (let i = 0; i < n; i++) { s.mask[i] = 1; s.stamp[i] = c; }
        s.touch();
      },
      // one universe through an input map
      writeUniverse(map, universe, data) {
        const t = map.table.get(universe);
        if (!t) return 0;
        const n = Math.min(t.length, (data.length / 3) | 0), c = ++counter;
        let w = 0;
        for (let j = 0; j < n; j++) {
          const p = t[j];
          if (p < 0) continue;
          s.buf[p * 3] = data[j * 3]; s.buf[p * 3 + 1] = data[j * 3 + 1]; s.buf[p * 3 + 2] = data[j * 3 + 2];
          s.mask[p] = 1; s.stamp[p] = c; w++;
        }
        if (w) s.touch();
        return w;
      },
    };
    list.push(s);
    list.sort((a, b) => b.priority - a.priority);
    return s;
  }

  // Compose the output frame. `base(rgbOut)` renders the internal show into `out` — called only
  // when some pixel needs it (uncovered + fallback show), so a fully-driven piece skips pattern work.
  function compose(out, base) {
    const t = now();
    for (const s of list) if (t - s._winAt >= 1000) { s.rate = Math.round((s._win * 1000) / (t - s._winAt)); s._win = 0; s._winAt = t; }
    const live = list.filter((s) => s.lastAt && t - s.lastAt < s.timeoutMs);
    if (!live.length) { if (fallback === "show") base?.(out); else if (fallback === "black") out.fill(0); return { live: [], covered: 0 }; }
    // coverage: does any live source own each pixel?
    let covered = 0;
    const own = new Uint8Array(N);
    for (const s of live) for (let i = 0; i < N; i++) if (s.mask[i]) own[i] = 1;
    for (let i = 0; i < N; i++) covered += own[i];
    if (covered < N) { if (fallback === "show") base?.(out); else if (fallback === "black") for (let i = 0; i < N; i++) if (!own[i]) { out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = 0; } }
    if (mode === "priority") {
      for (let i = 0; i < N; i++) {
        if (!own[i]) continue;
        for (const s of live) if (s.mask[i]) { out[i * 3] = s.buf[i * 3]; out[i * 3 + 1] = s.buf[i * 3 + 1]; out[i * 3 + 2] = s.buf[i * 3 + 2]; break; }
      }
    } else if (mode === "htp") {
      for (let i = 0; i < N; i++) {
        if (!own[i]) continue;
        let r = 0, g = 0, b = 0;
        for (const s of live) if (s.mask[i]) { if (s.buf[i * 3] > r) r = s.buf[i * 3]; if (s.buf[i * 3 + 1] > g) g = s.buf[i * 3 + 1]; if (s.buf[i * 3 + 2] > b) b = s.buf[i * 3 + 2]; }
        out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
      }
    } else {
      for (let i = 0; i < N; i++) {
        if (!own[i]) continue;
        let best = null, bs = 0;
        for (const s of live) if (s.mask[i] && s.stamp[i] >= bs) { bs = s.stamp[i]; best = s; }
        out[i * 3] = best.buf[i * 3]; out[i * 3 + 1] = best.buf[i * 3 + 1]; out[i * 3 + 2] = best.buf[i * 3 + 2];
      }
    }
    return { live: live.map((s) => s.name), covered };
  }

  // The scene changed size (a fixture joined or left): grow/shrink every source's buffers in place.
  function resize(n) {
    if (n === N) return;
    for (const s of list) {
      const grow = (old, len, T) => { const b = new T(len); b.set(old.subarray(0, Math.min(old.length, len))); return b; };
      s.buf = grow(s.buf, n * 3, Uint8Array); s.mask = grow(s.mask, n, Uint8Array); s.stamp = grow(s.stamp, n, Uint32Array);
    }
    N = n;
  }

  return {
    add, compose, list, mode, fallback, resize,
    get N() { return N; },
    get(name) { return list.find((s) => s.name === name); },
    status() { return list.map((s) => ({ name: s.name, priority: s.priority, live: s.live, rate: s.rate, writes: s.writes, lastAt: s.lastAt })); },
  };
}
