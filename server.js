const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

app.use(express.json());
app.use(express.static(__dirname));

function readData() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

app.get('/api/data', (req, res) => res.json(readData()));

app.put('/api/days', (req, res) => {
  const data = readData();
  data.days = req.body;
  writeData(data);
  res.json({ ok: true });
});

app.put('/api/wishlist', (req, res) => {
  const data = readData();
  data.wishlist = req.body;
  writeData(data);
  res.json({ ok: true });
});

// Follow redirects using https module (fetch doesn't work with maps.app.goo.gl)
function followRedirect(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? require('https') : require('http');
    mod.get({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'curl/7.88.1' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        resolve(followRedirect(next, maxRedirects - 1));
      } else {
        // Drain the response
        res.resume();
        resolve(url);
      }
    }).on('error', reject);
  });
}

// Expand Google Maps short URLs and extract place info
app.get('/api/expand-url', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'no url' });
  try {
    const finalUrl = await followRedirect(url);

    // 1. Business name from URL path
    // Final URL looks like: https://www.google.com/maps/place/THE+REAL+McCOY'S/@35.66...,17z/
    let name = '';
    const placeMatch = finalUrl.match(/\/maps\/(?:place|search)\/([^/@?&]+)/);
    if (placeMatch) {
      name = decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).trim();
    }
    if (/^(dropped pin|google maps?|maps?)$/i.test(name)) name = '';

    // 2. Lat/lng — prefer precise pin coords from data param (!3d...!4d...) over viewport center (@...)
    let lat = null, lng = null;
    const pinCoords = finalUrl.match(/!3d(-?\d+\.?\d+)!4d(-?\d+\.?\d+)/);
    if (pinCoords) { lat = parseFloat(pinCoords[1]); lng = parseFloat(pinCoords[2]); }
    if (lat === null) {
      const coords = finalUrl.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
      if (coords) { lat = parseFloat(coords[1]); lng = parseFloat(coords[2]); }
    }

    // 3. Nominatim for address + POI category
    let address = '';
    let category = '';
    function osmToCategory(cls, typ) {
      if (/^(bar|pub|biergarten|nightclub|cocktail|wine_bar)$/.test(typ)) return 'bar';
      if (/^(restaurant|cafe|fast_food|food_court|ice_cream|bakery|coffee|sushi|pizza)$/.test(typ)) return 'food';
      if (/^(hotel|motel|hostel|guest_house|apartment|resort)$/.test(typ)) return 'hotel';
      if (/^(museum|gallery|theatre|cinema|historic|monument|ruins|archaeological_site|artwork|attraction|viewpoint|zoo|aquarium|theme_park)$/.test(typ)) return 'culture';
      if (/^(aerodrome|airport|bus_station|railway|subway|ferry|taxi)$/.test(typ)) return 'transport';
      if (cls === 'amenity' && /^(bar|pub|restaurant|cafe|fast_food|food_court)$/.test(typ)) return 'food';
      if (cls === 'tourism') return 'culture';
      if (cls === 'shop') return 'other';
      return '';
    }
    if (lat !== null && lng !== null) {
      try {
        // Reverse geocode for address
        const nomRes = await fetch(
          `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=ko&zoom=18`,
          { headers: { 'User-Agent': 'PaloTravelApp/1.0' } }
        );
        const nomData = await nomRes.json();
        if (nomData) {
          const a = nomData.address || {};
          if (!name) name = a.tourism || a.amenity || a.shop || a.leisure || a.historic || a.building || '';
          address = nomData.display_name || '';
          category = osmToCategory(nomData.class || '', nomData.type || '');
        }
      } catch(e) {}
    }
    // If no category yet and we have a name, search by name (catches shops/places not found by reverse geocoding)
    if (!category && name) {
      try {
        const searchRes = await fetch(
          `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&format=json&limit=1&addressdetails=0`,
          { headers: { 'User-Agent': 'PaloTravelApp/1.0' } }
        );
        const searchData = await searchRes.json();
        if (searchData && searchData[0]) {
          category = osmToCategory(searchData[0].class || '', searchData[0].type || '');
        }
      } catch(e) {}
    }

    res.json({ url: finalUrl, name, address, lat, lng, category });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
