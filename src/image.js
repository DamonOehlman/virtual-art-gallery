'strict mode';

const api = require('../api/api');
const params = new URLSearchParams(window.location.search);
// A ?source=listed:<policy> / collection:<policy> selects the live CO source;
// otherwise fall back to ?api=<provider> or the default (featured exhibition).
const source = params.get("source") || "";
const selectedApi = params.get("api");
const dataAccess = /^(listed|collection):/.test(source)
	? api.co
	: (api[selectedApi] || api[api.default]);
const text = require('./text');
const ticket = require('./ticket');

let paintingCache = {};
let unusedTextures = [];

// Progressive loading: base textures always load at 'low' (400px — the warmest
// IIIF cache tier) for instant display, then upgrade() re-uploads the high-res
// into the SAME texture object in place. Cap concurrent upgrades so background
// high-res fetches never starve fresh thumbnail loads or jank the main thread.
const maxConcurrentUpgrades = 2;
let upgradesInFlight = 0;

const dynamicQualThreshold = 2;
function dynamicQual(quality) {
	if(!navigator.connection || navigator.connection.downlink < dynamicQualThreshold) {
		quality = (quality == 'high') ? 'mid' : 'low';
	}
	return quality;
}

const resizeCanvas = document.createElement('canvas');
resizeCanvas.width = resizeCanvas.height = 2048;
const ctx = resizeCanvas.getContext('2d');
ctx.mozImageSmoothingEnabled = false;
ctx.webkitImageSmoothingEnabled = false;
let aniso = false;

const emptyImage = (regl) => [
	(unusedTextures.pop() || regl.texture)([[[200, 200, 200]]]),
	_=>(unusedTextures.pop() || regl.texture)([[[0, 0, 0, 0]]]),
	1
];

async function loadImage(regl, p, res) {
	if (aniso === false) {
		aniso = regl.hasExtension('EXT_texture_filter_anisotropic') ? regl._gl.getParameter(
			regl._gl.getExtension('EXT_texture_filter_anisotropic').MAX_TEXTURE_MAX_ANISOTROPY_EXT
		) : 0;
		console.log(aniso);
	}
	
	let image, title;
	try {
		const data = await dataAccess.fetchImage(p, dynamicQual(res));
		title = data.title;
		// Resize image to a power of 2 to use mipmap (faster than createImageBitmap resizing)
		image = await createImageBitmap(data.image);
		ctx.drawImage(image, 0, 0, resizeCanvas.width, resizeCanvas.height);
	} catch(e) {
		// Try again with a lower resolution, otherwise return an empty image
		console.error(e);
		return res == "high" ? await loadImage(regl, p, "low") : emptyImage(regl);
	}

	// Listed pieces get a swing ticket hanging off the frame corner (price tag).
	const tagGen = (p.listed && p.artist_title)
		? () => ticket.init((unusedTextures.pop() || regl.texture), p.artist_title)
		: null;

	return [(unusedTextures.pop() || regl.texture)({
			data: resizeCanvas,
			min: 'mipmap',
			mipmap: 'nice',
			aniso,
			flipY: true
		}),
		width=>text.init((unusedTextures.pop() || regl.texture), title, width),
		image.width / image.height,
		tagGen
	];
}

module.exports = {
	// Background-load status from the active provider (for the host shell's
	// "loading listings" affordance); providers without it report not-loading.
	progress: () => (dataAccess.progress ? dataAccess.progress() : { loading: false, total: null }),
	// The active provider's live source, when it is a collection walk. The
	// live-art overlay needs the policy to ask for a piece's on-chain document.
	source: () => (dataAccess.source ? dataAccess.source() : null),
	// Switch the live source: reset the provider (cursor/mode/policy) and drop
	// the painting cache so the next fetch repopulates from scratch. The placed
	// GPU textures are recycled by placement.reload(), which owns the batch.
	setSource: (mode, policy) => {
		if (dataAccess.setSource) dataAccess.setSource(mode, policy);
		paintingCache = {};
	},
	fetch: (regl, count = 10, res = "low", cbOne, cbAll) => {
		const from = Object.keys(paintingCache).length;
		dataAccess.fetchList(from, count).then(paintings => {
			// A page can legitimately contain no pieces (an index page of listing
			// artifacts, all filtered out). Clear `fetching` rather than leaving
			// the walk waiting for a callback that will never fire.
			if (paintings.length === 0) {
				cbAll();
				return;
			}
			count = paintings.length;
			paintings.map(p => {
				if (paintingCache[p.image_id]) {
					if (--count === 0)
						cbAll();
					return;
				}
				paintingCache[p.image_id] = p;
				// Base texture always loads at 'low'; upgrade() sharpens later.
				loadImage(regl, p, "low").then(([tex, textGen, aspect, tagGen]) => {
					cbOne({ ...p, tex, textGen, tagGen, aspect, res: "low" });
					if (--count === 0)
						cbAll();
				});
			})
		});
	},
	load: (regl, p, res = "low") => {
		if (p.tex || p.loading)
			return;
		p.loading = true;
		loadImage(regl, p, "low").then(([tex, textGen, , tagGen]) => {
			p.loading = false;
			p.tex = tex;
			p.res = "low";
			p.text = textGen(p.width);
			p.tag = tagGen ? tagGen() : undefined;
		});
	},
	// In-place progressive upgrade: fetch the piece at full quality and re-upload
	// into the existing texture object (same identity — the render batch never
	// notices). Skipped while loading/upgrading, once at target, or when the
	// concurrency budget is spent.
	upgrade: (regl, p) => {
		const target = dynamicQual("high");
		if (!p.tex || p.loading || p.upgrading || p.res === target)
			return;
		if (upgradesInFlight >= maxConcurrentUpgrades)
			return;
		p.upgrading = true;
		upgradesInFlight++;
		const tex = p.tex;
		(async () => {
			const data = await dataAccess.fetchImage(p, target);
			const image = await createImageBitmap(data.image);
			// No await between draw and upload — the shared canvas stays coherent.
			ctx.drawImage(image, 0, 0, resizeCanvas.width, resizeCanvas.height);
			// The piece may have been unloaded (texture recycled to the pool, and
			// possibly reused by another painting) while we fetched — only upload
			// if this texture still belongs to this piece.
			if (p.tex === tex) {
				tex({
					data: resizeCanvas,
					min: 'mipmap',
					mipmap: 'nice',
					aniso,
					flipY: true
				});
				p.res = target;
			}
		})().catch(e => {
			// Keep the low-res base; a later call may retry.
			console.error("upgrade failed", e);
		}).finally(() => {
			p.upgrading = false;
			upgradesInFlight--;
		});
	},
	unload: (p) => {
		if (p.tex) {
			unusedTextures.push(p.tex);
			p.tex = undefined;
		}
		if (p.text) {
			unusedTextures.push(p.text);
			p.text = undefined;
		}
		if (p.tag) {
			unusedTextures.push(p.tag);
			p.tag = undefined;
		}
	}
};