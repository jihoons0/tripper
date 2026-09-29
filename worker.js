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

    // Route: Email - Welcome
    if (url.pathname === '/api/email/welcome' && request.method === 'POST') {
      return handleWelcomeEmail(request, env);
    }

    // Route: Email - Invite
    if (url.pathname === '/api/email/invite' && request.method === 'POST') {
      return handleInviteEmail(request, env);
    }

    // Route: Discover Places (bulk add by category)
    if (url.pathname === '/api/places/discover' && request.method === 'POST') {
      return handlePlacesDiscover(request, env);
    }

    // Route: Google Places Autocomplete
    if (url.pathname === '/api/places/autocomplete' && request.method === 'POST') {
      return handlePlacesAutocomplete(request, env);
    }

    // Route: Google Places Details
    if (url.pathname === '/api/places/details') {
      return handlePlacesDetails(url, env);
    }

    // Route: Google Places Photo Proxy
    if (url.pathname === '/api/places/photo') {
      return handlePlacesPhoto(url, env);
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
      const apiKey = env.GOOGLE_PLACES_API_KEY;

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

      let address = '', category = '';

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

      // 2c. If Google short-link expansion gave us nothing useful, recover with Places
      if ((!name || lat === null || lng === null) && apiKey) {
        try {
          const recovered = await recoverPlaceFromGoogle({
            targetUrl,
            finalUrl,
            apiKey,
            name
          });
          if (recovered) {
            if (!name) name = recovered.name || '';
            if (!address) address = recovered.address || '';
            if (lat === null && recovered.lat != null) lat = recovered.lat;
            if (lng === null && recovered.lng != null) lng = recovered.lng;
            if (!category) category = recovered.category || '';
          }
        } catch (e) {}
      }

      // 3. Nominatim reverse geocode
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

      if (!name && !address && lat === null && lng === null) {
        return json(
          {
            error: isGoogleMapsShortLink(targetUrl)
              ? 'This Google Maps short link could not be resolved. Open the place in Google Maps and copy the full place link or paste the place name instead.'
              : 'Could not resolve this map link into a place.'
          },
          404
        );
      }

      return json({ url: finalUrl, name, address, lat, lng, category });
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(handleScheduled(env));
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
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text,suggestions.placePrediction.structuredFormat.mainText.text,suggestions.placePrediction.structuredFormat.secondaryText.text'
      },
      body: JSON.stringify(reqBody)
    });
    const data = await res.json();
    if (!res.ok) {
      return json({
        error: data?.error?.message || 'Places autocomplete failed',
        googleStatus: res.status,
        googleError: data?.error || null
      }, res.status);
    }

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
  // Shopping = retail destinations from Google's "Shopping" table. Grocery/errand types (supermarket, grocery_store,
  // convenience_store, food_store, liquor_store, market, farmers_market, hardware_store, auto_parts_store, pet_store, ...)
  // stay unmapped -> 'other'.
  shopping_mall: 'shopping', department_store: 'shopping', clothing_store: 'shopping', womens_clothing_store: 'shopping',
  shoe_store: 'shopping', jewelry_store: 'shopping', cosmetics_store: 'shopping', gift_shop: 'shopping',
  book_store: 'shopping', tea_store: 'shopping', electronics_store: 'shopping', cell_phone_store: 'shopping',
  sporting_goods_store: 'shopping', sportswear_store: 'shopping', toy_store: 'shopping', thrift_store: 'shopping',
  flea_market: 'shopping', discount_store: 'shopping', general_store: 'shopping', furniture_store: 'shopping',
  home_goods_store: 'shopping', bicycle_store: 'shopping',
  store: 'shopping', // generic: honored only as primaryType (GTYPE_PRIMARY_ONLY)
};

// Generic types Google also attaches to pharmacies, gas stations, delis, dessert shops, etc.
const GTYPE_PRIMARY_ONLY = new Set(['store']);

const DISCOVER_CATEGORIES = {
  restaurants: { query: 'best restaurants in', type: 'restaurant', cat: 'food' },
  cafes:       { query: 'best cafes and coffee in', type: 'cafe', cat: 'food' },
  bars:        { query: 'best bars in', type: 'bar', cat: 'bar' },
  museums:     { query: 'top museums and attractions in', type: null, cat: 'culture' },
  bakeries:    { query: 'best bakeries and desserts in', type: 'bakery', cat: 'food' },
  parks:       { query: 'best parks and outdoor spots in', type: 'park', cat: 'culture' },
  shopping:    { query: 'best shopping malls, department stores and boutiques in', type: null, cat: 'shopping' },
};

async function handlePlacesDiscover(request, env) {
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return json({ error: 'API key not configured' }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const { category, lat, lng, cityName, existingPlaceIds } = body;

  const cat = DISCOVER_CATEGORIES[category];
  if (!cat) return json({ error: 'invalid category' }, 400);
  if (!cityName) return json({ error: 'cityName required' }, 400);

  const textQuery = `${cat.query} ${cityName}`;
  const reqBody = {
    textQuery,
    maxResultCount: 10,
    languageCode: 'en',
  };
  if (lat && lng) {
    reqBody.locationBias = { circle: { center: { latitude: lat, longitude: lng }, radius: 30000 } };
  }
  if (cat.type) {
    reqBody.includedType = cat.type;
  }

  const fieldMask = 'places.id,places.displayName,places.location,places.photos,places.primaryType,places.types,places.formattedAddress,places.websiteUri,places.googleMapsUri,places.regularOpeningHours,places.editorialSummary,places.priceLevel,places.internationalPhoneNumber,places.rating,places.userRatingCount';

  try {
    const origin = new URL(request.url).origin;
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': fieldMask,
        'Content-Type': 'application/json',
        'Referer': 'https://faropin.com/',
      },
      body: JSON.stringify(reqBody),
    });
    const data = await res.json();
    if (!res.ok) {
      return json({
        error: data?.error?.message || 'Places discover failed',
        googleStatus: res.status,
        googleError: data?.error || null
      }, res.status);
    }
    if (!data.places) return json({ places: [] });

    const existing = new Set(existingPlaceIds || []);
    const PRICE_MAP = { PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };

    const places = data.places
      .filter(p => !existing.has(p.id))
      .slice(0, 5)
      .map(d => {
        let photoUrl = '';
        if (d.photos && d.photos.length > 0) {
          photoUrl = buildPlacesPhotoProxyURL(origin, d.photos[0].name, 400);
        }
        const primaryType = d.primaryType || '';
        const mappedCat = mapGoogleTypesToCategory(primaryType, d.types) || cat.cat;

        return {
          name: d.displayName?.text || '',
          address: d.formattedAddress || '',
          lat: d.location?.latitude || null,
          lng: d.location?.longitude || null,
          photoUrl,
          category: mappedCat,
          primaryType,
          types: d.types || [],
          mapsUrl: d.googleMapsUri || '',
          websiteUrl: d.websiteUri || '',
          placeId: d.id || '',
          openingHours: d.regularOpeningHours?.weekdayDescriptions || null,
          editorialSummary: d.editorialSummary?.text || '',
          priceLevel: PRICE_MAP[d.priceLevel] ?? null,
          phoneNumber: d.internationalPhoneNumber || '',
          rating: d.rating || null,
          userRatingCount: d.userRatingCount || null,
        };
      });

    return json({ places });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handlePlacesDetails(url, env) {
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return json({ error: 'API key not configured' }, 500);

  const placeId = url.searchParams.get('placeId');
  const sessionToken = url.searchParams.get('sessionToken');
  if (!placeId) return json({ error: 'placeId required' }, 400);

  const fieldMask = 'displayName,location,photos,primaryType,types,formattedAddress,websiteUri,googleMapsUri,regularOpeningHours,editorialSummary,priceLevel,internationalPhoneNumber,rating,userRatingCount';

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
    if (!res.ok) {
      return json({
        error: d?.error?.message || 'Place details failed',
        googleStatus: res.status,
        googleError: d?.error || null
      }, res.status);
    }

    // Resolve first photo to a URL
    let photoUrl = '';
    if (d.photos && d.photos.length > 0) {
      const photoName = d.photos[0].name;
      photoUrl = buildPlacesPhotoProxyURL(url.origin, photoName, 400);
    }

    // Map Google type to our category
    const primaryType = d.primaryType || '';
    const category = mapGoogleTypesToCategory(primaryType, d.types);

    // Format opening hours into compact weekday strings
    let openingHours = null;
    if (d.regularOpeningHours && d.regularOpeningHours.weekdayDescriptions) {
      openingHours = d.regularOpeningHours.weekdayDescriptions;
    }

    // Map priceLevel enum to a number (1-4)
    const PRICE_MAP = { PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };
    const priceLevel = PRICE_MAP[d.priceLevel] ?? null;

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
      openingHours,
      editorialSummary: d.editorialSummary?.text || '',
      priceLevel,
      phoneNumber: d.internationalPhoneNumber || '',
      rating: d.rating || null,
      userRatingCount: d.userRatingCount || null,
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

async function handlePlacesPhoto(url, env) {
  const apiKey = env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) return json({ error: 'API key not configured' }, 500);

  const photoName = url.searchParams.get('name');
  if (!photoName) return json({ error: 'name required' }, 400);

  const parsedHeight = parseInt(url.searchParams.get('maxHeightPx') || '400', 10);
  const maxHeightPx = Number.isFinite(parsedHeight)
    ? Math.max(64, Math.min(parsedHeight, 1600))
    : 400;

  try {
    const upstream = new URL(`https://places.googleapis.com/v1/${photoName}/media`);
    upstream.searchParams.set('maxHeightPx', String(maxHeightPx));

    const res = await fetch(upstream.toString(), {
      headers: { 'X-Goog-Api-Key': apiKey },
      redirect: 'follow'
    });

    if (!res.ok) {
      let errorPayload = null;
      try {
        errorPayload = await res.json();
      } catch (error) {}
      return json({
        error: errorPayload?.error?.message || 'Place photo failed',
        googleStatus: res.status,
        googleError: errorPayload?.error || null
      }, res.status);
    }

    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'public, max-age=86400');
    headers.set('Content-Type', res.headers.get('Content-Type') || 'image/jpeg');

    return new Response(res.body, {
      status: 200,
      headers
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

function buildPlacesPhotoProxyURL(origin, photoName, maxHeightPx = 400) {
  const url = new URL('/api/places/photo', origin);
  url.searchParams.set('name', photoName);
  url.searchParams.set('maxHeightPx', String(maxHeightPx));
  return url.toString();
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

async function recoverPlaceFromGoogle({ targetUrl, finalUrl, apiKey, name }) {
  const candidates = [];
  const push = value => {
    const trimmed = (value || '').trim();
    if (!trimmed) return;
    if (!candidates.includes(trimmed)) candidates.push(trimmed);
  };

  push(name);

  try {
    const sourceUrl = new URL(targetUrl);
    push(sourceUrl.searchParams.get('q'));
    push(sourceUrl.searchParams.get('query'));
  } catch (e) {}

  try {
    const resolvedUrl = new URL(finalUrl);
    push(resolvedUrl.searchParams.get('q'));
    push(resolvedUrl.searchParams.get('query'));
  } catch (e) {}

  const pathMatch = finalUrl.match(/\/maps\/(?:place|search)\/([^/@?&]+)/);
  if (pathMatch) push(decodeURIComponent(pathMatch[1]).replace(/\+/g, ' '));

  const rawShortCode = targetUrl.match(/maps\.app\.goo\.gl\/([^/?#]+)/i);
  if (rawShortCode) {
    push(rawShortCode[1]);
  }

  for (const query of candidates) {
    const recovered = await searchGooglePlace(query, apiKey);
    if (recovered) return recovered;
  }

  return null;
}

async function searchGooglePlace(query, apiKey) {
  const fieldMask = 'places.displayName,places.formattedAddress,places.location,places.primaryType,places.types';
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': fieldMask
    },
    body: JSON.stringify({
      textQuery: query,
      maxResultCount: 1,
      languageCode: 'en'
    })
  });

  if (!res.ok) return null;
  const data = await res.json();
  const place = data?.places?.[0];
  if (!place) return null;

  return {
    name: place.displayName?.text || '',
    address: place.formattedAddress || '',
    lat: place.location?.latitude ?? null,
    lng: place.location?.longitude ?? null,
    category: mapGoogleTypesToCategory(place.primaryType, place.types || [])
  };
}

function mapGoogleTypesToCategory(primaryType, types) {
  if (primaryType && GTYPE_TO_CAT[primaryType]) return GTYPE_TO_CAT[primaryType];
  const rest = (types || []).filter(t => !GTYPE_PRIMARY_ONLY.has(t));
  // A pre-shopping category wins over a retail tag (museum/temple/food court carrying gift_shop/shopping_mall keeps its category).
  for (const t of rest) { const c = GTYPE_TO_CAT[t]; if (c && c !== 'shopping') return c; }
  for (const t of rest) { const c = GTYPE_TO_CAT[t]; if (c) return c; }
  return '';
}

function isGoogleMapsShortLink(url) {
  return /https?:\/\/(?:www\.)?maps\.app\.goo\.gl\//i.test(url || '');
}

function osmToCategory(cls, typ) {
  if (/^(bar|pub|biergarten|nightclub|cocktail|wine_bar)$/.test(typ)) return 'bar';
  if (/^(restaurant|cafe|fast_food|food_court|ice_cream|bakery|coffee|sushi|pizza)$/.test(typ)) return 'food';
  if (/^(hotel|motel|hostel|guest_house|apartment|resort)$/.test(typ)) return 'hotel';
  if (/^(museum|gallery|theatre|cinema|historic|monument|ruins|archaeological_site|artwork|attraction|viewpoint|zoo|aquarium|theme_park)$/.test(typ)) return 'culture';
  if (/^(aerodrome|airport|bus_station|railway|subway|ferry|taxi)$/.test(typ)) return 'transport';
  if (cls === 'amenity' && /^(bar|pub|restaurant|cafe|fast_food|food_court)$/.test(typ)) return 'food';
  if (cls === 'tourism') return 'culture';
  if (cls === 'shop' && /^(mall|department_store|clothes|shoes|boutique|fashion|fashion_accessories|bag|leather|jewelry|watches|cosmetics|perfumery|gift|books|stationery|art|antiques|second_hand|charity|variety_store|general|electronics|mobile_phone|computer|camera|video_games|toys|games|sports|outdoor|bicycle|tea|furniture|interior_decoration|houseware|kitchen|craft|music|musical_instrument|anime)$/.test(typ)) return 'shopping';
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

// ==================== Email System ====================

async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) return { error: 'RESEND_API_KEY not configured' };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Faropin <hello@faropin.com>', to: [to], subject, html }),
  });
  return res.json();
}

function emailBase(content) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="padding:0;line-height:0">
<img src="https://faropin.com/og-image.jpg" alt="Faropin" width="520" style="width:100%;height:auto;display:block;border:0" />
</td></tr>
<tr><td style="padding:32px">${content}</td></tr>
<tr><td style="padding:0 32px 24px;text-align:center;font-size:12px;color:#999">
<a href="https://faropin.com" style="color:#999;text-decoration:none">faropin.com</a>
</td></tr>
</table>
</td></tr></table></body></html>`;
}

function btnHtml(href, label) {
  return `<div style="text-align:center;margin:28px 0"><a href="${href}" style="display:inline-block;padding:12px 32px;background:#171717;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;font-size:15px">${label}</a></div>`;
}

const EMAIL_STRINGS = {
  welcome: {
    en: {
      subject: 'Welcome to Faropin!',
      greeting: name => `Hi ${name || 'there'},`,
      intro: 'Welcome to <strong>Faropin</strong>, your collaborative travel planner.',
      step1: '<strong>Create a trip</strong>: pick a city and travel dates',
      step2: '<strong>Add places</strong>: search or paste Google Maps links',
      step3: '<strong>Invite friends</strong>: plan together in real time',
      cta: 'Start Planning',
      outro: 'Have a great trip!',
    },
    ko: {
      subject: 'Faropin에 오신 것을 환영합니다!',
      greeting: name => `안녕하세요 ${name || ''}님,`,
      intro: '여행 계획을 함께 세우는 <strong>Faropin</strong>에 오신 것을 환영합니다.',
      step1: '<strong>여행 만들기</strong>: 도시와 여행 날짜를 선택하세요',
      step2: '<strong>장소 추가</strong>: 검색하거나 Google Maps 링크를 붙여넣으세요',
      step3: '<strong>친구 초대</strong>: 함께 실시간으로 계획하세요',
      cta: '시작하기',
      outro: '좋은 여행 되세요!',
    }
  },
  invite: {
    en: {
      subject: (host, emoji, trip) => `${host} invited you to ${emoji ? emoji + ' ' : ''}${trip}`,
      heading: (host) => `${host} invited you to plan a trip together!`,
      dates: 'Dates',
      city: 'City',
      cta: 'View Trip',
      note: 'Sign in with Google to start editing together.',
    },
    ko: {
      subject: (host, emoji, trip) => `${host}님이 ${emoji ? emoji + ' ' : ''}${trip}에 초대했습니다`,
      heading: (host) => `${host}님이 함께 여행을 계획하자고 초대했습니다!`,
      dates: '날짜',
      city: '도시',
      cta: '여행 보기',
      note: 'Google 로그인으로 함께 편집할 수 있습니다.',
    }
  },
  reminder: {
    en: {
      subject7: (emoji, city) => `7 days until your trip to ${city}! ${emoji || ''}`,
      subject1: (emoji, trip, city) => `Tomorrow: ${trip} to ${city}! ${emoji || ''}`,
      heading7: city => `Your trip to ${city} is in <strong>7 days</strong>!`,
      heading1: city => `Your trip to ${city} is <strong>tomorrow</strong>!`,
      ready: 'Are you ready?',
      places: n => `${n} place${n !== 1 ? 's' : ''} saved`,
      events: n => `${n} event${n !== 1 ? 's' : ''} scheduled`,
      members: 'Traveling with',
      cta: 'View Trip',
    },
    ko: {
      subject7: (emoji, city) => `${city} 여행까지 7일 남았습니다! ${emoji || ''}`,
      subject1: (emoji, trip, city) => `내일: ${city} ${trip}! ${emoji || ''}`,
      heading7: city => `${city} 여행이 <strong>7일</strong> 남았습니다!`,
      heading1: city => `${city} 여행이 <strong>내일</strong>입니다!`,
      ready: '준비되셨나요?',
      places: n => `장소 ${n}개 저장됨`,
      events: n => `일정 ${n}개 등록됨`,
      members: '함께하는 사람',
      cta: '여행 보기',
    }
  }
};

function getLang(lang) { return (lang === 'ko') ? 'ko' : 'en'; }

async function handleWelcomeEmail(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const { email, displayName, lang } = body;
  if (!email) return json({ error: 'email required' }, 400);

  const s = EMAIL_STRINGS.welcome[getLang(lang)];
  const html = emailBase(`
    <p style="font-size:16px;color:#333;margin:0 0 16px">${s.greeting(displayName)}</p>
    <p style="font-size:15px;color:#555;margin:0 0 24px">${s.intro}</p>
    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:8px">
      <tr><td style="padding:10px 0;font-size:14px;color:#444">1. ${s.step1}</td></tr>
      <tr><td style="padding:10px 0;font-size:14px;color:#444;border-top:1px solid #eee">2. ${s.step2}</td></tr>
      <tr><td style="padding:10px 0;font-size:14px;color:#444;border-top:1px solid #eee">3. ${s.step3}</td></tr>
    </table>
    ${btnHtml('https://faropin.com', s.cta)}
    <p style="font-size:14px;color:#888;margin:0;text-align:center">${s.outro}</p>
  `);
  const result = await sendEmail(env, { to: email, subject: s.subject, html });
  return json({ success: true, result });
}

async function handleInviteEmail(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const { toEmail, hostName, tripName, tripEmoji, tripCity, tripStartDate, tripEndDate, tripId, lang } = body;
  if (!toEmail) return json({ error: 'toEmail required' }, 400);

  const s = EMAIL_STRINGS.invite[getLang(lang)];
  const dateStr = tripStartDate && tripEndDate ? `${tripStartDate} - ${tripEndDate}` : (tripStartDate || '');
  const html = emailBase(`
    <p style="font-size:16px;color:#333;margin:0 0 20px">${s.heading(hostName || 'Someone')}</p>
    <div style="background:#f9f9f9;border-radius:10px;padding:20px;margin:0 0 8px">
      <div style="font-size:18px;font-weight:700;color:#222;margin-bottom:8px">${tripEmoji ? tripEmoji + ' ' : ''}${tripName || 'Trip'}</div>
      ${tripCity ? `<div style="font-size:13px;color:#666;margin-bottom:4px"><strong>${s.city}:</strong> ${tripCity}</div>` : ''}
      ${dateStr ? `<div style="font-size:13px;color:#666"><strong>${s.dates}:</strong> ${dateStr}</div>` : ''}
    </div>
    ${btnHtml('https://faropin.com/#trip/' + (tripId || ''), s.cta)}
    <p style="font-size:13px;color:#999;margin:0;text-align:center">${s.note}</p>
  `);
  const subject = s.subject(hostName || 'Someone', tripEmoji, tripName || 'a trip');
  const result = await sendEmail(env, { to: toEmail, subject, html });
  return json({ success: true, result });
}

// ==================== Firebase Service Account Auth ====================

async function getFirestoreToken(env) {
  if (!env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');
  const sa = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email, sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore'
  };
  const enc = s => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(s)))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const unsigned = enc(header) + '.' + enc(payload);
  // Import RSA private key
  const pemBody = sa.private_key.replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\s/g, '');
  const keyData = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const jwt = unsigned + '.' + sigB64;
  // Exchange for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const tokenData = await tokenRes.json();
  return tokenData.access_token;
}

const FIRESTORE_BASE = 'https://firestore.googleapis.com/v1/projects/mexico-trip-c5644/databases/(default)/documents';

async function fsGet(token, path) {
  const res = await fetch(`${FIRESTORE_BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json();
}

async function fsListTrips(token) {
  const res = await fetch(`${FIRESTORE_BASE}/trips?pageSize=200`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return [];
  const data = await res.json();
  return data.documents || [];
}

async function fsPatch(token, path, fields) {
  const masks = Object.keys(fields).map(k => `updateMask.fieldPaths=${k}`).join('&');
  const docFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === 'boolean') docFields[k] = { booleanValue: v };
    else if (typeof v === 'string') docFields[k] = { stringValue: v };
    else if (typeof v === 'object') {
      const mapFields = {};
      for (const [mk, mv] of Object.entries(v)) mapFields[mk] = { booleanValue: mv };
      docFields[k] = { mapValue: { fields: mapFields } };
    }
  }
  await fetch(`${FIRESTORE_BASE}/${path}?${masks}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: docFields })
  });
}

function fsVal(field) {
  if (!field) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.integerValue !== undefined) return parseInt(field.integerValue);
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.arrayValue) return (field.arrayValue.values || []).map(fsVal);
  if (field.mapValue) {
    const obj = {};
    for (const [k, v] of Object.entries(field.mapValue.fields || {})) obj[k] = fsVal(v);
    return obj;
  }
  return null;
}

// ==================== Cron: Trip Reminders ====================

async function handleScheduled(env) {
  let token;
  try { token = await getFirestoreToken(env); } catch (e) { console.error('Firebase auth failed:', e); return; }

  const tripDocs = await fsListTrips(token);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  for (const doc of tripDocs) {
    const f = doc.fields || {};
    const startDate = fsVal(f.startDate);
    const archived = fsVal(f.archived);
    if (!startDate || archived) continue;

    const tripStart = new Date(startDate + 'T00:00:00Z');
    const diffDays = Math.round((tripStart - today) / (1000 * 60 * 60 * 24));

    let reminderType = null;
    if (diffDays === 7) reminderType = '7d';
    else if (diffDays === 1) reminderType = '1d';
    if (!reminderType) continue;

    // Check if already sent
    const remindersSent = fsVal(f.remindersSent) || {};
    if (remindersSent[reminderType]) continue;

    const tripId = doc.name.split('/').pop();
    const tripName = fsVal(f.name) || '';
    const tripEmoji = fsVal(f.emoji) || '';
    const tripCity = fsVal(f.cityName) || fsVal(f.city) || '';
    const access = fsVal(f.access) || {};
    const ownerId = fsVal(f.ownerId);

    // Get trip data for counts
    const dataDoc = await fsGet(token, `trips/${tripId}/data/main`);
    let placesCount = 0, eventsCount = 0;
    if (dataDoc && dataDoc.fields) {
      const wishlist = fsVal(dataDoc.fields.wishlist) || [];
      placesCount = wishlist.length;
      const days = fsVal(dataDoc.fields.days) || [];
      days.forEach(d => { eventsCount += (d.events || []).length; });
    }

    // Look up all members
    const memberUids = Object.keys(access).filter(k => !k.startsWith('pending_'));
    const members = [];
    let ownerLang = 'en';
    for (const uid of memberUids) {
      const userDoc = await fsGet(token, `users/${uid}`);
      if (userDoc && userDoc.fields) {
        const email = fsVal(userDoc.fields.email);
        const name = fsVal(userDoc.fields.displayName) || email;
        if (email) members.push({ uid, email, name });
        if (uid === ownerId && fsVal(userDoc.fields.lang)) ownerLang = fsVal(userDoc.fields.lang);
      }
    }

    if (!members.length) continue;

    const s = EMAIL_STRINGS.reminder[getLang(ownerLang)];
    const heading = reminderType === '7d' ? s.heading7(tripCity) : s.heading1(tripCity);
    const subject = reminderType === '7d' ? s.subject7(tripEmoji, tripCity) : s.subject1(tripEmoji, tripName, tripCity);
    const memberNames = members.map(m => m.name).join(', ');

    const statsHtml = `
      <div style="background:#f9f9f9;border-radius:10px;padding:20px;margin:0 0 8px">
        <div style="font-size:18px;font-weight:700;color:#222;margin-bottom:12px">${tripEmoji ? tripEmoji + ' ' : ''}${tripName}</div>
        <div style="font-size:13px;color:#666;margin-bottom:6px">📍 ${s.places(placesCount)}</div>
        <div style="font-size:13px;color:#666;margin-bottom:6px">📅 ${s.events(eventsCount)}</div>
        <div style="font-size:13px;color:#666">${s.members}: ${memberNames}</div>
      </div>
    `;

    const html = emailBase(`
      <p style="font-size:16px;color:#333;margin:0 0 8px">${heading}</p>
      <p style="font-size:15px;color:#555;margin:0 0 20px">${s.ready}</p>
      ${statsHtml}
      ${btnHtml('https://faropin.com/#trip/' + tripId, s.cta)}
    `);

    // Send to all members
    for (const member of members) {
      try { await sendEmail(env, { to: member.email, subject, html }); } catch (e) { console.error('Reminder email failed for', member.email, e); }
    }

    // Mark as sent
    const newRemindersSent = { ...remindersSent, [reminderType]: true };
    await fsPatch(token, `trips/${tripId}`, { remindersSent: newRemindersSent });
    console.log(`[reminder] Sent ${reminderType} for "${tripName}" to ${members.length} members`);
  }
}
