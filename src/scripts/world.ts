/**
 * The spatial world: camera, input, waypoints, minimap, view transitions.
 *
 * Design notes worth knowing before editing:
 *
 * - There is exactly one requestAnimationFrame loop, and it drives everything.
 *   Nothing else in the app schedules frames.
 * - The only properties written per frame are `transform` (composited) and a
 *   pair of custom properties on the world root. No layout, no paint, no
 *   getBoundingClientRect in the loop — all geometry is computed from camera
 *   maths against cached viewport dimensions.
 * - Every write is guarded by a cache check, so a settled world writes nothing
 *   and the loop parks itself.
 * - Smoothing and friction are exponentiated by delta time, so the motion is
 *   identical at 60Hz and 120Hz.
 */

import { ISLANDS, WORLD_PAD, worldScale, type Island } from "../data/islands";

/* ------------------------------------------------------------------ config */

const LERP_FREE = 0.115; // camera easing — wheel, touch pan and coasting alike
const FRICTION = 0.93; // per-16.67ms decay of flick momentum
const MIN_VEL = 0.04; // below this, momentum is considered spent
const WHEEL_GAIN = 1;
const RUBBER = 0.35; // input resistance once past the world edge
const RUBBER_BACK = 0.12; // spring-back rate when released past the edge

const WP_LERP = 0.45; // waypoint follow easing — high, so pills track the
// camera almost 1:1 (the camera is already eased; easing on top of easing is
// what read as the waypoints lagging behind the scroll)
const WP_EDGE_PAD_DESKTOP = 44;
const WP_EDGE_PAD_MOBILE = 26;
const WP_DOCK_GAP = 30; // gap between a docked waypoint and its island's top

const PARALLAX_MAX = 3.2; // px of extra offset per px/frame of camera velocity

type Vec = { x: number; y: number };

interface Tween {
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  start: number;
  dur: number;
  dip: number; // how far to dolly out at the midpoint (0 = none)
}

interface Waypoint {
  island: Island;
  el: HTMLElement;
  arrow: HTMLElement;
  // Rendered state, eased toward the per-frame target.
  x: number;
  y: number;
  s: number;
  a: number; // radians
  t: number; // arrival factor, 0 = far off-screen, 1 = docked on the island
  ready: boolean;
  lastTransform: string;
  lastArrow: string;
}

/* ------------------------------------------------------------------- state */

let booted = false;
let running = false;
let raf = 0;

let inited = false;
let stage: HTMLElement | null = null;
let worldEl: HTMLElement | null = null;
let minimapEl: HTMLElement | null = null;
let mmView: HTMLElement | null = null;
let coordsEl: HTMLElement | null = null;

let waypoints: Waypoint[] = [];
let islandEls: HTMLElement[] = [];
let mmIslandEls: HTMLElement[] = [];

const pos: Vec = { x: 0, y: 0 }; // rendered camera
const target: Vec = { x: 0, y: 0 }; // where the camera is heading
const vel: Vec = { x: 0, y: 0 }; // flick momentum
const smoothVel: Vec = { x: 0, y: 0 }; // eased, for parallax

let zoom = 1;
let tween: Tween | null = null;

let vw = 0;
let vh = 0;
let scale = 1;
let bounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
let placed: Array<Island & { px: number; py: number; pw: number; ph: number }> =
  [];

// Touch-only panning. Mouse users pan with the wheel/trackpad — a mouse drag
// used to exist, but pointer capture retargeted clicks to the stage and made
// most of the page unclickable, and the attached feel fought the scroll feel.
let panning = false;
let pointerId = -1;
let moved = 0;
const last: Vec = { x: 0, y: 0 };
let lastMoveTime = 0;

let reduceMotion = false;
let lastWorldTransform = "";
let lastCoords = "";
let coordTick = 0;

/** Set by an island click; tells the navigation hooks to arm a shared element. */
let armedSlug: string | null = null;

/* ------------------------------------------------------------------- utils */

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

/** Frame-rate-independent lerp factor. */
const fLerp = (base: number, dt: number) => 1 - Math.pow(1 - base, dt / 16.667);

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Interpolate angles the short way round, so arrows never spin the long way. */
function lerpAngle(a: number, b: number, t: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

const easeInOutQuart = (t: number) =>
  t < 0.5 ? 8 * t * t * t * t : 1 - Math.pow(-2 * t + 2, 4) / 2;

/* -------------------------------------------------------------- geometry */

/**
 * Recompute everything that depends on viewport size: the world scale, each
 * island's pixel position, the camera bounds, and the minimap projection.
 * Called on boot and on resize — never in the frame loop.
 */
function measure() {
  vw = window.innerWidth;
  vh = window.innerHeight;
  scale = worldScale(vw);

  placed = ISLANDS.map((i) => ({
    ...i,
    px: i.x * scale,
    py: i.y * scale,
    pw: i.w * scale,
    ph: i.h * scale,
  }));

  const pad = WORLD_PAD * scale;
  bounds = {
    minX: Math.min(...placed.map((i) => i.px - i.pw / 2)) - pad,
    maxX: Math.max(...placed.map((i) => i.px + i.pw / 2)) + pad,
    minY: Math.min(...placed.map((i) => i.py - i.ph / 2)) - pad,
    maxY: Math.max(...placed.map((i) => i.py + i.ph / 2)) + pad,
  };

  // Island geometry is CSS's job (see .island in world.css) — `placed` exists
  // only so the camera, waypoint and minimap maths agree with what CSS drew.
  layoutMinimap();
  lastWorldTransform = "";
}

/** Camera limits, so the world edge can't be dragged deep into the viewport. */
function camLimits() {
  const halfW = vw / 2 / zoom;
  const halfH = vh / 2 / zoom;
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;

  return {
    minX: spanX < vw / zoom ? cx : bounds.minX + halfW,
    maxX: spanX < vw / zoom ? cx : bounds.maxX - halfW,
    minY: spanY < vh / zoom ? cy : bounds.minY + halfH,
    maxY: spanY < vh / zoom ? cy : bounds.maxY - halfH,
  };
}

/** Apply a camera delta, resisted once the target is already past an edge. */
function pushTarget(dx: number, dy: number) {
  const lim = camLimits();
  const overX =
    target.x < lim.minX
      ? lim.minX - target.x
      : target.x > lim.maxX
        ? target.x - lim.maxX
        : 0;
  const overY =
    target.y < lim.minY
      ? lim.minY - target.y
      : target.y > lim.maxY
        ? target.y - lim.maxY
        : 0;

  target.x += overX > 0 ? dx * RUBBER : dx;
  target.y += overY > 0 ? dy * RUBBER : dy;
}

/* -------------------------------------------------------------- rendering */

function renderWorld() {
  if (!worldEl) return;

  // A world point (px, py) lands at (vw/2 + (px - cam.x) * z, ...), which this
  // single translate + scale expresses exactly. Translations are rounded to
  // whole pixels: a fractional translate3d makes the compositor resample the
  // whole layer, which is where the soft, never-quite-sharp look came from.
  const tx = Math.round(vw / 2 - pos.x * zoom);
  const ty = Math.round(vh / 2 - pos.y * zoom);
  const t = `translate3d(${tx}px, ${ty}px, 0) scale(${zoom.toFixed(4)})`;

  if (t === lastWorldTransform) return;
  lastWorldTransform = t;
  worldEl.style.transform = t;

  // Parallax feed for the islands. Clamped so a violent flick can't fling them
  // out of their own bounding boxes.
  worldEl.style.setProperty(
    "--vx",
    `${clamp(-smoothVel.x * 0.35, -PARALLAX_MAX, PARALLAX_MAX).toFixed(2)}px`,
  );
  worldEl.style.setProperty(
    "--vy",
    `${clamp(-smoothVel.y * 0.35, -PARALLAX_MAX, PARALLAX_MAX).toFixed(2)}px`,
  );
}

function renderWaypoints(now: number, dt: number) {
  const pad = vw < 640 ? WP_EDGE_PAD_MOBILE : WP_EDGE_PAD_DESKTOP;
  const dockGap = vw < 640 ? 18 : WP_DOCK_GAP;
  const k = fLerp(WP_LERP, dt);
  // Reference distance for the "closer = bigger" scaling.
  const ref = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 2;

  for (let idx = 0; idx < waypoints.length; idx++) {
    const w = waypoints[idx];
    const p = placed[idx];
    // Island centre, in screen space.
    const sx = vw / 2 + (p.px - pos.x) * zoom;
    const sy = vh / 2 + (p.py - pos.y) * zoom;
    const hh = (p.ph / 2) * zoom;

    // Arrival: the island's centre must sit inside a fixed-size zone around
    // the viewport centre — not merely be visible. Visibility-based docking
    // meant a large monitor docked (and bobbed) nearly every waypoint at once.
    const dockR = vw < 640 ? 180 : vw < 1200 ? 260 : 320;
    const dCentre = Math.hypot(sx - vw / 2, sy - vh / 2);
    const t = smoothstep(dockR * 1.2, dockR * 0.8, dCentre);

    // Off-screen: pinned to the viewport edge nearest the island.
    // Docked: sitting just above the island, arrow pointing down at it.
    const edgeX = clamp(sx, pad, vw - pad);
    const edgeY = clamp(sy, pad, vh - pad);
    const dockY = clamp(sy - hh - dockGap, pad, vh - pad);

    const tx = edgeX + (sx - edgeX) * t;
    const ty = edgeY + (dockY - edgeY) * t;

    // Point away from screen centre when hunting; point straight down (π/2)
    // once docked. The blend is what makes the arrow swing over the island.
    const dir = Math.atan2(sy - vh / 2, sx - vw / 2);
    const ta = lerpAngle(dir, Math.PI / 2, t);

    const dist = Math.hypot(p.px - pos.x, p.py - pos.y);
    const near = 1 - clamp(dist / ref, 0, 1);
    const ts = 0.74 + near * 0.26 + t * 0.06;

    if (!w.ready) {
      // First frame: snap, so waypoints don't fly in from the origin.
      w.x = tx;
      w.y = ty;
      w.s = ts;
      w.a = ta;
      w.t = t;
      w.ready = true;
    } else {
      w.x += (tx - w.x) * k;
      w.y += (ty - w.y) * k;
      w.s += (ts - w.s) * k;
      w.a = lerpAngle(w.a, ta, k);
      w.t += (t - w.t) * k;
    }

    // Subtle arrival bob, scaled by how docked it is.
    const bob = reduceMotion
      ? 0
      : Math.sin(now / 420 + p.px) * 4 * w.t;

    // Whole pixels for the same sharpness reason as the world transform.
    const transform = `translate3d(${Math.round(w.x)}px, ${Math.round(w.y + bob)}px, 0) scale(${w.s.toFixed(3)})`;
    if (transform !== w.lastTransform) {
      w.lastTransform = transform;
      w.el.style.transform = transform;
    }

    // The arrow orbits the pill: it sits on the pill's edge, on the side the
    // island is on, and rotates to match.
    const r = 20;
    const ax = Math.cos(w.a) * r;
    const ay = Math.sin(w.a) * r;
    const arrow = `translate3d(${ax.toFixed(1)}px, ${ay.toFixed(1)}px, 0) rotate(${w.a.toFixed(3)}rad)`;
    if (arrow !== w.lastArrow) {
      w.lastArrow = arrow;
      w.arrow.style.transform = arrow;
    }
  }
}

function layoutMinimap() {
  if (!minimapEl || !mmView) return;
  const mw = minimapEl.clientWidth;
  const mh = minimapEl.clientHeight;
  const wW = bounds.maxX - bounds.minX;
  const wH = bounds.maxY - bounds.minY;
  const k = Math.min(mw / wW, mh / wH) * 0.9;

  minimapEl.dataset.k = String(k);

  const toMapX = (px: number) => mw / 2 + (px - (bounds.minX + bounds.maxX) / 2) * k;
  const toMapY = (py: number) => mh / 2 + (py - (bounds.minY + bounds.maxY) / 2) * k;

  mmIslandEls.forEach((el, idx) => {
    const p = placed[idx];
    el.style.left = `${toMapX(p.px - p.pw / 2)}px`;
    el.style.top = `${toMapY(p.py - p.ph / 2)}px`;
    el.style.width = `${p.pw * k}px`;
    el.style.height = `${p.ph * k}px`;
  });

  // The viewport rectangle is the real viewport, projected — so it is
  // landscape on a desktop and portrait on a phone, with no special casing.
  mmView.style.width = `${(vw / zoom) * k}px`;
  mmView.style.height = `${(vh / zoom) * k}px`;
}

let lastMmTransform = "";

function renderMinimap() {
  if (!minimapEl || !mmView) return;
  const k = Number(minimapEl.dataset.k || 0);
  const mw = minimapEl.clientWidth;
  const mh = minimapEl.clientHeight;
  const x =
    mw / 2 + (pos.x - (bounds.minX + bounds.maxX) / 2) * k - (vw / zoom) * k / 2;
  const y =
    mh / 2 + (pos.y - (bounds.minY + bounds.maxY) / 2) * k - (vh / zoom) * k / 2;

  const t = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  if (t !== lastMmTransform) {
    lastMmTransform = t;
    mmView.style.transform = t;
  }
}

function renderCoords() {
  if (!coordsEl) return;
  // Throttled: the readout is the only text node that changes, and rewriting
  // it every frame is the one thing here that would cost layout.
  if (++coordTick % 4) return;
  const s = `x: ${pos.x.toFixed(1)} y: ${pos.y.toFixed(1)}`;
  if (s !== lastCoords) {
    lastCoords = s;
    coordsEl.textContent = s;
  }
}

/* ------------------------------------------------------------------- loop */

let lastFrame = 0;

function frame(now: number) {
  raf = requestAnimationFrame(frame);

  const dt = lastFrame ? Math.min(now - lastFrame, 50) : 16.667;
  lastFrame = now;

  const prevX = pos.x;
  const prevY = pos.y;

  if (tween) {
    const p = clamp((now - tween.start) / tween.dur, 0, 1);
    const e = easeInOutQuart(p);
    target.x = pos.x = tween.fromX + (tween.toX - tween.fromX) * e;
    target.y = pos.y = tween.fromY + (tween.toY - tween.fromY) * e;
    // Dolly out through the middle of the flight, back in on arrival. This is
    // what keeps a long jump from feeling like a teleport.
    zoom = 1 - Math.sin(p * Math.PI) * tween.dip;
    if (p >= 1) {
      tween = null;
      zoom = 1;
      vel.x = vel.y = 0;
      layoutMinimap();
    }
  } else {
    // Momentum from the last flick.
    if (Math.abs(vel.x) > MIN_VEL || Math.abs(vel.y) > MIN_VEL) {
      pushTarget(vel.x, vel.y);
      const f = Math.pow(FRICTION, dt / 16.667);
      vel.x *= f;
      vel.y *= f;
    } else {
      vel.x = vel.y = 0;
    }

    // Spring back inside the world once the pointer is released.
    if (!panning) {
      const lim = camLimits();
      const bx = clamp(target.x, lim.minX, lim.maxX);
      const by = clamp(target.y, lim.minY, lim.maxY);
      if (bx !== target.x || by !== target.y) {
        const kb = fLerp(RUBBER_BACK, dt);
        target.x += (bx - target.x) * kb;
        target.y += (by - target.y) * kb;
        vel.x *= 0.8;
        vel.y *= 0.8;
      }
    }

    const k = fLerp(LERP_FREE, dt);
    pos.x += (target.x - pos.x) * k;
    pos.y += (target.y - pos.y) * k;
  }

  const fx = pos.x - prevX;
  const fy = pos.y - prevY;
  const sk = fLerp(0.2, dt);
  smoothVel.x += (fx - smoothVel.x) * sk;
  smoothVel.y += (fy - smoothVel.y) * sk;

  renderWorld();
  renderWaypoints(now, dt);
  renderMinimap();
  renderCoords();

  // Park the loop when nothing is moving and no waypoint is docked (a docked
  // waypoint bobs, so it needs frames). Any input wakes it back up.
  const settled =
    !tween &&
    !panning &&
    Math.abs(target.x - pos.x) < 0.01 &&
    Math.abs(target.y - pos.y) < 0.01 &&
    Math.abs(vel.x) < MIN_VEL &&
    Math.abs(vel.y) < MIN_VEL &&
    Math.abs(smoothVel.x) < 0.01 &&
    Math.abs(smoothVel.y) < 0.01 &&
    !anyDocked();

  if (settled) stop();
}

function start() {
  if (running) return;
  running = true;
  lastFrame = 0;
  raf = requestAnimationFrame(frame);
}

function stop() {
  running = false;
  cancelAnimationFrame(raf);
}

/**
 * Waypoints bob while docked, so a world with an island on screen can never
 * fully park. Rather than special-casing that, we simply keep the loop alive
 * whenever any waypoint is docked — the work is a handful of transforms.
 */
function anyDocked() {
  return waypoints.some((w) => w.t > 0.02);
}

/* ------------------------------------------------------------------ camera */

function flyTo(x: number, y: number) {
  const lim = camLimits();
  const tx = clamp(x, lim.minX, lim.maxX);
  const ty = clamp(y, lim.minY, lim.maxY);
  const dist = Math.hypot(tx - pos.x, ty - pos.y);

  if (reduceMotion || dist < 4) {
    target.x = pos.x = tx;
    target.y = pos.y = ty;
    vel.x = vel.y = 0;
    tween = null;
    start();
    return;
  }

  const span = Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  tween = {
    fromX: pos.x,
    fromY: pos.y,
    toX: tx,
    toY: ty,
    start: performance.now(),
    dur: clamp(560 + dist * 0.42, 620, 1400),
    // Long hops dolly out more than short ones.
    dip: clamp(dist / span, 0, 1) * 0.13,
  };
  vel.x = vel.y = 0;
  start();
}

function cancelTween() {
  if (!tween) return;
  tween = null;
  zoom = 1;
  target.x = pos.x;
  target.y = pos.y;
  layoutMinimap();
}

/* ------------------------------------------------------------------- input */

function onWheel(e: WheelEvent) {
  e.preventDefault();
  cancelTween();
  // Trackpads report deltaMode 0 (pixels); mice often report 1 (lines).
  const unit = e.deltaMode === 1 ? 16 : 1;
  pushTarget(e.deltaX * unit * WHEEL_GAIN, e.deltaY * unit * WHEEL_GAIN);
  vel.x = vel.y = 0;
  start();
}

function onPointerDown(e: PointerEvent) {
  // Mouse pans with the wheel only. Capturing the mouse pointer here is what
  // used to swallow clicks (capture retargets the click to the stage).
  if (e.pointerType === "mouse") return;
  cancelTween();
  panning = true;
  pointerId = e.pointerId;
  moved = 0;
  last.x = e.clientX;
  last.y = e.clientY;
  lastMoveTime = performance.now();
  vel.x = vel.y = 0;
  start();
}

function onPointerMove(e: PointerEvent) {
  if (!panning || e.pointerId !== pointerId) return;

  const dx = e.clientX - last.x;
  const dy = e.clientY - last.y;
  last.x = e.clientX;
  last.y = e.clientY;
  moved += Math.abs(dx) + Math.abs(dy);

  pushTarget(-dx / zoom, -dy / zoom);

  // Track instantaneous velocity for the release flick. Normalised to a
  // 60Hz frame so the flick feels the same on a 120Hz screen.
  const now = performance.now();
  const dt = Math.max(1, now - lastMoveTime);
  lastMoveTime = now;
  vel.x = (-dx / zoom / dt) * 16.667;
  vel.y = (-dy / zoom / dt) * 16.667;
}

function onPointerUp(e: PointerEvent) {
  if (!panning || e.pointerId !== pointerId) return;
  panning = false;
  pointerId = -1;

  // A stale velocity from a pointer that stopped before lifting would fling
  // the world for no reason — drop it if the last move was a while ago.
  if (performance.now() - lastMoveTime > 90) vel.x = vel.y = 0;
  else {
    vel.x = clamp(vel.x, -60, 60);
    vel.y = clamp(vel.y, -60, 60);
  }
  start();
}

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement;
  if (t.closest("input, textarea, [contenteditable]")) return;

  const step = e.shiftKey ? 600 : 220;
  const map: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step],
  };
  const d = map[e.key];
  if (d) {
    e.preventDefault();
    cancelTween();
    pushTarget(d[0], d[1]);
    start();
  } else if (e.key === "Home") {
    e.preventDefault();
    flyTo(0, 0);
  }
}

/* ------------------------------------------------------------------ minimap */

function minimapToWorld(e: PointerEvent) {
  if (!minimapEl) return null;
  const r = minimapEl.getBoundingClientRect();
  const k = Number(minimapEl.dataset.k || 0);
  if (!k) return null;
  return {
    x: (e.clientX - r.left - r.width / 2) / k + (bounds.minX + bounds.maxX) / 2,
    y: (e.clientY - r.top - r.height / 2) / k + (bounds.minY + bounds.maxY) / 2,
  };
}

/* ------------------------------------- camera persistence + view transitions */

const CAM_KEY = "world:camera";
const SLUG_KEY = "world:active-island";

function saveCamera() {
  if (!worldEl) return;
  const cam = { x: target.x, y: target.y };
  try {
    sessionStorage.setItem(CAM_KEY, JSON.stringify(cam));
    history.replaceState({ ...history.state, worldCam: cam }, "");
  } catch {
    /* private mode — the session fallback above is best-effort anyway */
  }
}

function readCamera(): Vec | null {
  const fromHistory = history.state?.worldCam;
  if (fromHistory) return fromHistory;
  try {
    const raw = sessionStorage.getItem(CAM_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearSharedNames() {
  document
    .querySelectorAll<HTMLElement>("[data-vt-media]")
    .forEach((el) => (el.style.viewTransitionName = ""));
}

/** Give one island's media the shared name, so the browser morphs it. */
function armSharedName(slug: string | null) {
  document.querySelectorAll<HTMLElement>("[data-vt-media]").forEach((el) => {
    el.style.viewTransitionName =
      slug && el.dataset.vtMedia === slug ? "island-media" : "";
  });
}

/* -------------------------------------------------------------------- boot */

function initWorld() {
  if (inited) return;
  stage = document.querySelector(".stage");
  worldEl = document.querySelector(".world");
  if (!stage || !worldEl) return;
  inited = true;

  reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  islandEls = Array.from(document.querySelectorAll<HTMLElement>(".island"));
  minimapEl = document.querySelector(".minimap");
  mmView = document.querySelector(".mm-view");
  mmIslandEls = Array.from(document.querySelectorAll<HTMLElement>(".mm-island"));
  coordsEl = document.querySelector(".hud-coords");

  waypoints = Array.from(document.querySelectorAll<HTMLElement>(".waypoint")).map(
    (el, idx) => ({
      island: ISLANDS[idx],
      el,
      arrow: el.querySelector(".waypoint-arrow") as HTMLElement,
      x: 0,
      y: 0,
      s: 1,
      a: 0,
      t: 0,
      ready: false,
      lastTransform: "",
      lastArrow: "",
    }),
  );

  measure();

  // Restore the camera on a back navigation so the world is exactly where the
  // user left it — this has to happen before the first paint, or the shared
  // element morphs back to the wrong coordinates.
  const cam = readCamera();
  pos.x = target.x = cam?.x ?? 0;
  pos.y = target.y = cam?.y ?? 0;
  vel.x = vel.y = 0;
  zoom = 1;
  renderWorld();
  renderMinimap();
  minimapEl?.setAttribute("data-ready", "true");

  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove, { passive: true });
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerUp);
  window.addEventListener("keydown", onKey);

  // Islands: a drag that ends on an island must not count as a click.
  islandEls.forEach((el, idx) => {
    el.addEventListener("click", (e) => {
      if (moved > 8) {
        e.preventDefault();
        return;
      }
      armedSlug = placed[idx].slug;
      saveCamera();
      try {
        sessionStorage.setItem(SLUG_KEY, armedSlug);
      } catch {}
      armSharedName(armedSlug);
    });
  });

  // Waypoints fly the camera to their island.
  waypoints.forEach((w, idx) => {
    w.el.addEventListener("click", () => flyTo(placed[idx].px, placed[idx].py));
  });

  // Minimap: click or drag to move the camera.
  if (minimapEl) {
    let mmDown = false;
    minimapEl.addEventListener("pointerdown", (e) => {
      mmDown = true;
      minimapEl!.setPointerCapture(e.pointerId);
      const p = minimapToWorld(e);
      if (p) flyTo(p.x, p.y);
    });
    minimapEl.addEventListener("pointermove", (e) => {
      if (!mmDown) return;
      const p = minimapToWorld(e);
      if (!p) return;
      // Dragging the minimap tracks directly rather than flying, so scrubbing
      // across the map feels like a scrub and not six queued flights.
      cancelTween();
      const lim = camLimits();
      target.x = pos.x = clamp(p.x, lim.minX, lim.maxX);
      target.y = pos.y = clamp(p.y, lim.minY, lim.maxY);
      start();
    });
    const up = (e: PointerEvent) => {
      mmDown = false;
      try {
        minimapEl!.releasePointerCapture(e.pointerId);
      } catch {}
    };
    minimapEl.addEventListener("pointerup", up);
    minimapEl.addEventListener("pointercancel", up);
  }

  window.addEventListener("resize", onResize, { passive: true });

  start();
}

function onResize() {
  if (!worldEl) return;
  measure();
  const lim = camLimits();
  target.x = pos.x = clamp(pos.x, lim.minX, lim.maxX);
  target.y = pos.y = clamp(pos.y, lim.minY, lim.maxY);
  waypoints.forEach((w) => (w.ready = false));
  start();
}

function teardown() {
  if (!inited) return;
  inited = false;
  stop();
  if (stage) {
    stage.removeEventListener("wheel", onWheel);
    stage.removeEventListener("pointerdown", onPointerDown);
    stage.removeEventListener("pointermove", onPointerMove);
    stage.removeEventListener("pointerup", onPointerUp);
    stage.removeEventListener("pointercancel", onPointerUp);
  }
  window.removeEventListener("keydown", onKey);
  window.removeEventListener("resize", onResize);
  stage = worldEl = minimapEl = mmView = coordsEl = null;
  waypoints = [];
  islandEls = [];
  mmIslandEls = [];
  lastWorldTransform = "";
  lastMmTransform = "";
  lastCoords = "";
}

/* ------------------------------------------------------------------- menu */

/**
 * Fully delegated, so it survives navigations without re-binding. The menu
 * button is the one element that persists across every route, and re-binding
 * it per page-load is how you end up with N listeners after N navigations.
 */
function setMenu(open: boolean) {
  const btn = document.querySelector<HTMLElement>("[data-menu-button]");
  const panel = document.querySelector<HTMLElement>("[data-menu-panel]");
  if (!btn || !panel) return;
  panel.dataset.open = String(open);
  btn.setAttribute("aria-expanded", String(open));
}

function initMenuDelegation() {
  document.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const panel = document.querySelector<HTMLElement>("[data-menu-panel]");
    if (t.closest("[data-menu-button]")) {
      setMenu(panel?.dataset.open !== "true");
    } else if (!t.closest("[data-menu-panel]")) {
      setMenu(false);
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setMenu(false);
  });
}

/* ------------------------------------------------------ navigation lifecycle */

function boot() {
  if (booted) return;
  booted = true;

  initMenuDelegation();

  // Fires on the initial load and after every client-side navigation.
  document.addEventListener("astro:page-load", () => {
    setMenu(false);
    initWorld();
    if (anyDocked()) start();
  });

  // Fires before a navigation begins, while the old DOM is still live — this
  // is the last chance to influence the outgoing snapshot.
  document.addEventListener("astro:before-preparation", () => {
    saveCamera();
    // Any navigation that is *not* an island click (menu, back link) must not
    // leave a stale shared name behind, or the browser will try to morph an
    // island into nothing.
    if (!armedSlug) clearSharedNames();
    armedSlug = null;
  });

  // Fires with the incoming DOM already swapped in, but before the browser
  // takes the "new" snapshot — so restoring the camera here is what makes a
  // back navigation morph the hero straight back onto its island.
  document.addEventListener("astro:after-swap", () => {
    const world = document.querySelector<HTMLElement>(".world");
    if (world) {
      const cam = readCamera();
      const z = 1;
      const cx = cam?.x ?? 0;
      const cy = cam?.y ?? 0;
      world.style.transform = `translate3d(${window.innerWidth / 2 - cx * z}px, ${
        window.innerHeight / 2 - cy * z
      }px, 0) scale(${z})`;

      let slug: string | null = null;
      try {
        slug = sessionStorage.getItem(SLUG_KEY);
      } catch {}
      armSharedName(slug);
    }
  });

  document.addEventListener("astro:before-swap", teardown);
}

boot();

// This module is deferred, so it executes after the document has parsed but
// (usually) before the first paint — earlier than astro:page-load. Initialising
// here means the camera transform is already correct on the first painted
// frame. initWorld() is idempotent, so the page-load handler above is a no-op
// on a cold load and does the real work only after a client-side navigation.
if (document.readyState !== "loading") initWorld();
else document.addEventListener("DOMContentLoaded", initWorld, { once: true });
