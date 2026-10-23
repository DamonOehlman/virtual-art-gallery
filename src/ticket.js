'strict mode';

// "For sale" price ticket — a small card placed on the artwork's bottom-right
// corner, like a price sticker in a physical gallery. Drawn into a canvas
// texture and rendered on a small tilted quad (see placement.js).
//
// Canvas dimensions MUST be powers of two: the texture uses mipmaps, and WebGL1
// treats mipmapped non-POT textures as incomplete (samples opaque black).

const W = 512, H = 256;
const ticketCanvas = document.createElement('canvas');
ticketCanvas.width = W;
ticketCanvas.height = H;
const ctx = ticketCanvas.getContext('2d');

function roundRect(c, x, y, w, h, r) {
	c.beginPath();
	c.moveTo(x + r, y);
	c.arcTo(x + w, y, x + w, y + h, r);
	c.arcTo(x + w, y + h, x, y + h, r);
	c.arcTo(x, y + h, x, y, r);
	c.arcTo(x, y, x + w, y, r);
	c.closePath();
}

module.exports = {
	init(texture, priceText) {
		ctx.clearRect(0, 0, W, H);
		// Card, full bleed with rounded corners and a gold border.
		roundRect(ctx, 8, 8, W - 16, H - 16, 24);
		ctx.fillStyle = '#f7f2e7';
		ctx.fill();
		ctx.lineWidth = 10;
		ctx.strokeStyle = '#b8860b';
		ctx.stroke();
		// Copy.
		ctx.textBaseline = 'alphabetic';
		ctx.fillStyle = '#9a7b1e';
		ctx.font = 'bold 44px Verdana';
		ctx.fillText('FOR SALE', 40, 96);
		ctx.fillStyle = '#2b2b2b';
		// Auto-fit: shrink from 96px until the price fits the card width.
		const maxTextWidth = W - 80;
		let size = 96;
		ctx.font = `bold ${size}px Verdana`;
		while (size > 40 && ctx.measureText(priceText).width > maxTextWidth) {
			size -= 4;
			ctx.font = `bold ${size}px Verdana`;
		}
		ctx.fillText(priceText, 40, 212);

		return texture({
			data: ticketCanvas,
			min: 'mipmap',
			mipmap: 'nice',
			flipY: true
		});
	},
	draw(regl) {
		return regl({
			frag: `
			precision mediump float;
			uniform sampler2D tex;
			varying vec2 uv;
			void main () {
				vec4 c = texture2D(tex, uv);
				if (c.a < 0.01) discard;
				gl_FragColor = c;
			}`,
			vert: `
			precision highp float;
			uniform mat4 proj, view, model;
			uniform float yScale;
			attribute vec2 pos;
			varying vec2 uv;
			void main () {
				uv = pos;
				vec4 mpos = model * vec4(pos, 0.0, 1);
				mpos.y *= yScale;
				gl_Position = proj * view * mpos;
			}`,
			attributes: {
				pos: [0, 0, 1, 0, 0, 1, 1, 1, 0, 1, 1, 0]
			},
			uniforms: {
				model: regl.prop('model'),
				tex: regl.prop('tex')
			},
			count: 6,
			blend: {
				enable: true,
				func: {
					srcRGB: 'src alpha',
					srcAlpha: 'one minus src alpha',
					dstRGB: 'one minus src alpha',
					dstAlpha: 1
				},
				color: [0, 0, 0, 0]
			}
		});
	}
};
