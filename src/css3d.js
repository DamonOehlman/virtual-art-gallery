'use strict';

// Projective mapping for a flat HTML element placed over a 3D painting.
//
// The painting is a unit quad in model space, so its four corners project to
// four points on screen. `homography` returns the coefficients of the mapping
// from the unit square onto that screen quad:
//
//   x = (a*u + b*v + c) / (g*u + h*v + 1)
//   y = (d*u + e*v + f) / (g*u + h*v + 1)
//
// and `matrix3d` turns those into the CSS transform for an element of
// `width` x `height` CSS pixels. The quad is ordered
// [top-left, top-right, bottom-right, bottom-left] — the order the classic
// eight-unknowns formula assumes.
//
// `matrix3d` is column-major, so the arguments are the columns of
//
//   | a/W   b/H   0  c |
//   | d/W   e/H   0  f |
//   |  0     0    1  0 |
//   | g/W   h/H   0  1 |

function homography(quad) {
	const [p0, p1, p2, p3] = quad;
	const x0 = p0[0], y0 = p0[1];
	const x1 = p1[0], y1 = p1[1];
	const x2 = p2[0], y2 = p2[1];
	const x3 = p3[0], y3 = p3[1];

	const dx1 = x1 - x2;
	const dx2 = x3 - x2;
	const dx3 = x0 - x1 + x2 - x3;
	const dy1 = y1 - y2;
	const dy2 = y3 - y2;
	const dy3 = y0 - y1 + y2 - y3;

	// Affine is the common case — a wall square-on to the camera — and the
	// projective formula would divide by zero there.
	if (dx3 === 0 && dy3 === 0) {
		return {
			a: x1 - x0,
			b: x3 - x0,
			c: x0,
			d: y1 - y0,
			e: y3 - y0,
			f: y0,
			g: 0,
			h: 0
		};
	}

	const den = dx1 * dy2 - dx2 * dy1;
	if (Math.abs(den) < 1e-9) return null;

	const g = (dx3 * dy2 - dx2 * dy3) / den;
	const h = (dx1 * dy3 - dx3 * dy1) / den;
	return {
		a: x1 - x0 + g * x1,
		b: x3 - x0 + h * x3,
		c: x0,
		d: y1 - y0 + g * y1,
		e: y3 - y0 + h * y3,
		f: y0,
		g,
		h
	};
}

function matrix3d(quad, width, height) {
	const m = homography(quad);
	if (!m) return null;
	const { a, b, c, d, e, f, g, h } = m;
	return 'matrix3d(' + [
		a / width, d / width, 0, g / width,
		b / height, e / height, 0, h / height,
		0, 0, 1, 0,
		c, f, 0, 1
	].join(',') + ')';
}

module.exports = { homography, matrix3d };
