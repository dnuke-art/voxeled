// `tube` — a rolled matrix panel as a standing column: geometry (diameter from circumference + seam,
// rings along +Y from the base), radial normals, the panel's serpentine wiring as data order,
// stacked panels, `along` wiring, and a layout of columns on the ground through the ring generator.
import { tubeFixture } from "../src/fixtures/tube.mjs";
import { resolveLayout } from "../src/layout.mjs";
import { parseYAML } from "../src/yaml.mjs";
import { FIXTURES } from "../examples/mobius-heart/fixtures.mjs";
import { PATTERNS } from "../src/patterns.mjs";
import { checkFixture } from "../src/io/check.mjs";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c, m) => (c ? (pass++, console.log("  ✓", m)) : (fail++, console.log("  ✗", m)));
const near = (a, b, t = 1e-3) => Math.abs(a - b) <= t;

const f = tubeFixture({ cols: 8, rows: 32, panels: 3, pitchMM: 10, seamMM: 10 });
ok(f.pixels.length === 768 && f.meta.strands === 3, "8×32 × 3 panels = 768 px, one strand per panel");
ok(near(f.meta.diameterMM, 28.65, 0.01) && f.meta.circumferenceMM === 90, "Ø = (8·10 + 10 seam)/π = 28.65 mm");
ok(near(f.meta.heightMM, 950) , `96 rings at 10 mm: first at y=0, last at 950 (height ${f.meta.heightMM})`);
const r0 = f.pixels.slice(0, 8);
ok(r0.every((p) => near(Math.hypot(p.p[0], p.p[2]), 14.324, 0.01) && p.p[1] === 0), "ring 0: all 8 LEDs on the roll radius at y = 0");
ok(f.pixels.every((p) => near(Math.hypot(...p.n), 1, 1e-3) && p.n[1] === 0 && near(p.n[0] * p.p[0] + p.n[2] * p.p[2], 14.324, 0.05)), "normals are radial, unit, horizontal");
const ang = (p) => (Math.atan2(p.p[2], p.p[0]) * 180) / Math.PI;
ok(near(ang(r0[1]) - ang(r0[0]), 40, 0.01) && near(((ang(r0[0]) - ang(r0[7]) + 720) % 360), 80, 0.01), "seam: LEDs 40° apart (10 mm of 90 mm), an 80° gap at the seam");
ok(f.pixels[8].p[1] === 10 && near(ang(f.pixels[8]), ang(r0[7]), 0.01) && near(ang(f.pixels[15]), ang(r0[0]), 0.01), "serpentine: ring 1 (y = 10) runs back the other way — its first LED sits above ring 0's last");
ok(f.pixels[0].s === 0 && f.pixels[767].s === 1 && f.pixels[0].v === 0 && near(f.pixels[7].v, 0.875), "s runs 0→1 up the column, v around it");
ok(f.pixels[256].strand === 1 && f.pixels[256].p[1] === 320 && f.pixels[512].strand === 2, "panels stack: panel 1 starts at y = 320 mm (32 rings on)");
const g = tubeFixture({ cols: 8, rows: 32, panels: 2, panelGapMM: 15 });
ok(g.pixels[256].p[1] === 335 && near(g.meta.diameterMM, 25.46, 0.01), "panelGapMM adds between panels; no seam → Ø 25.46 mm");
const a = tubeFixture({ cols: 8, rows: 32, wiring: "along" });
ok(a.pixels[0].p[1] === 0 && a.pixels[31].p[1] === 310 && a.pixels[32].p[1] === 310 && near(ang(a.pixels[32]) - ang(a.pixels[31]), 45, 0.01), "wiring along: data runs up a line then back down the next one round");
const c = tubeFixture({ cols: 8, rows: 4, clockwise: true, startAngleDeg: 90 });
ok(near(ang(c.pixels[0]), 90, 0.01) && near(ang(c.pixels[1]), 45, 0.01), "startAngleDeg + clockwise");
let threw = ""; try { tubeFixture({ wiring: "spiral" }); } catch (e) { threw = e.message; }
ok(/across \| along/.test(threw), "bad wiring is a clear error");
ok(checkFixture(f).ok, "passes vox check");

// the shipped layout: 24 panels → 8 columns standing on the ground
const doc = parseYAML(readFileSync("examples/mobius-heart/layouts/columns.yaml", "utf8"));
const { scene, show } = resolveLayout(doc, { fixtures: FIXTURES, patterns: PATTERNS, baseDir: "examples/mobius-heart/layouts" });
ok(scene.meta.instances.length === 8 && scene.count === 8 * 768, "columns.yaml: 8 columns of 3 panels = 24 panels, 6,144 px");
const lo = Math.min(...scene.pixels.map((p) => p.p[1])), hi = Math.max(...scene.pixels.map((p) => p.p[1]));
ok(lo === 0 && near(hi, 950), "every column stands on the ground (y from 0 to 950)");
const uni = scene.meta.instances.map((i) => i.output.universe);
ok(uni.join() === "0,5,10,15,20,25,30,35" && scene.meta.instances[0].output.protocol === "artnet", "each column gets its own 5-universe block over the fixture-level Art-Net patch");
ok(show.scenes.length === 6, "the six-scene show resolves");

console.log(`\n${fail === 0 ? "✅" : "❌"} tube: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
