'use strict';

// Nearest wall-segment hit along a horizontal ray (the xz plane). Used both by
// the gazer (`current()` in index.js) to reject a painting behind a wall and
// by the live-art overlay: an iframe is always composited over the WebGL
// canvas, so a piece in another room would otherwise show through the wall.
//
// `dx`/`dz` are a direction (normalised here), and `maxT` is a distance along
// it. `nearestWallHit` returns the nearest hit distance (or null);
// `nearestWallHit.segments` returns every hit closer than `maxT`, deduplicated
// by wall segment — the overlay needs the faces themselves, not just the
// distance, to clip the iframe.
//
// The intersection is evaluated as each grid cell's segments are read rather
// than collected first: the overlay runs this every frame, and the array it
// would otherwise build is pure garbage collection.

const scan = (mapObj, ox, oz, dx, dz, maxT, onHit) => {
	const sl = Math.hypot(dx, dz) || 1;
	dx /= sl; dz /= sl;
	const STEP = 4;
	for (let d = 0; d <= maxT + STEP; d += STEP) {
		const segs = mapObj.getGridSegments(ox + dx * d, oz + dz * d);
		for (let i = 0; i < segs.length; i++) {
			const seg = segs[i];
			const a = seg[0], b = seg[1];
			const ex = b[0] - a[0], ez = b[1] - a[1];
			const denom = dx * ez - dz * ex;
			if (Math.abs(denom) < 1e-6) continue;
			const aox = a[0] - ox, aoz = a[1] - oz;
			const t = (aox * ez - aoz * ex) / denom;
			const s = (aox * dz - aoz * dx) / denom;
			if (t <= 0 || s < 0 || s > 1) continue;
			onHit(t, seg);
		}
	}
};

const nearestWallHit = (mapObj, ox, oz, dx, dz, maxT) => {
	let minT = null;
	scan(mapObj, ox, oz, dx, dz, maxT, (t) => {
		if (minT === null || t < minT) minT = t;
	});
	return minT;
};

nearestWallHit.segments = (mapObj, ox, oz, dx, dz, maxT) => {
	const seen = new Set();
	const hits = [];
	scan(mapObj, ox, oz, dx, dz, maxT, (t, seg) => {
		if (t >= maxT || seen.has(seg)) return;
		seen.add(seg);
		hits.push({ t, seg });
	});
	return hits;
};

module.exports = nearestWallHit;
