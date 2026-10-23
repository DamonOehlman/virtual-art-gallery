'use strict';

// Live on-chain art, rendered over the 3D gallery.
//
// A fully on-chain generative piece carries its artwork as an HTML document
// (a `data:text/html` URI in `files[]`), not as a still. The WebGL renderer
// can only paint the cover, so a piece with live art gets an iframe composited
// over its wall position. The iframe is a flat rectangle; `css3d.js` computes
// the projective `matrix3d` that maps it onto the painting's projected quad,
// so it tracks the camera, perspective and wall angle every frame.
//
// Traps this module owns:
//
// - An iframe is always above the WebGL canvas, so a wall between the viewer
//   and the piece would be invisible if the iframe were left mounted. The
//   same ray test the gaze picker uses hides the piece instead.
// - A mounted iframe is an animation loop. Only the largest few visible
//   pieces are mounted; everything else keeps its cover. Unmounting removes
//   the element, which is the only way to stop the document.
// - The gallery only asks about pieces that are actually on screen, and only
//   once per piece per session (negative answers expire, because a reveal can
//   add art later).
// - Sandboxing is `allow-scripts` and nothing else: `allow-same-origin` on a
//   same-origin document would let the piece remove its own sandbox.

const mat4 = require('gl-mat4');
const nearestWallHit = require('./walls');
const css3d = require('./css3d');

const MAX_STAGES = 4;          // concurrent iframes (each is an animation loop)
const MAX_PROBES = 3;          // concurrent /gallery/art requests
const PROBE_WINDOW = 8;        // probe only the largest visible candidates
const MIN_SCREEN_H = 96;       // ignore pieces smaller than this on screen
const STAGE_HEIGHT = 640;      // iframe backing height, in CSS px
const STAGE_MAX_WIDTH = 1280;
const NONE_TTL = 2 * 60 * 1000;
const ERROR_TTL = 30 * 1000;
const WALL_EPS = 0.5;
const DEFAULT_WALL_HEIGHT = 7;
// Must match the near plane in fps.js (`mat4.perspective(..., 0.1, 100)`).
const NEAR_PLANE = 0.1;

const modelPoint = (m, x, y, z) => [
	m[0] * x + m[4] * y + m[8] * z + m[12],
	m[1] * x + m[5] * y + m[9] * z + m[13],
	m[2] * x + m[6] * y + m[10] * z + m[14]
];

const projectPoint = (mvp, x, y, z, w, h, out, o) => {
	const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
	if (cw <= 1e-4) return false;
	const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
	const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
	out[o] = (cx / cw * 0.5 + 0.5) * w;
	out[o + 1] = (0.5 - cy / cw * 0.5) * h;
	return true;
};

// The painting's front face is the model-space unit quad at z = 1. Return its
// four screen-space corners [TL, TR, BR, BL], or null if any corner is behind
// the camera (a quad crossing the camera plane has no useful homography).
const projectQuad = (mvp, w, h) => {
	const flat = new Array(8);
	if (!projectPoint(mvp, 0, 1, 1, w, h, flat, 0)) return null;
	if (!projectPoint(mvp, 1, 1, 1, w, h, flat, 2)) return null;
	if (!projectPoint(mvp, 1, 0, 1, w, h, flat, 4)) return null;
	if (!projectPoint(mvp, 0, 0, 1, w, h, flat, 6)) return null;
	return [
		[flat[0], flat[1]],
		[flat[2], flat[3]],
		[flat[4], flat[5]],
		[flat[6], flat[7]]
	];
};

const quadArea = (quad) => {
	let sum = 0;
	for (let i = 0; i < 4; i++) {
		const a = quad[i], b = quad[(i + 1) % 4];
		sum += a[0] * b[1] - b[0] * a[1];
	}
	return Math.abs(sum) * 0.5;
};

const signedArea = (poly) => {
	let area = 0;
	for (let i = 0; i < poly.length; i++) {
		const a = poly[i], b = poly[(i + 1) % poly.length];
		area += a[0] * b[1] - b[0] * a[1];
	}
	return area * 0.5;
};

// A closed subpath in the wrapper's screen coordinates. The nonzero fill rule
// subtracts a hole only when its winding is opposite the outer path, so the
// `hole` flag normalises the direction.
const polygonPath = (poly, hole) => {
	const area = signedArea(poly);
	if (Math.abs(area) < 0.5) return null;
	const points = (hole ? area > 0 : area < 0) ? poly.slice().reverse() : poly;
	let d = 'M' + points[0][0].toFixed(2) + ' ' + points[0][1].toFixed(2);
	for (let i = 1; i < points.length; i++) {
		d += 'L' + points[i][0].toFixed(2) + ' ' + points[i][1].toFixed(2);
	}
	return d + 'Z';
};

const clipW = (pv, p) =>
	pv[3] * p[0] + pv[7] * p[1] + pv[11] * p[2] + pv[15];

// One half-plane of a screen-space rectangle, in Sutherland-Hodgman form.
const clipHalf = (poly, axis, value, keepGreater) => {
	const out = [];
	for (let i = 0; i < poly.length; i++) {
		const p0 = poly[i];
		const p1 = poly[(i + 1) % poly.length];
		const a0 = p0[axis], a1 = p1[axis];
		const in0 = keepGreater ? a0 >= value : a0 <= value;
		const in1 = keepGreater ? a1 >= value : a1 <= value;
		if (in0 && in1) {
			out.push(p1);
		} else if (in0 !== in1) {
			const t = (value - a0) / (a1 - a0);
			out.push([
				p0[0] + (p1[0] - p0[0]) * t,
				p0[1] + (p1[1] - p0[1]) * t
			]);
			if (in1) out.push(p1);
		}
	}
	return out;
};

// Keep a wall polygon bounded by the painting's screen AABB. The wall can
// project far off-screen near the camera; the hole only matters where it
// overlaps the painting, and the bounded path is cheaper to rasterise.
const clipRect = (poly, minX, minY, maxX, maxY) => {
	let out = clipHalf(poly, 0, minX, true);
	if (out.length < 3) return out;
	out = clipHalf(out, 0, maxX, false);
	if (out.length < 3) return out;
	out = clipHalf(out, 1, minY, true);
	if (out.length < 3) return out;
	return clipHalf(out, 1, maxY, false);
};

// Sutherland-Hodgman against the near plane in homogeneous `w`. A wall can be
// much longer than the visible room and run past the camera; its far end is
// behind the near plane, and projecting the whole quad as a single polygon is
// not defined. Clip the face first, then project the part that is actually on
// screen.
const clipNear = (points, pv) => {
	const out = [];
	const n = points.length;
	for (let i = 0; i < n; i++) {
		const p0 = points[i];
		const p1 = points[(i + 1) % n];
		const w0 = clipW(pv, p0);
		const w1 = clipW(pv, p1);
		const in0 = w0 >= NEAR_PLANE;
		const in1 = w1 >= NEAR_PLANE;
		if (in0 && in1) {
			out.push(p1);
		} else if (in0 !== in1) {
			const t = (NEAR_PLANE - w0) / (w1 - w0);
			out.push([
				p0[0] + (p1[0] - p0[0]) * t,
				p0[1] + (p1[1] - p0[1]) * t,
				p0[2] + (p1[2] - p0[2]) * t
			]);
			if (in1) out.push(p1);
		}
	}
	return out;
};

// Project a wall face after clipping it to the near plane. Returns a convex
// screen polygon (3-5 points), or null when no part of the face is visible.
const projectWall = (pv, a, b, height, w, h) => {
	const clipped = clipNear([
		[a[0], 0, a[1]],
		[b[0], 0, b[1]],
		[b[0], height, b[1]],
		[a[0], height, a[1]]
	], pv);
	if (clipped.length < 3) return null;

	const flat = new Array(2);
	const out = [];
	for (let i = 0; i < clipped.length; i++) {
		const p = clipped[i];
		if (!projectPoint(pv, p[0], p[1], p[2], w, h, flat, 0)) return null;
		out.push([flat[0], flat[1]]);
	}
	return out;
};

module.exports = function (container, canvas, map) {
	const overlay = document.createElement('div');
	// `isolation` contains the per-iframe z-index used for depth ordering, so
	// an iframe can never paint over the host's HUD.
	overlay.style.cssText =
		'position:absolute;inset:0;overflow:hidden;pointer-events:none;isolation:isolate;';
	// The overlay is sized by the container; an absolutely positioned child
	// needs a positioned ancestor. Do not disturb a host that already has one.
	const containerPosition = window.getComputedStyle(container).position;
	if (!containerPosition || containerPosition === 'static') {
		container.style.position = 'relative';
	}
	container.appendChild(overlay);

	// image_id -> { status, src, retryAt, controller }
	// status: 'loading' | 'ready' | 'none' | 'error'
	const arts = new Map();
	// image_id -> { el, wrapper, width, height, clip }
	const mounted = new Map();

	let sourcePolicy = '';
	let enabled = false;
	let destroyed = false;
	let probesInFlight = 0;

	const unmount = (imageId) => {
		const stage = mounted.get(imageId);
		if (!stage) return;
		mounted.delete(imageId);
		if (stage.wrapper.parentNode) stage.wrapper.parentNode.removeChild(stage.wrapper);
	};

	const unmountAll = () => {
		for (const id of Array.from(mounted.keys())) unmount(id);
	};

	const abortProbes = () => {
		for (const entry of arts.values()) {
			if (!entry.controller) continue;
			try { entry.controller.abort(); } catch (e) { /* already settled */ }
			entry.controller = null;
		}
	};

	const reset = () => {
		abortProbes();
		arts.clear();
		unmountAll();
	};

	const startProbe = (imageId) => {
		const sep = imageId.indexOf(':');
		if (sep <= 0 || sep === imageId.length - 1) return;
		const policy = imageId.slice(0, sep);
		const name = imageId.slice(sep + 1);

		const entry = arts.get(imageId) || {};
		entry.status = 'loading';
		entry.src = undefined;
		entry.retryAt = 0;
		arts.set(imageId, entry);

		const controller = typeof AbortController !== 'undefined'
			? new AbortController()
			: null;
		entry.controller = controller;
		probesInFlight++;

		const url = '/gallery/art?policy=' + encodeURIComponent(policy) +
			'&name=' + encodeURIComponent(name);
		fetch(url, {
			cache: 'no-cache',
			signal: controller ? controller.signal : undefined
		}).then((r) => {
			// 204 is the ordinary answer: the piece is a still, not a document.
			if (r.status === 204) return null;
			if (!r.ok) throw new Error('live art ' + r.status);
			return r.json();
		}).then((json) => {
			if (destroyed) return;
			if (json && typeof json.src === 'string' && json.src) {
				entry.status = 'ready';
				entry.src = json.src;
				entry.retryAt = 0;
			} else {
				entry.status = 'none';
				entry.retryAt = Date.now() + NONE_TTL;
			}
		}).catch((err) => {
			if (destroyed) return;
			if (err && err.name === 'AbortError') return;
			entry.status = 'error';
			entry.retryAt = Date.now() + ERROR_TTL;
		}).finally(() => {
			entry.controller = null;
			probesInFlight--;
		});
	};

	const mount = (imageId, src, p) => {
		const existing = mounted.get(imageId);
		if (existing) return existing;

		const aspect = (typeof p.aspect === 'number' && isFinite(p.aspect) && p.aspect > 0)
			? p.aspect
			: 1;
		let height = STAGE_HEIGHT;
		let width = Math.max(1, Math.round(height * aspect));
		if (width > STAGE_MAX_WIDTH) {
			width = STAGE_MAX_WIDTH;
			height = Math.max(1, Math.round(width / aspect));
		}

		const wrapper = document.createElement('div');
		// The wrapper is the untransformed, full-stage plane the clip path is
		// expressed in. The iframe inside carries the 3D `matrix3d`, so a
		// screen-space cut (a wall in front) can be applied to the wrapper
		// without inverse-transforming the polygon into the iframe's UV space.
		wrapper.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
		wrapper.style.zIndex = '1';

		const el = document.createElement('iframe');
		el.setAttribute('sandbox', 'allow-scripts');
		el.setAttribute('referrerpolicy', 'no-referrer');
		el.setAttribute('title', p.title || imageId);
		el.style.cssText = [
			'position:absolute',
			'left:0',
			'top:0',
			'border:0',
			'margin:0',
			'padding:0',
			'background:transparent',
			'pointer-events:none',
			'transform-origin:0 0',
			'backface-visibility:hidden',
			'will-change:transform',
			'width:' + width + 'px',
			'height:' + height + 'px'
		].join(';') + ';';
		el.src = src;
		el.addEventListener('error', () => {
			unmount(imageId);
			const entry = arts.get(imageId);
			if (entry) {
				entry.status = 'error';
				entry.retryAt = Date.now() + ERROR_TTL;
			}
		});

		wrapper.appendChild(el);
		overlay.appendChild(wrapper);
		const stage = { el, wrapper, width, height, clip: '' };
		mounted.set(imageId, stage);
		return stage;
	};

	// The wall faces between the camera and a painting, projected to screen.
	// Sampling the painting at nine points (rather than only its centre) catches
	// a wall that cuts a corner: the centre ray can miss it while the corner ray
	// hits it. The wall quad itself is the hole; the exact visible region is the
	// painting quad minus these quads.
	const occluderQuads = (m, camPos, pv, w, h, bounds) => {
		const height = map.height || DEFAULT_WALL_HEIGHT;
		const seen = new Set();
		const quads = [];
		for (let iu = 0; iu < 3; iu++) {
			const u = 0.1 + iu * 0.4;
			for (let iv = 0; iv < 3; iv++) {
				const v = 0.1 + iv * 0.4;
				const pt = modelPoint(m, u, v, 1);
				const dx = pt[0] - camPos[0];
				const dz = pt[2] - camPos[2];
				const dist = Math.hypot(dx, dz);
				if (dist <= 1e-3) continue;

				const hits = nearestWallHit.segments(
					map, camPos[0], camPos[2], dx, dz, dist
				);
				for (let i = 0; i < hits.length; i++) {
					const seg = hits[i].seg;
					if (seen.has(seg)) continue;
					seen.add(seg);

					const a = seg[0], b = seg[1];
					const quad = projectWall(pv, a, b, height, w, h);
					if (!quad) continue;

					let minX = Infinity, maxX = -Infinity;
					let minY = Infinity, maxY = -Infinity;
					for (let j = 0; j < quad.length; j++) {
						const x = quad[j][0], y = quad[j][1];
						if (x < minX) minX = x;
						if (x > maxX) maxX = x;
						if (y < minY) minY = y;
						if (y > maxY) maxY = y;
					}
					if (maxX < bounds.minX || minX > bounds.maxX ||
						maxY < bounds.minY || minY > bounds.maxY) {
						continue;
					}

					const hole = clipRect(
						quad, bounds.minX, bounds.minY, bounds.maxX, bounds.maxY
					);
					if (hole.length < 3) continue;

					quads.push(hole);
					// A painting can only have a handful of walls across it. Bound
					// the path string for the pathological case.
					if (quads.length >= 8) return quads;
				}
			}
		}
		return quads;
	};

	// Apply the painting quad (outer) with the wall quads as holes. The
	// nonzero fill rule subtracts a hole whose winding is opposite the outer
	// path, which `polygonPath` normalises.
	const applyClip = (stage, quad, occluders) => {
		if (!occluders.length) {
			if (stage.clip) {
				stage.wrapper.style.clipPath = 'none';
				stage.clip = '';
			}
			return;
		}

		const outer = polygonPath(quad, false);
		if (!outer) return;
		const parts = [outer];
		for (let i = 0; i < occluders.length; i++) {
			const hole = polygonPath(occluders[i], true);
			if (hole) parts.push(hole);
		}
		const d = parts.join(' ');
		if (d === stage.clip) return;
		stage.clip = d;
		stage.wrapper.style.clipPath = "path('" + d + "')";
	};

	const update = (batch, view, proj, camPos) => {
		if (destroyed) return;
		if (!enabled || !batch || batch.length === 0) {
			if (mounted.size) unmountAll();
			return;
		}

		const w = canvas.clientWidth || container.clientWidth || 1;
		const h = canvas.clientHeight || container.clientHeight || 1;
		const pv = mat4.multiply([], proj, view);
		const mvp = [];
		const candidates = [];

		for (let i = 0; i < batch.length; i++) {
			const p = batch[i];
			const m = p.model;
			if (!m || !p.image_id) continue;

			const center = modelPoint(m, 0.5, 0.5, 1);
			const vx = camPos[0] - center[0];
			const vy = camPos[1] - center[1];
			const vz = camPos[2] - center[2];
			// The painting's front normal is the model's +z axis. A camera on
			// the wall's back side sees the quad mirrored, not the artwork.
			if (m[8] * vx + m[9] * vy + m[10] * vz <= 0) continue;

			const quad = projectQuad(mat4.multiply(mvp, pv, m), w, h);
			if (!quad) continue;

			let minX = Infinity, maxX = -Infinity;
			let minY = Infinity, maxY = -Infinity;
			for (let c = 0; c < 4; c++) {
				const x = quad[c][0], y = quad[c][1];
				if (x < minX) minX = x;
				if (x > maxX) maxX = x;
				if (y < minY) minY = y;
				if (y > maxY) maxY = y;
			}
			if (maxX < 0 || minX > w || maxY < 0 || minY > h) continue;
			if (maxY - minY < MIN_SCREEN_H) continue;

			const dx = center[0] - camPos[0];
			const dz = center[2] - camPos[2];
			const dist = Math.hypot(dx, dz);
			if (dist > 1e-3) {
				const wallT = nearestWallHit(map, camPos[0], camPos[2], dx, dz, dist);
				if (wallT !== null && wallT < dist - WALL_EPS) continue;
			}

			candidates.push({
				p,
				quad,
				area: quadArea(quad),
				dist,
				bounds: { minX, maxX, minY, maxY }
			});
		}

		// Largest on screen first: the piece the viewer is looking at wins,
		// and a far piece never takes a mount slot from a near one.
		candidates.sort((a, b) => b.area - a.area);

		for (let i = 0;
			i < candidates.length && i < PROBE_WINDOW && probesInFlight < MAX_PROBES;
			i++) {
			const imageId = candidates[i].p.image_id;
			const entry = arts.get(imageId);
			if (!entry) {
				startProbe(imageId);
			} else if ((entry.status === 'none' || entry.status === 'error') &&
				Date.now() >= entry.retryAt) {
				startProbe(imageId);
			}
		}

		const ready = [];
		for (let i = 0; i < candidates.length; i++) {
			const entry = arts.get(candidates[i].p.image_id);
			if (entry && entry.status === 'ready' && entry.src) {
				candidates[i].entry = entry;
				ready.push(candidates[i]);
			}
		}

		const keep = new Set();
		for (let i = 0; i < ready.length && i < MAX_STAGES; i++) {
			keep.add(ready[i].p.image_id);
		}
		for (const id of Array.from(mounted.keys())) {
			if (!keep.has(id)) unmount(id);
		}

		for (let i = 0; i < ready.length && i < MAX_STAGES; i++) {
			const c = ready[i];
			let stage = mounted.get(c.p.image_id);
			if (!stage) stage = mount(c.p.image_id, c.entry.src, c.p);
			if (!stage) continue;

			const matrix = css3d.matrix3d(c.quad, stage.width, stage.height);
			if (!matrix) {
				// Degenerate projection (a quad with no area); do not leave a
				// stale iframe hanging in the scene.
				unmount(c.p.image_id);
				continue;
			}
			stage.el.style.transform = matrix;
			// Nearer pieces paint over farther ones. Contained by the
			// overlay's `isolation`; the wrapper (not the iframe) owns the
			// stacking order because its clip path creates a context.
			stage.wrapper.style.zIndex = String(
				Math.max(1, Math.round(100000 - c.dist * 1000))
			);
			applyClip(
				stage,
				c.quad,
				occluderQuads(c.p.model, camPos, pv, w, h, c.bounds)
			);
		}
	};

	const setSource = (mode, policy) => {
		const nextMode = mode || '';
		const nextPolicy = policy || '';
		const nextEnabled =
			(nextMode === 'listed' || nextMode === 'collection') && !!nextPolicy;
		// A policy switch is a new collection: drop cached answers and in-flight
		// probes. A listed↔collection toggle keeps the cache — the pieces are
		// the same, only the set changes.
		if (nextPolicy !== sourcePolicy) reset();
		sourcePolicy = nextPolicy;
		enabled = nextEnabled;
		if (!enabled) unmountAll();
	};

	const destroy = () => {
		destroyed = true;
		abortProbes();
		arts.clear();
		unmountAll();
		if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
	};

	return { setSource, update, reset, destroy };
};
