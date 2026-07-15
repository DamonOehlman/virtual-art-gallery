'use strict';

// Virtual Art Gallery — embeddable entry point.
//
// Historically this module ran fullscreen on load and owned `document.body`.
// It is now a `mount(container)` factory published as `window.gallery`, so a host
// (e.g. a Leptos shell) can embed the regl canvas in a sub-region and drive it via
// direct calls. It still auto-mounts fullscreen for standalone/dev use unless the
// host sets `window.__GALLERY_MANUAL__ = true` before loading the bundle.

const mapVal = (value, min1, max1, min2, max2) =>
	min2 + (value - min1) * (max2 - min2) / (max1 - min1);

const isMobile = !!navigator.userAgent.match(/(iPad)|(iPhone)|(iPod)|(android)|(webOS)/i);

// Gaze / current-artwork tuning (see current() below): a distance-weighted pick
// with dual-cone hysteresis so the registered piece doesn't flicker between
// neighbours as you pan, and a pitch gate so looking at floor/ceiling registers nothing.
// Gaze / current-artwork tuning (see current() below). We raycast the exact
// screen-centre ray against each visible painting's wall segment and take the
// nearest hit — proper picking rather than a bearing heuristic.
const GAZE_Y_MIN = 0.3;   // vertical extent gate for a valid painting hit
const GAZE_Y_MAX = 3.8;
const GAZE_STICKY = 1.15; // keep the held piece if its hit is within this factor of nearest
const GAZE_WALL_EPS = 0.5; // a wall nearer than (paintingHit - this) occludes the piece

// Nearest wall-segment hit along the screen-centre ray (xz plane), used to reject
// painting hits that are behind a wall. Walls are gathered from the grid along the
// ray, mirroring the touch-teleport raycast's sampling.
const nearestWallHit = (mapObj, ox, oz, dx, dz, maxT) => {
	let sx = dx, sz = dz;
	const sl = Math.hypot(sx, sz) || 1;
	sx /= sl; sz /= sl;
	const walls = [];
	const STEP = 4;
	for (let d = 0; d <= maxT + STEP; d += STEP) {
		const segs = mapObj.getGridSegments(ox + sx * d, oz + sz * d);
		for (let i = 0; i < segs.length; i++) walls.push(segs[i]);
	}
	let minT = null;
	for (const seg of walls) {
		const a = seg[0], b = seg[1];
		const ex = b[0] - a[0], ez = b[1] - a[1];
		const denom = dx * ez - dz * ex;
		if (Math.abs(denom) < 1e-6) continue;
		const aox = a[0] - ox, aoz = a[1] - oz;
		const t = (aox * ez - aoz * ex) / denom;
		const s = (aox * dz - aoz * dx) / denom;
		if (t <= 0 || s < 0 || s > 1) continue;
		if (minT === null || t < minT) minT = t;
	}
	return minT;
};

function mount(container, opts = {}) {
	const useReflexion = opts.reflexion !== undefined ? opts.reflexion : !isMobile;
	const showStats = !!opts.stats;

	// Own canvas, mounted inside the host container (not document.body).
	const canvas = document.createElement('canvas');
	canvas.style.display = 'block';
	canvas.style.width = '100%';
	canvas.style.height = '100%';
	canvas.style.outline = 'none';
	container.appendChild(canvas);

	// Viewport = canvas client size (was window.innerWidth/innerHeight).
	const viewport = () => {
		const w = canvas.clientWidth || container.clientWidth || 1;
		const h = canvas.clientHeight || container.clientHeight || 1;
		return [w, h];
	};

	// FOV derived from the canvas aspect rather than the window aspect.
	const baseFovMin = isMobile ? 1.5 : 1.7;
	const fovX = () => {
		const [w, h] = viewport();
		return mapVal(w / h, 16 / 9, 9 / 16, baseFovMin, Math.PI / 3);
	};
	const fovY = () => {
		const [w, h] = viewport();
		return 2 * Math.atan(Math.tan(fovX() * 0.5) * h / w);
	};

	let stats = null;
	if (showStats) {
		const Stats = require('stats.js');
		stats = new Stats();
		stats.showPanel(0);
		container.appendChild(stats.dom);
	}

	// Size the drawing buffer before creating regl.
	const sizeCanvas = () => {
		const [w, h] = viewport();
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.max(1, Math.floor(w * dpr));
		canvas.height = Math.max(1, Math.floor(h * dpr));
	};
	sizeCanvas();

	const regl = require('regl')({
		canvas,
		extensions: [
			'OES_element_index_uint',
			'OES_standard_derivatives'
		],
		optionalExtensions: [
			'EXT_texture_filter_anisotropic'
		],
		attributes: { alpha: false }
	});

	const map = require('./map')();
	const mesh = require('./mesh');
	const texture = require('./image'); // provider-backed loader; exposes load progress
	const drawMap = mesh(regl, map, useReflexion);
	const placement = require('./placement')(regl, map);
	const drawPainting = require('./painting')(regl);
	const fps = require('./fps')(map, fovY, canvas, viewport);

	// Per-artwork presence glow intensity, keyed by image_id. Driven by the host
	// via the `setGlow` handle; applied per painting each frame.
	let glowMap = {};

	const context = regl({
		cull: { enable: true, face: 'back' },
		uniforms: {
			view: fps.view,
			proj: fps.proj,
			yScale: 1.0
		}
	});

	const reflexion = regl({
		cull: { enable: true, face: 'front' },
		uniforms: { yScale: -1.0 }
	});

	// regl only auto-resizes a canvas it creates itself; for a supplied canvas we
	// resize on container changes via ResizeObserver (window resize alone misses
	// layout-driven size changes in an embedded shell).
	const resize = () => {
		sizeCanvas();
		if (regl && regl.poll) regl.poll();
	};
	const ro = new ResizeObserver(resize);
	ro.observe(container);

	const loop = regl.frame(({ time }) => {
		if (stats) stats.begin();
		fps.tick({ time });
		placement.update(fps.pos, fps.fmouse[1], fovX());
		regl.clear({ color: [0, 0, 0, 1], depth: 1 });
		const batch = placement.batch();
		// Annotate each visible painting with its presence glow (0 when none).
		for (let i = 0; i < batch.length; i++) {
			batch[i].glow = glowMap[batch[i].image_id] || 0;
		}
		context(() => {
			if (useReflexion) {
				reflexion(() => {
					drawMap();
					drawPainting(batch);
				});
			}
			drawMap();
			drawPainting(batch);
		});
		if (stats) stats.end();
	});

	// The painting the viewer is looking at. Scores visible pieces by how centred
	// they are (dot with the camera forward, xz plane) minus a distance penalty, so
	// a near piece you're standing in front of wins over a far one dead-ahead. Uses
	// dual-cone hysteresis: a piece must be within the tight ACQUIRE cone to newly
	// register, but a registered piece is held until it drifts past the looser
	// RELEASE cone — this kills the neighbour-to-neighbour flicker.
	let lastCurrentId = null;
	let lastGazeDebug = null; // diagnostics surfaced via gazeDebug()
	const current = () => {
		const batch = placement.batch();
		if (!batch || batch.length === 0) { lastCurrentId = null; lastGazeDebug = { hit: null, count: 0 }; return null; }

		// Exact screen-centre ray (same construction the touch-teleport uses).
		const ray = fps.centerRay();
		const ox = ray.origin[0], oy = ray.origin[1], oz = ray.origin[2];
		const dx = ray.dir[0], dy = ray.dir[1], dz = ray.dir[2];

		let best = null, bestT = Infinity, held = null, heldT = Infinity;
		for (const p of batch) {
			// Ray vs the painting's vertical wall segment (xz), then y-extent gate.
			const a = p.vseg[0], b = p.vseg[1];
			const ex = b[0] - a[0], ez = b[1] - a[1];
			const denom = dx * ez - dz * ex;
			if (Math.abs(denom) < 1e-6) continue;
			const aox = a[0] - ox, aoz = a[1] - oz;
			const t = (aox * ez - aoz * ex) / denom; // distance along the ray
			const s = (aox * dz - aoz * dx) / denom; // param along the segment [0,1]
			if (t <= 0 || s < 0 || s > 1) continue;
			const yHit = oy + t * dy;
			// Gate against the piece's real vertical extent (falls back to a loose band).
			const yLo = (p.yLo !== undefined) ? p.yLo : GAZE_Y_MIN;
			const yHi = (p.yHi !== undefined) ? p.yHi : GAZE_Y_MAX;
			if (yHit < yLo || yHit > yHi) continue;
			if (p.image_id === lastCurrentId) { held = p; heldT = t; }
			if (t < bestT) { bestT = t; best = p; }
		}

		// Light stickiness so the pick doesn't flip at the seam between two pieces.
		let chosen = best, chosenT = bestT;
		if (held && heldT <= bestT * GAZE_STICKY) { chosen = held; chosenT = heldT; }

		// Occlusion: reject the hit if a wall blocks the ray nearer than the piece.
		let occludedBy = null;
		if (chosen) {
			const wallT = nearestWallHit(map, ox, oz, dx, dz, chosenT);
			if (wallT !== null && wallT < chosenT - GAZE_WALL_EPS) {
				occludedBy = wallT;
				chosen = null;
			}
		}

		lastGazeDebug = {
			hit: chosen ? { image_id: chosen.image_id, t: +chosenT.toFixed(2) } : null,
			occludedBy: occludedBy !== null ? +occludedBy.toFixed(2) : null,
			ray: [+dx.toFixed(2), +dy.toFixed(2), +dz.toFixed(2)],
			count: batch.length
		};
		if (!chosen) { lastCurrentId = null; return null; }
		lastCurrentId = chosen.image_id;
		return {
			image_id: chosen.image_id,
			title: chosen.title,
			artist_title: chosen.artist_title,
			listed: !!chosen.listed,
			// CO-backed sources carry trait + rarity metadata straight through the
			// artwork object (placement spreads `...p`); surface it for the HUD plaque.
			traits: chosen.traits || null,
			rarity_rank: chosen.rarity_rank != null ? chosen.rarity_rank : null,
		};
	};

	// Open the for-sale piece under the crosshair on its Wayup asset page. Returns
	// true if a listing was opened. image_id is "policy:asset_name_hex", which maps
	// directly to Wayup's /collection/{policy}/asset/{assetHex} route.
	const openFocused = () => {
		const c = current();
		if (!c || !c.listed || !c.image_id) return false;
		const idx = c.image_id.indexOf(':');
		if (idx < 0) return false;
		const policy = c.image_id.slice(0, idx);
		const hex = c.image_id.slice(idx + 1);
		if (!policy || !hex) return false;
		window.open(`https://www.wayup.io/collection/${policy}/asset/${hex}`, '_blank', 'noopener');
		return true;
	};

	// Click a for-sale piece → open its Wayup listing, but ONLY on a click made
	// while already exploring — not on the click that (re)acquires pointer lock.
	// requestPointerLock is async, so a click that arms the lock can already read
	// pointerLockElement === canvas by the time `click` fires (e.g. returning to
	// the tab from Wayup). Snapshot the lock state at mousedown instead: it still
	// holds the pre-click value there, so an arming/re-arming click reads "unlocked"
	// and is ignored.
	let lockedAtPointerDown = false;
	canvas.addEventListener('mousedown', () => {
		lockedAtPointerDown = document.pointerLockElement === canvas;
	});
	canvas.addEventListener('click', () => {
		if (!lockedAtPointerDown) return;
		if (document.pointerLockElement !== canvas) return;
		openFocused();
	});

	const camera = () => ({
		pos: [fps.pos[0], fps.pos[1], fps.pos[2]],
		yaw: fps.fmouse[1],
		pitch: fps.fmouse[0],
		forward: [fps.forward[0], fps.forward[1], fps.forward[2]]
	});

	return {
		canvas,
		current,
		// Open the focused for-sale piece's Wayup listing (also wired to canvas click).
		openFocused,
		// Background listings-load status: { loading, total } for the host HUD.
		loadProgress: () => texture.progress(),
		// Switch the live data source (e.g. listed↔collection) without a page
		// reload: reset the provider + cache, then rebuild the scene from 0.
		setSource: (mode, policy) => { texture.setSource(mode, policy); placement.reload(); },
		// Diagnostics for tuning the gaze pick: top-aligned piece (ungated) + pitch.
		gazeDebug: () => lastGazeDebug,
		camera,
		setInputEnabled: (b) => fps.setInputEnabled(b),
		// Presence glow: map of image_id → intensity (0..1). Applied per painting.
		setGlow: (glowByImageId) => { glowMap = glowByImageId || {}; },
		resize,
		unmount: () => {
			loop.cancel();
			ro.disconnect();
			fps.destroy();
			regl.destroy();
			if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
			if (stats && stats.dom.parentNode) stats.dom.parentNode.removeChild(stats.dom);
		}
	};
}

// Public handle. Methods proxy to the active instance so a host can call them
// before/after mount without holding the returned object.
let active = null;
const gallery = {
	mount(container, opts) {
		if (active) active.unmount();
		active = mount(container || document.body, opts);
		return active;
	},
	isMounted: () => !!active,
	current: () => (active ? active.current() : null),
	openFocused: () => (active ? active.openFocused() : false),
	loadProgress: () => (active ? active.loadProgress() : { loading: false, total: null }),
	setSource: (mode, policy) => { if (active) active.setSource(mode, policy); },
	gazeDebug: () => (active ? active.gazeDebug() : null),
	camera: () => (active ? active.camera() : null),
	setInputEnabled: (b) => { if (active) active.setInputEnabled(b); },
	setGlow: (m) => { if (active) active.setGlow(m); },
	resize: () => { if (active) active.resize(); },
	unmount: () => { if (active) { active.unmount(); active = null; } }
};
window.gallery = gallery;

// Standalone / dev auto-mount (preserves `npm start`). Opt out with
// window.__GALLERY_MANUAL__ = true (set by the embedding shell before load).
if (!window.__GALLERY_MANUAL__) {
	const boot = () => {
		document.body.style.margin = '0';
		let root = document.getElementById('gallery-root');
		if (!root) {
			root = document.createElement('div');
			root.style.cssText = 'position:fixed;inset:0;';
			document.body.appendChild(root);
		}
		gallery.mount(root, { stats: false });
	};
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', boot);
	} else {
		boot();
	}
}

module.exports = gallery;
