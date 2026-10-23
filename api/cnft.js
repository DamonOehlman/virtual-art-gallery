"strict mode";

// CNFT Gallery API
// Connects to the CNFT assets worker gallery endpoints
const assetsBaseURL = "https://assets.hodlcroft.com";
const resolutions = { low: 400, mid: 843, high: 1686 };

module.exports = {
  fetchList: async function (from, count) {
    const url = `${assetsBaseURL}/gallery/featured?from=${from}&count=${count}`;
    const json = await fetch(url).then((res) => res.json());
    // Drop entries with no addressable asset name: `policy:` is not an image.
    return json.artworks.filter(
      (d) => d.image_id && !d.image_id.endsWith(":")
    );
  },
  fetchImage: async function (obj, advicedResolution) {
    const width = resolutions[advicedResolution];
    // Use IIIF Image API directly: {base}/{policy}:{asset}/full/{width},/0/default.auto
    //
    // `.auto` lets the service pick the container from what it knows the art
    // to be. Pixel-art collections come back lossless instead of a blurred
    // JPEG; asking for `.jpg` explicitly earns a redirect to the right one,
    // which is a wasted round trip per image on a wall full of them.
    const url = `https://iiif.hodlcroft.com/iiif/3/${obj.image_id}/full/${width},/0/default.auto`;
    const blob = await fetch(url).then((res) => res.blob());
    return {
      title: obj.title + (obj.artist_title ? " - " + obj.artist_title : ""),
      image: blob,
    };
  },
};
