'use strict';
const texture = require('./image');
const mat4 = require('gl-mat4');
const vec3 = require('gl-vec3');

const renderDist = 20;
const loadDist = 20;
const unloadDist = 40;
const fovxMargin = Math.PI/32;

const dynamicResPeriod = 3000;
let dynamicRes = "high";
let dynamicResTimer;

const culling = (ppos, pangle, fovx, {vseg, angle}) => {
    const sx1 = vseg[0][0] - ppos[0];
    const sy1 = vseg[0][1] - ppos[2];
    const sx2 = vseg[1][0] - ppos[0];
    const sy2 = vseg[1][1] - ppos[2];
    const angles = [angle, pangle - fovx/2 - fovxMargin + Math.PI/2, pangle + fovx/2 + fovxMargin - Math.PI/2];
    for(let a of angles) {
        const nx = Math.sin(a);
        const ny = -Math.cos(a);
        if(nx * sx1 + ny * sy1 < 0 && nx * sx2 + ny * sy2 < 0)
            return false;
    }
    return true;
};

module.exports = (regl, {placements, getAreaIndex}) => {
    //console.log(areas);
    let batch = [], shownBatch = [];
    let fetching = true;
    // Bumped on every source switch; in-flight fetches from a previous source
    // carry the old epoch and are dropped so they never leak into the new batch.
    let loadEpoch = 0;
    const loadPainting = (epoch) => (p) => {
        if (epoch !== loadEpoch) return; // stale fetch from a previous source
        const seg = placements[batch.length];
        // Calculate painting position, direction, normal angle and scale
        const dir = [seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]];
        const norm = [seg[1][1] - seg[0][1], seg[0][0] - seg[1][0]];
        const segLen = Math.hypot(dir[0], dir[1]);
        let globalScale = 4.5 / (3 + p.aspect); //tweaked to look good
        globalScale = Math.min(globalScale, segLen / p.aspect / 2.2); //clamp horizontal
        globalScale = Math.min(globalScale, 2 / 1.2); //clamp vertical
        const pos = [(seg[0][0] + seg[1][0]) / 2, 2.1 - globalScale, (seg[0][1] + seg[1][1]) / 2];
        const angle = Math.atan2(dir[1], dir[0]);
        const horiz = Math.abs(angle % 3) < 1 ? 1 : 0;
        const vert = 1 - horiz;
        const width = globalScale * p.aspect;
        const scale = [
            2 * width * horiz + 0.1 * vert,
            2 * globalScale,
            2 * width * vert + 0.1 * horiz];
        const text = p.textGen(width);
        const d1 = width / segLen;
        const d2 = 0.005 / Math.hypot(norm[0], norm[1]);
        // Visible painting segment for culling
        const vseg = [
            [pos[0] - dir[0] * d1 * 2, pos[2] - dir[1] * d1],
            [pos[0] + dir[0] * d1 * 2, pos[2] + dir[1] * d1]
        ];
        // Offset pos to account for painting width and depth
        pos[0] -= dir[0] * d1 + norm[0] * d2;
        pos[2] -= dir[1] * d1 + norm[1] * d2;
        // Calculate model matrix
        const model = [];
        mat4.fromTranslation(model, pos);
        mat4.scale(model, model, scale);
        mat4.rotateY(model, model, -angle);
        const textmodel = [];
        mat4.fromTranslation(textmodel, [pos[0], 1.7 - globalScale, pos[2]]);
        mat4.scale(textmodel, textmodel, [2,2,2]);
        mat4.rotateY(textmodel, textmodel, -angle);
        // Optional "for sale" ticket, placed ON the artwork at its bottom-right
        // corner like a price sticker in a physical gallery. Corners come from
        // the painting's own model matrix, so this works on every wall
        // orientation.
        let tag = null, tagmodel = null;
        if (p.tagGen) {
            const TICKET_W = 0.34, TICKET_H = 0.17, TILT = -0.05, INSET = 0.05;
            const c0 = vec3.transformMat4([], [0, 0, 1], model); // front bottom-left corner
            const c1 = vec3.transformMat4([], [1, 0, 1], model); // front bottom-right corner
            const b1 = vec3.transformMat4([], [1, 0, 0], model); // c1's back counterpart
            const along = vec3.normalize([], vec3.sub([], c1, c0)); // along the wall, left→right
            const out = vec3.normalize([], vec3.sub([], c1, b1));   // out of the wall
            tagmodel = [];
            // Pivot at the card's bottom-right, inset from the artwork corner and
            // lifted just off the face; the card extends up-left onto the image.
            mat4.fromTranslation(tagmodel, [
                c1[0] - along[0] * INSET + out[0] * 0.01,
                c1[1] + INSET,
                c1[2] - along[2] * INSET + out[2] * 0.01
            ]);
            mat4.rotateY(tagmodel, tagmodel, -angle);
            mat4.rotateZ(tagmodel, tagmodel, TILT);
            mat4.translate(tagmodel, tagmodel, [-TICKET_W, 0, 0]);
            mat4.scale(tagmodel, tagmodel, [TICKET_W, TICKET_H, 1]);
            tag = p.tagGen();
        }
        // Front-face vertical extent (world y), for accurate gaze ray hit-testing:
        // the model places the unit quad at pos[1]=2.1-globalScale with height 2*globalScale.
        batch.push({ ...p, vseg, angle, model, textmodel, text, tag, tagmodel, width, yLo: 2.1 - globalScale, yHi: 2.1 + globalScale, textGen:null, tagGen:null });
    };
    // Start a batch fetch tagged with the current epoch so a later source switch
    // can invalidate its in-flight callbacks.
    const startFetch = (count) => {
        const epoch = loadEpoch;
        fetching = true;
        texture.fetch(regl, count, "low", loadPainting(epoch), () => {
            if (epoch === loadEpoch) fetching = false;
        });
    };
    // Fetch the first textures (base loads are always low-res thumbnails;
    // upgrade() sharpens visible pieces in place once streaming settles)
    startFetch(20);
    return {
        update: (pos, angle, fovX) => {
            // Estimate player position index
            let index = getAreaIndex(pos[0], pos[2], 4);
            if (index === -1) return; // Out of bound => do nothing
            // Unload far textures
            batch.slice(0, Math.max(0, index - unloadDist)).map(t => texture.unload(t));
            batch.slice(index + unloadDist).map(t => texture.unload(t));
            // Load close textures
            shownBatch = batch.slice(Math.max(0, index - renderDist), index + renderDist);
            shownBatch.map(t => texture.load(regl, t, "low"));
            // Frustum / Orientation culling
            shownBatch = shownBatch.filter(t => t.tex && culling(pos, angle, fovX, t));
            // Progressively sharpen visible pieces once we're not actively
            // streaming a new area (dynamicRes drops to "low" while fetching and
            // flips back after 3s — reuse it as the upgrade gate). The per-piece
            // guards + concurrency cap in texture.upgrade make this cheap.
            if (dynamicRes === "high")
                shownBatch.map(t => texture.upgrade(regl, t));
            // Fetch new textures
            if (index <= batch.length - loadDist) return;
            if (!fetching) {
                startFetch(10);
            }
            // Update dynamic resolution
            dynamicRes = "low";
            if (dynamicResTimer) clearTimeout(dynamicResTimer);
            dynamicResTimer = setTimeout(() => dynamicRes = "high", dynamicResPeriod);
        },
        batch: () => shownBatch,
        // Clear the current scene and re-fetch from the start (used by a live
        // source switch). Bumps the epoch so any in-flight fetch from the old
        // source is dropped, unloads all placed textures back to the pool, then
        // kicks a fresh 20-piece fetch. The provider's cursor/cache must already
        // be reset (see texture.setSource) before calling this.
        reload: () => {
            loadEpoch++;
            batch.map(t => texture.unload(t));
            batch = [];
            shownBatch = [];
            startFetch(20);
        }
    };
};