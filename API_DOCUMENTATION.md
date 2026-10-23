# Virtual Art Gallery - API Documentation

## Overview

The Virtual Art Gallery requires an API that provides two main endpoints:
1. **Fetch List** - Returns a paginated list of artworks with metadata
2. **Fetch Image** - Returns the actual image and title for a specific artwork

The gallery uses a modular API system where you can implement custom data sources by creating a module that exports these two functions.

## API Interface

Your API module must export an object with two async functions:

```javascript
module.exports = {
    fetchList: async function (from, count) { ... },
    fetchImage: async function (obj, advicedResolution) { ... }
};
```

---

## 1. fetchList(from, count)

Returns a paginated list of artworks with their metadata.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `from` | number | Starting index for pagination (0-based) |
| `count` | number | Number of items to return (typically 10-20) |

### Return Value

Returns a **Promise** that resolves to an **Array of Objects**, where each object contains:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `image_id` | string/number | **Yes** | Unique identifier for the artwork. Used to fetch the actual image. |
| `title` | string | Optional | Title of the artwork (used in display) |
| `artist_title` | string | Optional | Artist name (used in display) |

### Important Notes

- The gallery filters out any items that don't have an `image_id`, so ensure all returned items include this field
- The gallery calls this function progressively as users navigate through the gallery
- First call typically requests 20 items, subsequent calls request 10 items

### Example Implementation

```javascript
fetchList: async function (from, count) {
    const url = `https://your-api.com/artworks?offset=${from}&limit=${count}`;
    const json = await fetch(url).then(res => res.json());
    
    // Transform your API response to match the required format
    return json.artworks.map(artwork => ({
        image_id: artwork.id,
        title: artwork.name,
        artist_title: artwork.artist
    })).filter(item => item.image_id); // Filter out items without image_id
}
```

---

## 2. fetchImage(obj, advicedResolution)

Fetches the actual image data for a specific artwork.

### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `obj` | Object | The artwork object returned by `fetchList` (contains `image_id`, `title`, etc.) |
| `advicedResolution` | string | Suggested resolution: `"low"` (400px), `"mid"` (843px), or `"high"` (1686px) |

### Return Value

Returns a **Promise** that resolves to an **Object** with:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | **Yes** | Full title to display (e.g., "Starry Night - Vincent van Gogh") |
| `image` | Blob | **Yes** | Image data as a Blob object |

### Important Notes

- The `advicedResolution` parameter is a hint based on network conditions and user movement
  - `"low"` - User is moving or has slow connection (< 2 Mbps)
  - `"mid"` - Medium quality
  - `"high"` - User is stationary, high quality desired
- Your API should try to provide images at or near the suggested resolution for optimal performance
- If a resolution fails, the gallery will automatically retry with a lower resolution
- Images are resized client-side to 2048x2048 maximum and converted to mipmaps

### Example Implementation

```javascript
fetchImage: async function (obj, advicedResolution) {
    const resolutions = {"low": 400, "mid": 843, "high": 1686};
    const width = resolutions[advicedResolution];
    
    const url = `https://your-api.com/images/${obj.image_id}/width/${width}`;
    const blob = await fetch(url).then(res => res.blob());
    
    return {
        title: `${obj.title} - ${obj.artist_title}`,
        image: blob
    };
}
```

---

## Dynamic Resolution Selection

The gallery automatically adjusts requested resolution based on:

1. **Network conditions** - If `navigator.connection.downlink < 2` Mbps:
   - `"high"` → downgraded to `"mid"`
   - `"mid"` → downgraded to `"low"`

2. **User movement** - When user is navigating:
   - Requests `"low"` resolution by default
   - After 3 seconds of no movement, upgrades to `"high"` resolution

---

## Integration Guide

### Step 1: Create Your API Module

Create a new file in the `api/` directory (e.g., `api/workers.js`):

```javascript
'strict mode';

const resolutions = {"low": 400, "mid": 843, "high": 1686};

module.exports = {
    fetchList: async function (from, count) {
        const url = `https://your-worker.workers.dev/artworks?from=${from}&count=${count}`;
        const json = await fetch(url).then(res => res.json());
        return json.artworks.filter((d) => d.image_id);
    },
    
    fetchImage: async function (obj, advicedResolution) {
        const width = resolutions[advicedResolution];
        const url = `https://your-worker.workers.dev/image/${obj.image_id}?width=${width}`;
        const blob = await fetch(url).then(res => res.blob());
        
        return {
            title: obj.title + " - " + obj.artist_title,
            image: blob
        };
    }
};
```

### Step 2: Register Your API

Edit `api/api.js` to register your new API:

```javascript
'strict mode';

module.exports = {
    default: "artic",
    artic: require("./artic"),
    local: require("./local"),
    workers: require("./workers")  // Add your API here
};
```

### Step 3: Use Your API

Access the gallery with the `api` query parameter:

```
http://localhost:9966/?api=workers
```

---

## Reference Implementation: Art Institute of Chicago

The included `api/artic.js` demonstrates a real-world implementation using the Art Institute of Chicago's public API:

```javascript
const searchURL = 'https://api.artic.edu/api/v1/artworks/search';
const imageURL = ({image_id}, res) => 
    `https://www.artic.edu/iiif/2/${image_id}/full/${res},/0/default.jpg`;

const query = '?query[bool][must][][term][classification_titles.keyword]=painting' +
              '&query[bool][must][][term][is_public_domain]=true';
const fields = '&fields=image_id,title,artist_title';
const resolutions = {"low": 400, "mid": 843, "high": 1686};

module.exports = {
    fetchList: async function (from, count) {
        const url = searchURL + query + fields + `&from=${from}&size=${count}`;
        const json = await fetch(url).then(res => res.json());
        return json.data.filter((d) => d.image_id);
    },
    
    fetchImage: async function (obj, advicedResolution) {
        const url = imageURL(obj, resolutions[advicedResolution]);
        const blob = await fetch(url).then(res => res.blob());
        return {
            title: obj.title + " - " + obj.artist_title,
            image: blob
        };
    }
};
```

---

## Performance Considerations

### Caching
- The gallery caches artwork metadata after initial fetch
- Textures are loaded/unloaded dynamically based on user position
- Images within 20 placements are loaded, beyond 40 are unloaded

### Batch Loading
- Initial load: 20 artworks
- Progressive loading: 10 artworks at a time
- Loading triggers when user is within 20 placements of the end

### Error Handling
- If `fetchImage` fails at "high" resolution, it automatically retries with "low"
- If both fail, displays a gray placeholder image
- Network errors are logged to console

---

## Cloudflare Workers Example

Here's a complete example for implementing this API using Cloudflare Workers:

```javascript
// workers.js - Cloudflare Worker
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})

async function handleRequest(request) {
  const url = new URL(request.url)
  
  // Add CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
  
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }
  
  // GET /artworks?from=0&count=10
  if (url.pathname === '/artworks') {
    const from = parseInt(url.searchParams.get('from') || '0')
    const count = parseInt(url.searchParams.get('count') || '10')
    
    // Fetch from your data source (KV, D1, external API, etc.)
    const artworks = await getArtworks(from, count)
    
    return new Response(JSON.stringify({ artworks }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
  
  // GET /image/:id?width=400
  if (url.pathname.startsWith('/image/')) {
    const imageId = url.pathname.split('/')[2]
    const width = url.searchParams.get('width') || '400'
    
    // Fetch and optionally resize image
    const imageBlob = await getImage(imageId, width)
    
    return new Response(imageBlob, {
      headers: { ...corsHeaders, 'Content-Type': 'image/jpeg' }
    })
  }
  
  return new Response('Not Found', { status: 404 })
}

async function getArtworks(from, count) {
  // Your implementation here
  // Could use KV.list(), D1 query, or external API
}

async function getImage(imageId, width) {
  // Your implementation here
  // Could use R2, Images API, or external source
}
```

---

## Testing Your API

1. **Test fetchList locally:**
```javascript
const api = require('./api/workers.js');
api.fetchList(0, 10).then(console.log);
```

2. **Test fetchImage locally:**
```javascript
const api = require('./api/workers.js');
api.fetchImage({ image_id: 'test-id', title: 'Test' }, 'low')
   .then(data => console.log('Title:', data.title, 'Blob size:', data.image.size));
```

3. **Test in browser:**
```
npm start
# Open http://localhost:9966/?api=workers
```

---

## Questions or Issues?

If you encounter any issues implementing your API, please check:
- CORS headers are properly configured
- `image_id` field is present in all fetchList responses
- fetchImage returns a Blob object (not a URL or base64 string)
- Your endpoints handle pagination correctly
