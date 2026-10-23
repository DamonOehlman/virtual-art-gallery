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
// `let` (not `const`) — setSource() switches these at runtime for the live toggle.
let mode = sep === -1 ? source : source.slice(0, sep); // "listed" | "collection"
let policyId = sep === -1 ? "" : source.slice(sep + 1);

// Opaque pagination cursor echoed from the worker (offset for listed, keyset for collection).
let nextCursor = null;

// Background-load status for a "loading listings from Wayup…" affordance. The CO
// listings cache serves a fast first page then backfills the full set; `loading`
// stays true until the worker reports the set is complete.
let loading = false;
let total = null;
let statusPolling = false;

// While the listings are still backfilling, poll the worker to refresh the
// loading/total status even if the viewer stands still (fetchList is otherwise
// only pull-driven by movement). Cheap (count=1, served from KV) and
// self-terminating: stops when complete or after a bounded number of attempts.
function scheduleStatusPoll() {
  if (statusPolling || mode !== "listed" || !policyId) return;
  statusPolling = true;
  let attempts = 0;
  const tick = async () => {
    attempts++;
    try {
      const url = `/gallery/source?mode=${encodeURIComponent(mode)}&policy=${encodeURIComponent(policyId)}&count=1`;
      const json = await fetch(url).then((r) => r.json());
      loading = !!json.loading;
      if (json.total != null) total = json.total;
    } catch (e) {
      /* keep last known status */
    }
    if (loading && attempts < 12) {
      setTimeout(tick, 2000);
    } else {
      loading = false; // give up gracefully so the indicator never sticks
      statusPolling = false;
    }
  };
  setTimeout(tick, 2000);
}

module.exports = {
  fetchList: async function (from, count) {
    if (!policyId) return [];
    let url = `/gallery/source?mode=${encodeURIComponent(mode)}&policy=${encodeURIComponent(policyId)}&count=${count}`;
    if (from > 0 && nextCursor != null) url += `&cursor=${encodeURIComponent(nextCursor)}`;
    const json = await fetch(url).then((r) => r.json());
    nextCursor = json.next_cursor != null ? json.next_cursor : null;
    loading = !!json.loading;
    if (json.total != null) total = json.total;
    if (loading) scheduleStatusPoll();
    // `image_id` is `policy:asset_name_hex`. An empty name hex has no
    // addressable image or live document; a stale source must not turn it
    // into a IIIF 400 (or a `/gallery/art` probe).
    return (json.artworks || []).filter(
      (a) => a.image_id && !a.image_id.endsWith(":")
    );
  },

  // Background-load status for the host shell's progress affordance.
  progress: function () {
    return { loading, total };
  },

  // The live source this provider is walking. The renderer's live-art overlay
  // uses the policy to ask the gallery worker for a piece's on-chain document;
  // a provider without this method is not a collection walk and gets no
  // overlay.
  source: function () {
    return { mode, policyId };
  },

  // Switch the live source (listed↔collection / policy) at runtime; resets the
  // cursor + status so the next fetchList starts a fresh page walk.
  setSource: function (newMode, newPolicy) {
    mode = newMode;
    policyId = newPolicy;
    nextCursor = null;
    loading = false;
    total = null;
  },

  fetchImage: async function (obj, advicedResolution) {
    const width = resolutions[advicedResolution];
    // `.auto` — the service picks the container from what it knows the art to
    // be, so pixel-art collections arrive lossless rather than as a blurred
    // JPEG, with no redirect round trip. See api/cnft.js.
    const url = `${iiifBase}/iiif/3/${obj.image_id}/full/${width},/0/default.auto`;
    const blob = await fetch(url).then((r) => r.blob());
    return {
      // Price is NOT merged into the title — listed pieces get a separate gold
      // "FOR SALE · <price>" placard line (see image.js tagGen).
      title: obj.title,
      image: blob,
    };
  },
};
