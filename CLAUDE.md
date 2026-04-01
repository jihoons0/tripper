# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Palo** — a multi-trip travel planning web app. Single-file static app (`index.html`) with a dashboard, per-trip calendar/map/wishlist views, and a special "hometown" trip type. Deployed via Vercel at **https://palo-travel.vercel.app**. Data persisted via **Firebase/Firestore** directly from the browser.

## Local Development

```bash
npm run dev   # starts Express server with --watch (auto-restart on file changes)
npm start     # starts Express server without watch
```

`server.js` serves `index.html` as a static file. Visit `http://localhost:3000`.

**Note:** `server.js` exposes `/api/data`, `/api/days`, `/api/wishlist` routes backed by `data.json` — these are unused dead code. `index.html` talks to Firebase/Firestore directly.

## Deployment

- **Vercel project:** `palo-travel` (team: `jihoon-suhs-projects`)
- **Production URL:** https://palo-travel.vercel.app (alias; auto-generated deploy URLs are `mexico-travel-*.vercel.app`)
- **Deploy command:** `vercel --prod` then `vercel alias set <deploy-url> palo-travel.vercel.app`
- `vercel.json` routes `/api/*` to Vercel Node functions and everything else to `index.html`

**Google Maps URL expansion:** `/api/expand-url` is NOT used from Vercel (blocked by Vercel auth protection on the team plan). Instead, `index.html` calls the **Cloudflare Worker** directly:
- Worker URL: `https://palo-travel-expand-url.jihoon8846.workers.dev/api/expand-url`
- Source: `worker.js` + `wrangler.toml` in repo root
- Deploy: `npx wrangler deploy` (requires Cloudflare login)

**Data:** Firebase/Firestore (project: `mexico-trip-c5644`), localStorage as cache.

**Firestore security rules:** `allow read, write: if true` on `match /travel/{document=**}` — public read/write intentional.

## File Structure

- `index.html` (~220KB, ~5700 lines) — the entire app: HTML, CSS, and JS in one file. Use offset/limit when reading.
- `server.js` — Express dev server; serves static files + `/api/expand-url` for local Google Maps URL expansion
- `api/expand-url.js` — Vercel serverless function (same expand-url logic, but bypassed in prod due to Vercel auth)
- `worker.js` + `wrangler.toml` — Cloudflare Worker for Google Maps URL expansion (used in production)
- `product.md` / `TODO.md` / `itenary.md` — planning docs (not code)

## Architecture

Everything lives in `index.html`: HTML, CSS (CSS variables for theming), vanilla JavaScript. No frameworks, no bundler. CDN libraries:
- **Leaflet 1.9.4** — interactive map (`#leaflet-map`)
- **cobe** — interactive 3D globe on dashboard (via `esm.sh/cobe`)

### Icons

All icons use **Heroicons v2 outline** SVGs via the `ICONS` object and `icon(name, size)` helper function. Category icons via `catIcon(cat, size)`. **Never use emoji** for UI elements — only country flag emoji are acceptable. SVG icons available: `calendar`, `map`, `star`, `pencil`, `trash`, `food`, `bar`, `culture`, `hotel`, `conference`, `transport`, `pin`, `globe`, `currency`, `home`.

### Data Model

Per-trip data stored at `db.collection('trips').doc(tripId).collection('data').doc('main')` as `{ days, wishlist }`.

Trip list stored at `db.collection('trips').doc(tripId)` (metadata: `name`, `emoji`, `color`, `startDate`, `endDate`, `cityName`, `cityLat`, `cityLng`, `cityCountryCode`, `timezone`).

**Hometown** is a special trip with `type: 'hometown'`, no `startDate`/`endDate`. Only one allowed. Has only Map and Wishlist views (no Calendar). Stored in the same `trips` collection.

`DAYS` and `WISHLIST` are loaded via `loadTripData(tripId)`. Each day has `id`, `date`, `dateShort`, `theme`, `color`, `isoDate`, `events[]`. Each event has `id`, `time`, `endTime`, `title`, `subtitle`, `notes`, `category`, `optional`, `lat`, `lng`.

Changes auto-saved via `scheduleSave()` → `doSave()` (debounced 1s) → writes to localStorage + Firestore.

`DATA_REF` points to the current trip's Firestore doc. `currentTripId` / `currentTripMeta` hold active trip state.

Category constants: `CAT` object (`food`, `bar`, `culture`, `hotel`, `conference`, `transport`, `other`). Icons: `catIcon(cat, size)`.

### Routing

Hash-based: `navigateTo('#dashboard')`, `navigateTo('#trip/<tripId>')`. `DOMContentLoaded` reads `location.hash` to decide initial view.

### Views

- **Dashboard** (`#view-dashboard`) — hometown card + globe (cobe.js) + CTA buttons + trip cards grid. `renderDashboard(trips)` / `loadDashboard()`.
- **Calendar** (`#view-calendar`) — time-grid, 8AM–midnight, 64px/hr (`HOUR_PX`). `renderCal()`. Hidden for hometown trips.
- **Map** (`#view-map`) — Leaflet map + sidebar (desktop) / fullscreen + overlay (mobile). `initMap()` / `rebuildMarkers()`.
- **Wishlist** (`#view-wishlist`) — card grid with category/status filters. `renderWishlist()`.

Three in-trip views toggled via `switchView(v)`. Tab order: Calendar → Map → Wishlist. Hometown trips default to Map and hide Calendar tab.

### Trip Switcher Dropdown

Header shows current trip name with a chevron. Clicking opens a dropdown listing all trips for quick switching. `toggleTripDropdown(event)` / `closeTripDropdown()`. Hometown appears with a home icon.

### Dashboard

- **Hometown card** — pinned above the globe, max-width 360px centered. Shows home icon + "내 도시" label, city name, wishlist count, always-visible edit button.
- **Cobe globe** — 3D interactive globe with flag emoji overlays positioned via `projectGlobe()`. Uses `createGlobe()` + `globe.update({ phi })` + `requestAnimationFrame` loop. Markers show trip locations.
- **CTA buttons** — "내 도시 설정" (if no hometown) and "새 여행 추가", using `.dash-cta-btn` class with hover states.
- **Trip cards** — simplified: emoji + name, city, date range, hover-reveal edit/delete actions.

### Mobile-Specific UI

**Header (≤768px):**
- View tabs right-aligned next to hamburger menu
- Tab labels hidden, icons only
- Viz menu toggle smaller (34px)

**Calendar (≤768px):**
- Sticky `.cal-day-nav` replaces `.cal-header-row`
- `calPage` (0-indexed) tracks visible day; `setCalPage(idx)` switches days
- Only `.active-day` column shown

**Map (≤768px):**
- Fullscreen map; `.map-mob-tabs` (day pill buttons) + `.map-mob-sheet` (bottom sheet)
- `mapMobDay` (0-indexed); `setMapMobDay(idx)` switches days + calls `fitMapToDay()`
- Zoom controls and GPS button hidden

### State

Global JS: `currentView`, `currentTripId`, `currentTripMeta`, `editingDayId`, `editingEvId`, `addingDayId`, `mapFilter`, `leafletMap`, `mapMarkers`, `mapRoutes`, `_routeBuildId`, `calPage`, `mapMobDay`, `DATA_REF`.

### Rendering

All views render via innerHTML string concatenation. `rerender()` refreshes current view + triggers `scheduleSave()`.

### Key Functions

- `loadDashboard()` / `renderDashboard(trips)` — dashboard with hometown card, globe, CTAs, trip cards
- `loadTripData(tripId)` — load trip from Firestore into `DAYS`/`WISHLIST`
- `renderCal()` / `renderCalBody()` / `renderCalHeader()` / `renderCalDayNav()` — calendar
- `setCalPage(idx)` — mobile calendar day switch
- `renderWishlist()` — wishlist grid
- `initMap()` / `rebuildMarkers()` / `fitMapToDay(idx)` — Leaflet map
- `clearRoutes()` / `buildRoutes()` — OSRM walking routes per day; falls back to dashed lines
- `renderMapMobTabs()` / `renderMapMobSheet()` / `setMapMobDay(idx)` — mobile map overlay
- `setMapFilter(id, btn)` — desktop sidebar day filter
- `goToMapDay(dayId)` / `goToCalDay(dayId)` — cross-view navigation
- `openEdit(dayId, evId)` / `saveEditEvent()` / `deleteCurrentEvent()` — edit event modal
- `openAdd(dayId)` / `saveNewEvent()` — add event modal
- `openWishAdd()` / `saveWishItem()` / `deleteWishItem()` — wishlist modal
- `openTripCreate()` / `openTripEdit(tripId)` / `saveTripCreate(e)` — trip create/edit modal
- `openHometownModal()` / `saveHometown()` — hometown city picker modal
- `archiveTrip(tripId)` — delete trip
- `fetchWeather()` — open-meteo forecast → `weatherData`
- `parseGmapsUrl(url)` / `parseEditMapsUrl(url)` — Google Maps URL parsing (calls CF Worker)
- `geocodeWishItem(w)` — Nominatim geocode for wishlist items without coordinates
- `icon(name, size)` — Heroicons v2 outline SVG string from `ICONS` object
- `catIcon(cat, size)` — category-specific icon (maps 'other' → 'pin')
- `toggleTripDropdown(event)` / `closeTripDropdown()` — trip switcher dropdown
- `initCobe(trips)` / `destroyCobe()` / `projectGlobe()` — cobe globe with flag overlays

### Trip Create/Edit Modal (`#tripCreateModal`)

Field order: City → Trip name → Date range. Emoji auto-derived from country flag. Submit disabled until name + dates filled.

- `autoDetectTimezone(city)` — geocodes via Nominatim, resolves IANA timezone silently
- `tcCityData` — holds `{ name, countryCode, lat, lng }` from city search

### Hometown Modal (`#hometownModal`)

Simple city-search-only modal. No date fields, no trip name input. City auto-derived as name. Saves with `type: 'hometown'`. Only one hometown allowed — setting a new one replaces the old.

- `_htCityData` — holds selected city data
- `openHometownModal(editId)` — opens modal, optionally pre-fills for editing existing hometown

### Map Markers & Routes

Rounded-square emoji badges (day color bg, white border), category SVG icon centered, number badge top-right, triangle pointer. OSRM walking routes in day color (`opacity:0.55`); dashed fallback on error.

### Theme

`--accent` is monochrome: `#e8e8e8` (dark mode) / `#171717` (light mode). `--accent-fg` for text on accent backgrounds: `#0a0a0a` / `#ffffff`. Day/marker colors remain per-trip colored. `cycleTheme()` toggles; persisted in localStorage.

### Currency Converter

Header widget (hidden on dashboard, visible in trip). Rate from `https://api.frankfurter.app`. Currency auto-detected from trip's `cityCountryCode` via `CC_TO_CURR` map.
