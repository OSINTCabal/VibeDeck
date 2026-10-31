import * as React from "react";
import { useBackdrop, useBackdropMood, type BackdropId, type BackdropMood } from "@/lib/backdrop";

// Yellow to red, the warm ramp of the Mistral look
const SUN = ["#ffd800", "#ffaf00", "#ff8205", "#fa500f", "#e10500"];
const GREENS = ["#2f7d55", "#45a86f", "#7fd3a2"];
const BLUES = ["#2f6db3", "#4f93dd", "#8cc0f2"];

/** How visible and how lively the scene is, and how much of the reading column is cleared. */
type Params = { alpha: number; speed: number; work: number; clear: number };
const MOODS: Record<BackdropMood, Params> = {
  idle: { alpha: 1, speed: 1, work: 0, clear: 0.1 },
  chat: { alpha: 0.32, speed: 0.45, work: 0, clear: 0.92 },
  working: { alpha: 0.5, speed: 1.5, work: 1, clear: 0.85 },
  // settings, skills and other pages: faint, and clear across the content
  page: { alpha: 0.22, speed: 0.35, work: 0, clear: 0.7 },
};

interface Scene {
  resize(w: number, h: number): void;
  step(t: number, dt: number, work: number): void;
  paint(ctx: CanvasRenderingContext2D, t: number, work: number, light: boolean): void;
}

const smooth = (a: number, b: number, x: number) => {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
};
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
// stable pseudo-random per cell, so flicker does not need stored state
const hash = (a: number, b: number, c = 0) => {
  const s = Math.sin(a * 127.1 + b * 311.7 + c * 74.7) * 43758.5453;
  return s - Math.floor(s);
};

// ---------------------------------------------------------------- blocks

function blocks(): Scene {
  const S = 44;
  type Tile = { x: number; y: number; colors: string[]; born: number; life: number; diamond: boolean };
  let w = 0, h = 0, next = 0;
  let tiles: Tile[] = [];
  const spawn = (t: number) => {
    // mostly along the right edge, some on the left and the bottom, like the hero of mistral.ai
    const zone = Math.random();
    const cols = Math.max(1, Math.floor(w / S)), rows = Math.max(1, Math.floor(h / S));
    let gx: number, gy: number;
    if (zone < 0.55) { gx = cols - 1 - Math.floor(Math.random() * 3); gy = Math.floor(Math.random() * rows); }
    else if (zone < 0.8) { gx = Math.floor(Math.random() * 2); gy = Math.floor(Math.random() * rows); }
    else { gx = Math.floor(Math.random() * cols); gy = rows - 1 - Math.floor(Math.random() * 2); }
    const stack = Math.random() < 0.3 ? 2 + Math.floor(Math.random() * 2) : 1;
    for (const o of tiles) if (o.x === gx && Math.abs(o.y - gy) < stack + 1) return;
    const first = Math.floor(Math.random() * (SUN.length - stack + 1));
    tiles.push({
      x: gx, y: gy, colors: SUN.slice(first, first + stack), born: t,
      life: 4 + Math.random() * 3, diamond: stack === 1 && Math.random() < 0.6,
    });
  };
  return {
    resize(nw, nh) { w = nw; h = nh; tiles = tiles.filter(o => o.x * S < w && o.y * S < h); },
    step(t, _dt, work) {
      tiles = tiles.filter(o => t - o.born < o.life);
      while (t >= next) {
        if (tiles.length < 16 + work * 8) spawn(next);
        next += (0.6 + Math.random() * 0.5) / (1 + work * 1.5);
      }
    },
    paint(ctx, t, work) {
      tiles.forEach((o, i) => {
        const u = (t - o.born) / o.life;
        const grow = smooth(0, 0.14, u) * (1 - smooth(0.8, 1, u));
        const rot = o.diamond ? smooth(0.25, 0.55, u) * Math.PI / 4 : 0;
        const flicker = work ? 0.85 + 0.15 * Math.sin(t * 7 + i) * work : 1;
        o.colors.forEach((c, k) => {
          const size = S * grow * (o.diamond ? 1 - 0.28 * smooth(0.25, 0.55, u) : 1);
          ctx.save();
          ctx.translate(o.x * S + S / 2, (o.y + k) * S + S / 2);
          ctx.rotate(rot);
          ctx.globalAlpha = flicker;
          ctx.fillStyle = c;
          ctx.fillRect(-size / 2, -size / 2, size, size);
          ctx.restore();
        });
      });
    },
  };
}

// ---------------------------------------------------------------- strings

function strings(): Scene {
  type Arc = { cx: number; cy: number; r: number; from: number; to: number };
  type Spark = { arc: number; a: number; v: number; color: string; trail: number[] };
  let arcs: Arc[] = [];
  let sparks: Spark[] = [];
  const launch = (s?: Spark): Spark => {
    const arc = Math.floor(Math.random() * arcs.length);
    const spark = s ?? { arc, a: 0, v: 0, color: "", trail: [] };
    Object.assign(spark, { arc, a: arcs[arc]?.from ?? 0, v: 0.05 + Math.random() * 0.08, color: pick(SUN), trail: [] });
    return spark;
  };
  return {
    resize(w, h) {
      const m = Math.max(w, h);
      arcs = [
        ...[0.38, 0.55, 0.72, 0.9, 1.08].map(k => ({ cx: -0.12 * w, cy: -0.3 * h, r: k * m, from: 0, to: Math.PI / 2 })),
        ...[0.3, 0.45, 0.6].map(k => ({ cx: 1.1 * w, cy: 1.25 * h, r: k * m, from: Math.PI, to: 1.5 * Math.PI })),
      ];
      sparks = sparks.map(s => launch(s));
    },
    step(_t, dt, work) {
      const want = Math.round(8 + work * 12);
      while (sparks.length < want) { const s = launch(); s.a += Math.random() * (arcs[s.arc].to - arcs[s.arc].from); sparks.push(s); }
      if (sparks.length > want) sparks.length = want;
      for (const s of sparks) {
        const arc = arcs[s.arc];
        s.trail.unshift(s.a);
        s.trail.length = Math.min(s.trail.length, 4 + Math.round(work * 10));
        s.a += (s.v / (arc.r / 900)) * dt;
        if (s.a > arc.to) launch(s);
      }
    },
    paint(ctx, t, _work, light) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = light ? "rgba(0,0,0,0.08)" : "rgba(255,255,255,0.07)";
      for (const a of arcs) { ctx.beginPath(); ctx.arc(a.cx, a.cy, a.r, a.from, a.to); ctx.stroke(); }
      // small nodes sitting on the arcs, pulsing slowly
      arcs.forEach((a, i) => {
        const at = a.from + (a.to - a.from) * (0.25 + 0.5 * hash(i, 3));
        ctx.globalAlpha = 0.35 + 0.35 * Math.sin(t * 0.8 + i);
        ctx.fillStyle = SUN[i % SUN.length];
        ctx.fillRect(a.cx + a.r * Math.cos(at) - 3, a.cy + a.r * Math.sin(at) - 3, 6, 6);
      });
      for (const s of sparks) {
        const a = arcs[s.arc];
        ctx.fillStyle = s.color;
        s.trail.forEach((ang, k) => {
          ctx.globalAlpha = (1 - k / (s.trail.length + 1)) * 0.9;
          const size = k ? 3 : 5;
          ctx.fillRect(a.cx + a.r * Math.cos(ang) - size / 2, a.cy + a.r * Math.sin(ang) - size / 2, size, size);
        });
      }
      ctx.globalAlpha = 1;
    },
  };
}

// ---------------------------------------------------------------- mosaic

function mosaic(): Scene {
  const C = 26;
  let w = 0, h = 0;
  return {
    resize(nw, nh) { w = nw; h = nh; },
    step() {},
    paint(ctx, t, work) {
      const cols = Math.ceil(w / C), rows = Math.ceil(h / C);
      // a diagonal sweep while the model works
      const sweep = ((t * 0.35) % 1.6) - 0.3;
      for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
        const dx = (i + 0.5) / cols - 0.5, dy = (j + 0.5) / rows - 0.5;
        const edge = smooth(0.3, 0.72, Math.hypot(dx * 1.2, dy));
        const v = Math.sin(t * 0.6 + hash(i, j) * Math.PI * 2);
        let a = Math.max(0, (v - 0.86) / 0.14) * edge;
        let color = Math.sin(i * 0.11 + j * 0.07) > 0 ? GREENS[Math.floor(hash(j, i) * 3)] : BLUES[Math.floor(hash(j, i) * 3)];
        if (work) {
          const d = Math.abs((i / cols + j / rows) / 2 - sweep);
          const lit = (1 - smooth(0, 0.06, d)) * work * (0.4 + 0.6 * hash(i, j, 1)) * (0.35 + 0.65 * edge);
          if (lit > a) { a = lit; color = SUN[Math.floor(hash(i, j, 2) * SUN.length)]; }
        }
        if (a < 0.08) continue;
        ctx.globalAlpha = a * 0.7;
        ctx.fillStyle = color;
        ctx.fillRect(i * C + 1, j * C + 1, C - 2, C - 2);
      }
      ctx.globalAlpha = 1;
    },
  };
}

// ---------------------------------------------------------------- sunset

function sunset(): Scene {
  const C = 18;
  let w = 0, h = 0;
  return {
    resize(nw, nh) { w = nw; h = nh; },
    step() {},
    paint(ctx, t, work) {
      const cols = Math.ceil(w / C);
      const rows = Math.max(4, Math.ceil((h * 0.13) / C));
      const amp = 1.4 + work * 1.6;
      for (let i = 0; i < cols; i++) {
        const top = Math.round(rows * 0.5 + amp * Math.sin(i * 0.18 + t * 0.5) + amp * 0.7 * Math.sin(i * 0.07 - t * 0.3));
        for (let r = 0; r < rows + 4; r++) {
          const y = h - (r + 1) * C;
          const color = SUN[Math.min(SUN.length - 1, Math.floor((1 - r / rows) * SUN.length))] ?? SUN[0];
          if (r < top) {
            ctx.globalAlpha = 0.7 - 0.4 * (r / rows);
          } else {
            // sparks a few rows above the skyline
            const above = r - top;
            if (above > 3) break;
            const flick = hash(i, r, Math.floor(t * (1.5 + work * 3)));
            if (flick > 0.18 + above * 0.15 - work * 0.12) continue;
            ctx.globalAlpha = 0.5 - above * 0.1;
          }
          ctx.fillStyle = color;
          ctx.fillRect(i * C + 1, y + 1, C - 2, C - 2);
        }
      }
      ctx.globalAlpha = 1;
    },
  };
}

const SCENES: Record<Exclude<BackdropId, "off">, () => Scene> = { blocks, strings, mosaic, sunset };

/**
 * The chosen background, drawn on a canvas behind the main view. It eases
 * between moods, holds ~30 frames a second, stops while the window is hidden
 * and stays still for people who ask for reduced motion.
 */
export function Backdrop({ fallback }: { fallback: BackdropMood }) {
  const id = useBackdrop();
  const mood = useBackdropMood() ?? fallback;
  const ref = React.useRef<HTMLCanvasElement>(null);
  const moodRef = React.useRef(mood);
  moodRef.current = mood;

  React.useEffect(() => {
    const canvas = ref.current;
    if (id === "off" || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const scene = SCENES[id]();
    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    const p = { ...MOODS[moodRef.current] };
    let w = 0, h = 0, clock = 0, last = performance.now(), raf = 0, drawn = 0;

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scene.resize(w, h);
    };
    resize();
    // start mid-scene rather than from an empty canvas
    for (; clock < 6; clock += 0.1) scene.step(clock, 0.1, 0);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (document.hidden || now - drawn < (still.matches ? 500 : 33)) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now; drawn = now;
      const target = MOODS[moodRef.current];
      const k = still.matches ? 1 : 1 - Math.exp(-dt * 2.5);
      for (const key of Object.keys(p) as (keyof Params)[]) p[key] += (target[key] - p[key]) * k;
      if (!still.matches) {
        clock += dt * p.speed;
        scene.step(clock, dt * p.speed, p.work);
      }
      const light = document.documentElement.dataset.theme === "light";
      ctx.clearRect(0, 0, w, h);
      scene.paint(ctx, clock, p.work, light);
      if (p.clear > 0.01) {
        // fade out the reading column so messages stay easy to read
        const col = Math.min(860, w * 0.66), x0 = (w - col) / 2, fade = 140;
        const g = ctx.createLinearGradient(x0 - fade, 0, x0 + col + fade, 0);
        const span = col + 2 * fade;
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(fade / span, `rgba(0,0,0,${p.clear})`);
        g.addColorStop(1 - fade / span, `rgba(0,0,0,${p.clear})`);
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx.globalCompositeOperation = "destination-out";
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "source-over";
      }
      canvas.style.opacity = String(p.alpha * (light ? 0.75 : 1));
    };
    raf = requestAnimationFrame(frame);
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => { cancelAnimationFrame(raf); observer.disconnect(); };
  }, [id]);

  if (id === "off") return null;
  return <canvas ref={ref} aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" />;
}
