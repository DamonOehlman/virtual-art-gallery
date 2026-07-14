"strict mode";

// Live gallery data source. Selected via ?source=<mode>:<policy_id>:
//   listed:<policy>     the live market floor (currently-listed pieces, with price)
//   collection:<policy> full collection membership (mitos-authoritative ownership)
//
// The projection is done server-side by the gallery worker's /gallery/source
// route (which calls the collection-ownership worker over a service binding), so
// this provider just fetches that same-origin endpoint. Images resolve through
// IIIF from the returned image_id (policy:asset_name_hex).

const iiifBase = "https://iiif.hodlcroft.com";
const resolutions = { low: 400, mid: 843, high: 1686 };

const source = new URLSearchParams(window.location.search).get("source") || "";
const sep = source.indexOf(":");
const mode = sep === -1 ? source : source.slice(0, sep); // "listed" | "collection"
const policyId = sep === -1 ? "" : source.slice(sep + 1);

// Opaque pagination cursor echoed from the worker (offset for listed, keyset for collection).
let nextCursor = null;

module.exports = {
  fetchList: async function (from, count) {
    if (!policyId) return [];
    let url = `/gallery/source?mode=${encodeURIComponent(mode)}&policy=${encodeURIComponent(policyId)}&count=${count}`;
    if (from > 0 && nextCursor != null) url += `&cursor=${encodeURIComponent(nextCursor)}`;
    const json = await fetch(url).then((r) => r.json());
    nextCursor = json.next_cursor != null ? json.next_cursor : null;
    return json.artworks || [];
  },

  fetchImage: async function (obj, advicedResolution) {
    const width = resolutions[advicedResolution];
    const url = `${iiifBase}/iiif/3/${obj.image_id}/full/${width},/0/default.jpg`;
    const blob = await fetch(url).then((r) => r.blob());
    return {
      // Price is NOT merged into the title — listed pieces get a separate gold
      // "FOR SALE · <price>" placard line (see image.js tagGen).
      title: obj.title,
      image: blob,
    };
  },
};
