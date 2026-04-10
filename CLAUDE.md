# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Palo** — a multi-trip travel planning web app. Single-file static app (`index.html`) with a dashboard and per-trip Calendar / Map / Places views. Deployed via Vercel at **https://palo-travel.vercel.app**. Data persisted via **Firebase/Firestore** directly from the browser.

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
- `vercel.json` routes `/__/auth/*` to Firebase auth proxy, `/api/*` to Vercel Node functions, and everything else to `index.html`

**Google Maps URL expansion:** `/api/expand-url` is NOT used from Vercel (blocked by Vercel auth protection on the team plan). Instead, `index.html` calls the **Cloudflare Worker** directly:
- Worker URL: `https://palo-travel-expand-url.jihoon8846.workers.dev/api/expand-url`
- Source: `worker.js` + `wrangler.toml` in repo root
- Deploy: `npx wrangler deploy` (requires Cloudflare login)

**Data:** Firebase/Firestore (project: `mexico-trip-c5644`), localStorage as cache.

**Firestore security rules** (`firestore.rules`): per-trip access enforced via `accessEmails` + `access` map. Read/write to `trips/{tripId}` and `trips/{tripId}/data/{docId}` requires authenticated user whose lowercased email is in `resource.data.accessEmails`. Create requires `ownerId == auth.uid`. Update allowed for owner, or for shared users resolving their own `pending_<email>` invite. `users/{uid}` is world-readable (needed for email→UID lookup during sharing). Legacy `travel/**` collection still public-read.

## Feedback Workflow

`npm run feedback` fetches bug/feature reports from Firestore `feedback/` collection into `feedback.md`. **Always read items aloud and ask permission before resolving** — never auto-resolve. Resolve with `node fetch-feedback.js resolve <id>`.

## File Structure

- `index.html` (~4070 lines) — the entire app: HTML, CSS, and JS in one file. Use offset/limit when reading.
- `server.js` — Express dev server; serves static files + `/api/expand-url` for local Google Maps URL expansion
- `api/expand-url.js` — Vercel serverless function (same expand-url logic, but bypassed in prod due to Vercel auth)
- `worker.js` + `wrangler.toml` — Cloudflare Worker for Google Maps URL expansion (used in production)
- `categorize-wishlist.js` / `fix-categories.js` / `import-saved-places.js` — one-off Node scripts for data migration (not part of the app)
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

`DAYS` and `WISHLIST` are loaded via `loadTripData(tripId)`. Each day has `id`, `date`, `dateShort`, `theme`, `color`, `isoDate`, `events[]`. Each event has `id`, `time`, `endTime`, `title`, `subtitle`, `notes`, `category`, `optional`, `lat`, `lng`, optional `mapsUrl`/`link`.

**Event id prefix is the source of truth for "is this a place vs. a time block":** events created from a wishlist place use id `wl_ev_*`; standalone time blocks use `ev_*`. There is no `type` field. The reliable check is `WISHLIST.some(w => w.calEventId === ev.id)`; the cheap heuristic is `ev.id.indexOf('wl_ev_') === 0`. Calendar rendering uses this to color events (see Theme/Calendar sections).

Changes auto-saved via `scheduleSave()` → `doSave()` (debounced 1s) → writes to localStorage + Firestore.

`DATA_REF` points to the current trip's Firestore doc. `currentTripId` / `currentTripMeta` hold active trip state.

Category constants: `CAT` object (`food`, `bar`, `culture`, `hotel`, `conference`, `transport`, `other`). Icons: `catIcon(cat, size)`.

### Routing

Hash-based: `navigateTo('#dashboard')`, `navigateTo('#trip/<tripId>')`. `DOMContentLoaded` reads `location.hash` to decide initial view.

### Views

- **Dashboard** (`#view-dashboard`) — globe (cobe.js) + "새 여행 추가" CTA + trip cards grid. `renderDashboard(trips)` / `loadDashboard()`. Uses original page bg (no inset chrome).
- **Calendar** (`#view-calendar`) — time-grid, 8AM–midnight, 64px/hr (`HOUR_PX`). `renderCal()`.
- **Map** (`#view-map`) — Leaflet map + sidebar (desktop) / fullscreen + overlay (mobile). `initMap()` / `rebuildMarkers()`.
- **Places** (`#view-wishlist`) — card grid with category/status filters. `renderWishlist()`. Tab is labeled "Places" in the UI; the underlying view id and `WISHLIST` array still use the legacy "wishlist" name.

Three in-trip views toggled via `switchView(v)`. Tab labels: **Calendar / Map / Places** (English). `body.in-trip` class is added/removed by `switchView()` and the dashboard route to drive the chrome (see Trip Canvas Chrome below).

### Trip Canvas Chrome (design-update)

When `body.in-trip` is set, the trip views render inside an inset rounded "canvas card" pinned to the viewport (height = `100vh - 80px`). Content scrolls inside the card; body scroll is suppressed. Mobile (≤768px) reverts everything to a flat full-width layout with normal body scroll.

CSS variables driving the chrome (defined in both `html.theme-dark` / `html.theme-light`):
- `--page-bg` — outside the card. Dark `#000`, light `#F3F3F3`.
- `--canvas-bg` — inside the card, also the floating tablist bg. Dark `#171717`, light `#FFFFFF`.
- `--tab-active-bg` / `--tab-active-fg` — selected tab in the floating pill. Dark `#000`/`#fff`, light `#F3F3F3`/`#0f172a`.

Header chrome under `body.in-trip`:
- **Floating tablist** (`.view-tabs`) — 380×40 pill, 16px radius, centered absolutely above the card. Each tab fills width.
- **Flag button** (`.app-logo-flag`) — 36px circle on the left. **Click navigates to dashboard** (`goToDashboard()`); on hover, the flag emoji swaps to a home icon (CSS `:hover` on `.flag-emoji` / `.flag-home`).
- **Trip name + chevron** — chevron next to the name still triggers `toggleTripDropdown(event)`.
- **Share button** (`.share-status-btn`) — restyled to match the tablist (40h / 16r).
- **Hamburger** (`.viz-menu-toggle`) — 36px circle to mirror the flag.
- **Mobile (≤768px)**: flag button hidden, trip emoji prepended to the name via `.app-logo-name[data-flag]::before`. `data-flag` attribute is set in `updateHeader()`.

### Dashboard

- **Cobe globe** — 3D interactive globe with flag emoji overlays positioned via `projectGlobe()`. Uses `createGlobe()` + `globe.update({ phi })` + `requestAnimationFrame` loop. Markers show trip locations.
- **CTA buttons** — "새 여행 추가", using `.dash-cta-btn` class.
- **Trip cards** — emoji + name, city, date range, always-visible edit/delete actions. Sorted reverse chronological.

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
- `archiveTrip(tripId)` — delete trip
- `goToDashboard()` — clears trip state and routes to dashboard (also wired to flag-button click)
- `fetchWeather()` — Open-Meteo weather → `weatherData`. Uses forecast API for near-future dates, archive API for past dates, last-year-same-dates fallback for dates beyond forecast range (~16 days). Geocodes city name as fallback if `cityLat`/`cityLng` missing. Weather chips shown inline in calendar headers and map day tabs.
- `parseGmapsUrl(url)` / `parseEditMapsUrl(url)` — Google Maps URL parsing (calls CF Worker). Triggered via `oninput`, `onpaste`, and `onchange` for mobile compatibility. `extractMapsUrl(s)` extracts the actual URL from pasted text that may include place name + URL (common on mobile share).
- `geocodeWishItem(w)` — Nominatim geocode for wishlist items without coordinates
- `icon(name, size)` — Heroicons v2 outline SVG string from `ICONS` object
- `catIcon(cat, size)` — category-specific icon (maps 'other' → 'pin')
- `toggleTripDropdown(event)` / `closeTripDropdown()` — trip switcher dropdown
- `initCobe(trips)` / `destroyCobe()` / `projectGlobe()` — cobe globe with flag overlays

### Trip Create/Edit Modal (`#tripCreateModal`)

Field order: City → Trip name → Date range. Emoji auto-derived from country flag. Submit disabled until name + dates filled.

- `autoDetectTimezone(city)` — geocodes via Nominatim, resolves IANA timezone silently
- `tcCityData` — holds `{ name, countryCode, lat, lng }` from city search

### Map Markers & Routes

Rounded-square emoji badges (day color bg, white border), category SVG icon centered, number badge top-right, triangle pointer. OSRM walking routes in day color (`opacity:0.55`); dashed fallback on error. **Map popovers for assigned places include a primary 편집 button** that calls `openEdit(dayId, evId)` (gated by `canEdit()`).

### Calendar Event Colors

Calendar grid events use **two colors only** — category colors are no longer applied here:
- **Time-assigned places** (id starts with `wl_ev_`) — indigo fill `rgba(99,102,241,0.18)` with `#6366f1` text.
- **Time blocks** (id starts with `ev_`) — neutral gray `rgba(148,163,184,0.16)` with `var(--text-secondary)` text.

The `CAT` color map is still used elsewhere (map markers, wishlist filters, edit modal place header).

### Edit Event Modal — Place Mode

When `openEdit(dayId, evId)` finds a wishlist link (`WISHLIST.find(w => w.calEventId === evId)`), `#editForm` gets the `mode-wishlist` class which hides title/sub/category/map fields and only shows time + notes. The `#editPlaceHeader` is populated dynamically with:
- Top-aligned category icon (`align-items:flex-start` on `.edit-place-header`)
- Place name + subtitle
- **Action row**: primary "지도 보기" button (closes modal, calls `goToMapDay(dayId)`) and secondary "Google Maps ↗" link (opens `ev.mapsUrl` / `wl.mapsUrl` / `lat,lng` query in new tab)
- The shared `#editDeleteBtn` is relabeled **"시간 해제"** in this mode — `deleteCurrentEvent()` already preserves the wishlist item and only clears `calDayId`/`calEventId`/`visited`/`dayLabel`. Reset to "삭제" for non-place events.

### Theme

`--accent` is monochrome: `#e8e8e8` (dark mode) / `#171717` (light mode). `--accent-fg` for text on accent backgrounds: `#0a0a0a` / `#ffffff`. Day/marker colors remain per-trip colored. `cycleTheme()` toggles; persisted in localStorage. See **Trip Canvas Chrome** for the additional `--page-bg` / `--canvas-bg` / `--tab-active-bg` / `--tab-active-fg` vars introduced for the inset shell.

### Calendar Add Modal (`#calAddModal`)

Start time uses native `<input type="time">`. Duration slider (`CAL_ADD_DURS=[30,60,90,...,240]`) — index 0 is 30min, default is 30min. Ghost hover preview and click both snap to 30-minute intervals.

- `tpSetFromMin(min)` / `tpGetMin()` — set/get time from the native time input
- `updateCalAddEndTime()` — computes end time from start + duration slider

### Data Safety

**CRITICAL:** Firestore has no version history — data loss is permanent. Multiple guards are in place:

- **`reconcileDays(meta)`** rebuilds DAYS to match trip date range. Events on days that fall outside the new window are NEVER dropped — they are stitched onto the last remaining day with a `[원래 YYYY-MM-DD]` note prefix so the user can relocate them.
- **`doSave()`** refuses to write if both DAYS and WISHLIST are empty (last-line defense against load/navigation race conditions).
- **Edit event modal** has a date picker (`#editDate`) constrained to the trip's `startDate`/`endDate` window — `_moveEventToDate(dayId, evId, newIsoDate)` moves events between days without loss, and updates linked wishlist `calDayId`/`dayLabel`.
- **`addShareUser`** writes `access` as a full object (`update({access: {...}})`) instead of dot-path (`update({'access.key': val})`) because emails contain `.` which Firestore interprets as nested field paths.
- Never add code paths that silently reduce event/wishlist counts. Any destructive action must show a confirmation dialog first.

### Authentication & Sharing

**Auth:** Firebase Auth with **Google sign-in** (popup). `auth.onAuthStateChanged` gates all routing — unauthenticated users see a login screen. `currentUser` holds the Firebase user object. Viz-menu (hamburger + share button) hidden on login screen.

**User profiles:** `users/{uid}` doc with `email`, `displayName` — written on sign-in via `writeUserProfile(user)`.

**Trip access control:** Trip metadata has `access: { [uid]: 'owner'|'write' }` and `accessEmails: [email]` for query indexing.
- `getTripRole()` — returns `'owner'`, `'write'`, or `'none'` based on `currentUser.uid` in `currentTripMeta.access`
- `canEdit()` — true for `owner` or `write` roles
- `isOwner()` — true for `owner` only

**Sharing UI:** Owner-only share modal (`#shareModal`) to invite by email. `addShareUser(e)` looks up user by email in `users` collection — if found, adds UID to `access`; if not, adds `pending_<email>` entry. Pending invites auto-resolve on sign-in via `resolvePendingInvites(user)`. Share status button in header shows lock icon ("나만 보기") when private, member count when shared. Share button hidden on dashboard.

**Authorship:** Wishlist items have `addedBy` (display name) and `addedByPhoto` (Google avatar URL). Shown as avatar or initials chip on wishlist cards.

### FAB (Floating Action Button)

Fixed-position "장소 추가" button (`.fab`). Hidden on dashboard, on mobile map view (≤768px), and for non-editable trips. Visibility updated via `updateFab(v)` — also re-evaluated on `window.resize`.

### Currency Converter

Header widget (hidden on dashboard, visible in trip). Rate from `https://api.frankfurter.app`. Currency auto-detected from trip's `cityCountryCode` via `CC_TO_CURR` map.
