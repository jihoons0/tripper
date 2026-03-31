export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET',
        },
      });
    }

    if (url.pathname !== '/api/expand-url') {
      return new Response('not found', { status: 404 });
    }

    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return json({ error: 'no url' }, 400);
    }

    try {
      const finalUrl = await followRedirect(targetUrl);

      // 1. Name from URL path
      let name = '';
      const placeMatch = finalUrl.match(/\/maps\/(?:place|search)\/([^/@?&]+)/);
      if (placeMatch) {
        name = decodeURIComponent(placeMatch[1].replace(/\+/g, ' ')).trim();
      }
      if (/^(dropped pin|google maps?|maps?)$/i.test(name)) name = '';

      // 2. Lat/lng — prefer pin coords over viewport center
      let lat = null, lng = null;
      const pinCoords = finalUrl.match(/!3d(-?\d+\.?\d+)!4d(-?\d+\.?\d+)/);
      if (pinCoords) { lat = parseFloat(pinCoords[1]); lng = parseFloat(pinCoords[2]); }
      if (lat === null) {
        const coords = finalUrl.match(/@(-?\d+\.?\d*),(-?\d+\.?\d*)/);
        if (coords) { lat = parseFloat(coords[1]); lng = parseFloat(coords[2]); }
      }

      // 3. Nominatim reverse geocode
      let address = '', category = '';
      if (lat !== null && lng !== null) {
        try {
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
        } catch (e) {}
      }

      // 4. Fallback: search by name for category
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
        } catch (e) {}
      }

      return json({ url: finalUrl, name, address, lat, lng, category });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  }
};

async function followRedirect(url, maxRedirects = 5) {
  if (maxRedirects === 0) return url;
  const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'curl/7.88.1' } });
  if (res.status >= 300 && res.status < 400) {
    let next = res.headers.get('location') || '';
    if (next && !next.startsWith('http')) next = new URL(next, url).href;
    if (next) return followRedirect(next, maxRedirects - 1);
  }
  return url;
}

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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
