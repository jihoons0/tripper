export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // Route: Google Places Autocomplete
    if (url.pathname === '/api/places/autocomplete' && request.method === 'POST') {
      return handlePlacesAutocomplete(request, env);
    }

    // Route: Google Places Details
    if (url.pathname === '/api/places/details') {
      return handlePlacesDetails(url, env);
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
        name = decodeURIComponent(placeMatch[1]).replace(/\+/g, ' ').trim();
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

      // 2b. If no coords, try geocoding the ?q= parameter
      if (lat === null) {
        try {
          // If Google returned a /sorry/ CAPTCHA page, the real URL is in ?continue=
          let parseUrl = finalUrl;
          if (/\/sorry\//.test(finalUrl)) {
            const cont = new URL(finalUrl).searchParams.get('continue');
            if (cont) parseUrl = cont;
          }
          const qParam = new URL(parseUrl).searchParams.get('q');
          if (qParam && !/^-?\d+\.?\d*,-?\d+\.?\d*$/.test(qParam)) {
            const placeName = qParam.split(',')[0].trim();
            // Try the full query first; Nominatim often fails when the first segment is a
            // user-given place name (e.g. "Hallasan") that doesn't match the street below.
            // Fallback: strip the first comma-separated segment and geocode the address only.
            const attempts = [qParam];
            const addressOnly = qParam.split(',').slice(1).join(',').trim();
            if (addressOnly && addressOnly !== qParam) attempts.push(addressOnly);
            for (const q of attempts) {
              const gRes = await fetch(
                `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&addressdetails=1`,
                { headers: { 'User-Agent': 'PaloTravelApp/1.0' } }
              );
              const gData = await gRes.json();
              if (gData && gData[0]) {
                lat = parseFloat(gData[0].lat);
                lng = parseFloat(gData[0].lon);
                if (!name) name = placeName || gData[0].name || '';
                address = gData[0].display_name || '';
                category = osmToCategory(gData[0].class || '', gData[0].type || '');
                break;
              }
            }
          }
        } catch (e) {}
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

// ==================== Google Places API Handlers ====================

async function handlePlacesAutocomplete(request, env) {
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return json({ error: 'API key not configured' }, 500);

  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'invalid JSON' }, 400); }

  const { input, sessionToken, locationBias } = body;
  if (!input) return json({ error: 'input required' }, 400);

  const reqBody = { input, languageCode: 'en' };
  if (sessionToken) reqBody.sessionToken = sessionToken;
  if (locationBias && locationBias.lat != null && locationBias.lng != null) {
    reqBody.locationBias = {
      circle: {
        center: { latitude: locationBias.lat, longitude: locationBias.lng },
        radius: locationBias.radius || 50000
      }
    };
  }

  try {
    const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
      body: JSON.stringify(reqBody)
    });
    const data = await res.json();

    const suggestions = (data.suggestions || [])
      .filter(s => s.placePrediction)
      .map(s => ({
        placeId: s.placePrediction.placeId,
        text: s.placePrediction.text?.text || '',
        mainText: s.placePrediction.structuredFormat?.mainText?.text || '',
        secondaryText: s.placePrediction.structuredFormat?.secondaryText?.text || '',
      }));

    return json({ suggestions });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

const GTYPE_TO_CAT = {
  restaurant: 'food', cafe: 'food', bakery: 'food', meal_takeaway: 'food', meal_delivery: 'food',
  coffee_shop: 'food', ice_cream_shop: 'food', pizza_restaurant: 'food', sushi_restaurant: 'food',
  ramen_restaurant: 'food', seafood_restaurant: 'food', steak_house: 'food', sandwich_shop: 'food',
  bar: 'bar', night_club: 'bar', wine_bar: 'bar',
  museum: 'culture', art_gallery: 'culture', church: 'culture', tourist_attraction: 'culture',
  performing_arts_theater: 'culture', historical_landmark: 'culture', national_park: 'culture', park: 'culture',
  lodging: 'hotel', hotel: 'hotel', resort_hotel: 'hotel',
  airport: 'transport', train_station: 'transport', bus_station: 'transport', transit_station: 'transport',
  subway_station: 'transport',
};

async function handlePlacesDetails(url, env) {
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return json({ error: 'API key not configured' }, 500);

  const placeId = url.searchParams.get('placeId');
  const sessionToken = url.searchParams.get('sessionToken');
  if (!placeId) return json({ error: 'placeId required' }, 400);

  const fieldMask = 'displayName,location,photos,primaryType,types,formattedAddress,websiteUri,googleMapsUri';

  try {
    let detailUrl = `https://places.googleapis.com/v1/places/${placeId}?languageCode=en`;
    if (sessionToken) detailUrl += `&sessionToken=${sessionToken}`;

    const res = await fetch(detailUrl, {
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask
      }
    });
    const d = await res.json();

    // Resolve first photo to a URL
    let photoUrl = '';
    if (d.photos && d.photos.length > 0) {
      const photoName = d.photos[0].name;
      photoUrl = `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=400&key=${apiKey}`;
    }

    // Map Google type to our category
    const primaryType = d.primaryType || '';
    let category = GTYPE_TO_CAT[primaryType] || '';
    if (!category && d.types) {
      for (const t of d.types) {
        if (GTYPE_TO_CAT[t]) { category = GTYPE_TO_CAT[t]; break; }
      }
    }

    return json({
      name: d.displayName?.text || '',
      address: d.formattedAddress || '',
      lat: d.location?.latitude || null,
      lng: d.location?.longitude || null,
      photoUrl,
      category,
      primaryType,
      types: d.types || [],
      mapsUrl: d.googleMapsUri || '',
      websiteUrl: d.websiteUri || '',
      placeId,
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ==================== URL Expansion ====================

async function followRedirect(url, maxRedirects = 5) {
  if (maxRedirects === 0) return url;
  const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': 'curl/7.88.1' } });
  if (res.status >= 300 && res.status < 400) {
    let next = res.headers.get('location') || '';
    if (next && !next.startsWith('http')) next = new URL(next, url).href;
    if (next) return followRedirect(next, maxRedirects - 1);
  }
  // If no redirect, check HTML body for a Google Maps URL (meta refresh, JS redirect, or embedded coords)
  if (res.status === 200 && !url.includes('/maps/place/')) {
    try {
      const body = await res.text();
      // Look for Google Maps URL in the HTML body
      const mapsUrl = body.match(/https:\/\/www\.google\.com\/maps\/place\/[^"'\s<>]+/);
      if (mapsUrl) return mapsUrl[0];
      // Look for meta refresh or window.location redirect
      const meta = body.match(/content=["'][^"']*url=(https:\/\/[^"'\s]+)/i);
      if (meta) return followRedirect(meta[1], maxRedirects - 1);
    } catch (e) {}
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
