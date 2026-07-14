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

	// The visible painting most aligned with the camera forward vector (xz plane).
	const current = () => {
		const batch = placement.batch();
		if (!batch || batch.length === 0) return null;
		const px = fps.pos[0], pz = fps.pos[2];
		let fx = fps.forward[0], fz = fps.forward[2];
		const fl = Math.hypot(fx, fz) || 1;
		fx /= fl; fz /= fl;
		let best = null, bestDot = -Infinity;
		for (const p of batch) {
			const cx = (p.vseg[0][0] + p.vseg[1][0]) / 2;
			const cz = (p.vseg[0][1] + p.vseg[1][1]) / 2;
			let dx = cx - px, dz = cz - pz;
			const dl = Math.hypot(dx, dz) || 1;
			dx /= dl; dz /= dl;
			const dot = dx * fx + dz * fz;
			if (dot > bestDot) { bestDot = dot; best = p; }
		}
		// Require the piece to be reasonably in front of the viewer.
		if (!best || bestDot < 0.5) return null;
		return { image_id: best.image_id, title: best.title, artist_title: best.artist_title };
	};

	const camera = () => ({
		pos: [fps.pos[0], fps.pos[1], fps.pos[2]],
		yaw: fps.fmouse[1],
		pitch: fps.fmouse[0],
		forward: [fps.forward[0], fps.forward[1], fps.forward[2]]
	});

	return {
		canvas,
		current,
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
