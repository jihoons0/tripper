# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Faropin** — a multi-trip travel planning web app. Single-file static app (`index.html`) with a dashboard and per-trip Calendar / Map / Places views. Deployed via Vercel at **https://faropin.com** (legacy alias `https://palo-travel.vercel.app` still points to the same deploy). Data persisted via **Firebase/Firestore** directly from the browser.

## Local Development

```bash
npm run dev   # starts Express server with --watch (auto-restart on file changes)
npm start     # starts Express server without watch
```

`server.js` serves `index.html` as a static file. Visit `http://localhost:3000`.

**Note:** `server.js` exposes `/api/data`, `/api/days`, `/api/wishlist` routes backed by `data.json` — these are unused dead code. `index.html` talks to Firebase/Firestore directly.

## Deployment

- **Vercel project:** `palo-travel` (team: `jihoon-suhs-projects`) — internal project name, not renamed; users never see it
- **Production URL:** https://faropin.com (purchased on GoDaddy; GoDaddy DNS holds `A @ 76.76.21.21` + `CNAME www cname.vercel-dns.com`). Legacy alias `https://palo-travel.vercel.app` also points to the same deploy and is preserved so pre-rename share links keep working.
- **Deploy command:** `vercel --prod` (auto-aliases to `faropin.com`) then `vercel alias set <deploy-url> palo-travel.vercel.app` to refresh the legacy alias
- **Firebase `authDomain`:** `faropin.com`. Requires `faropin.com` + `www.faropin.com` in Firebase Auth → Settings → Authorized domains. `palo-travel.vercel.app` is also still in the authorized list (remove only after confirming no traffic hits it).
- **Google Places API key:** HTTP referrer allowlist must include `https://faropin.com/*` and `https://www.faropin.com/*`. (Key lives as a Cloudflare Worker secret, so referrer checks fire on Worker-originated requests — if the key has restrictions at all.)
- `vercel.json` routes `/__/auth/*` to Firebase auth proxy, `/api/*` to Vercel Node functions, and everything else to `index.html`. The auth proxy matches on path, not host, so it works on both `faropin.com` and the legacy alias.

**Cloudflare Worker** (`worker.js` + `wrangler.toml`): handles Google Maps URL expansion, Google Places API proxy (autocomplete, details, discover), and email notifications. `index.html` calls the worker directly (Vercel's `/api/expand-url` is blocked by auth protection on the team plan).
- Worker URL: `https://palo-travel-expand-url.jihoon8846.workers.dev`
- Endpoints: `/api/expand-url`, `POST /api/places/autocomplete`, `GET /api/places/details`, `POST /api/places/discover`
- Cron: `0 9 * * *` — daily trip reminder emails (7d + 1d before departure)
- Secrets: `GOOGLE_PLACES_API_KEY`, `RESEND_API_KEY`, `FIREBASE_SERVICE_ACCOUNT` (set via `wrangler secret put`)
- Deploy: `npx wrangler deploy` (requires Cloudflare login)

**Data:** Firebase/Firestore (project: `mexico-trip-c5644`), localStorage as cache.

**Firestore security rules** (`firestore.rules`): per-trip access enforced via `accessEmails` + `access` map. Read/write to `trips/{tripId}` and `trips/{tripId}/data/{docId}` requires authenticated user whose lowercased email is in `resource.data.accessEmails`. Create requires `ownerId == auth.uid`. Update allowed for owner, or for shared users resolving their own `pending_<email>` invite. `users/{uid}` is world-readable (needed for email→UID lookup during sharing). Legacy `travel/**` collection still public-read.

## Feedback Workflow

`npm run feedback` fetches bug/feature reports from Firestore `feedback/` collection into `feedback.md`. **Always read items aloud and ask permission before resolving** — never auto-resolve. Resolve with `node fetch-feedback.js resolve <id>`.

## File Structure

- `index.html` (~5900 lines) — the entire app: HTML, CSS, and JS in one file. Use offset/limit when reading.
- `server.js` — Express dev server; serves static files + `/api/expand-url` for local Google Maps URL expansion
- `api/expand-url.js` — Vercel serverless function (same expand-url logic, but bypassed in prod due to Vercel auth)
- `worker.js` + `wrangler.toml` — Cloudflare Worker: Google Maps URL expansion + Google Places API proxy (autocomplete, details, discover) + email notifications (welcome, invite, trip reminders via Resend)
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

Trip list stored at `db.collection('trips').doc(tripId)` (metadata: `name`, `emoji`, `color`, `startDate`, `endDate`, `city`, `cityLat`, `cityLng`, `cityCountryCode`, `timezone`, `partySize`). **Note:** the city name field is `city`, not `cityName`. `partySize` is an integer (default 1) set from the trip create/edit modal; surfaced in the exported itinerary markdown.

`DAYS` and `WISHLIST` are loaded via `loadTripData(tripId)`. Each day has `id`, `date`, `dateShort`, `theme`, `color`, `isoDate`, `events[]`, and optionally `lodgingWishId` (pointer to a wishlist item with `category:'hotel'`) rendered as a full-width chip in the calendar day header. Each event has `id`, `time`, `endTime`, `title`, `subtitle`, `notes`, `category`, `optional`, `lat`, `lng`, optional `mapsUrl`/`link`.

**Wishlist items** additionally have Google Places fields: `googlePlaceId`, `photoUrl`, `websiteUrl`, `primaryType`, `openingHours` (weekday strings array), `editorialSummary`, `priceLevel` (0-4), `phoneNumber`, `rating` (1-5 float), `userRatingCount` (integer). They may also have `votes: { [uid]: { name, photo, at } }` — up-only thumbs from collaborators, with denormalized voter info so avatars render without async user lookups (legacy string `'up'` values are also tolerated). These are populated when adding a place via Google Places search or discover. Helper functions: `fmtPrice(level)`, `getTodayHours(openingHours)`, `placeDetailsHtml(w, compact)`, `voteCount(w)`, `hasUserVoted(w)`, `voterList(w)`, `toggleVote(id)`, `sortByVotes(list)`.

**Event id prefix is the source of truth for "is this a place vs. a time block":** events created from a wishlist place use id `wl_ev_*`; standalone time blocks use `ev_*`. There is no `type` field. The reliable check is `WISHLIST.some(w => w.calEventId === ev.id)`; the cheap heuristic is `ev.id.indexOf('wl_ev_') === 0`. Calendar rendering uses this to color events (see Theme/Calendar sections).

Changes auto-saved via `scheduleSave()` → `doSave()` (debounced 1s) → writes to localStorage + Firestore.

`DATA_REF` points to the current trip's Firestore doc. `currentTripId` / `currentTripMeta` hold active trip state.

Category constants: `CAT` object (`food`, `bar`, `culture`, `hotel`, `conference`, `transport`, `other`). Icons: `catIcon(cat, size)`.

### Routing

Hash-based: `navigateTo('#dashboard')`, `navigateTo('#trip/<tripId>')`. `DOMContentLoaded` reads `location.hash` to decide initial view.

### Views

- **Dashboard** (`#view-dashboard`) — globe (cobe.js) + "+ Add New Trip" CTA + trip cards grid. `renderDashboard(trips)` / `loadDashboard()`. Uses original page bg (no inset chrome).
- **Calendar** (`#view-calendar`) — time-grid, 8AM–midnight, 64px/hr (`HOUR_PX`). `renderCal()`. Desktop: paginated when days exceed viewport (min column width `CAL_COL_MIN=160`px). `calDaysPerPage()` / `calTotalPages()` / `calPageDays()` / `renderCalPageNav()`.
- **Map** (`#view-map`) — Leaflet map + sidebar (desktop) / fullscreen + overlay (mobile). `initMap()` / `rebuildMarkers()`. Desktop sidebar has a search bar at top (same autocomplete as Places tab) via `renderViewSearchBar()`.
- **Places** (`#view-wishlist`) — card grid with category/status filters. `renderWishlist()`. Tab is labeled "Places" in the UI; the underlying view id and `WISHLIST` array still use the legacy "wishlist" name. **Search/URL bar** at top (visible when `canEdit()`) — type to search via Google Places API autocomplete or paste a Google Maps link. Selecting from autocomplete opens the add-place modal with fields pre-filled (photo, name, category, address, coords). `quickAddPlace()` / `_addQuickPlace()` / `_addPlaceFromSearch()` / `_populateWishModalFromSearch()`.

Three in-trip views toggled via `switchView(v)`. Tab labels: **Calendar / Map / Places** (English). `body.in-trip` class is added/removed by `switchView()` and the dashboard route to drive the chrome (see Trip Canvas Chrome below).

### Trip Canvas Chrome (design-update)

When `body.in-trip` is set, the trip views render inside an inset rounded "canvas card" pinned to the viewport (height = `100vh - 80px`). Content scrolls inside the card; body scroll is suppressed. Mobile (≤768px) reverts everything to a flat full-width layout with normal body scroll.

CSS variables driving the chrome (defined in both `html.theme-dark` / `html.theme-light`):
- `--page-bg` — outside the card. Dark `#000`, light `#F3F3F3`.
- `--canvas-bg` — inside the card, also the floating tablist bg. Dark `#171717`, light `#FFFFFF`.
- `--tab-active-bg` / `--tab-active-fg` — selected tab in the floating pill. Dark `#000`/`#fff`, light `#F3F3F3`/`#0f172a`.

Header chrome under `body.in-trip`:
- **Floating tablist** (`.nav-tabs-group` > `.view-tabs` + `.nav-add-btn`) — centered absolutely via `.nav-tabs-group`. The tab pill is 380×40, 16px radius. The search icon button sits adjacent in the same flex row. When the left panel is open, `.nav-tabs-group` shifts to `left: calc(50% + 156px)` so it re-centers within the remaining viewport space.
- **Desktop search button** (`.nav-add-btn`) — 36px circle with search icon, matches flag/hamburger style. Calls `openWishAdd()`. Hidden on mobile, dashboard, and for non-edit users. Visible on all tabs including Places. Visibility controlled by `updateFab()`.
- **Flag button** (`.app-logo-flag`) — 36px circle on the left. On **desktop** it toggles the left panel (`toggleLeftPanel()`), showing a hamburger icon when closed and a side-panel-collapse icon when open; the flag emoji is displayed inline before the trip title instead (`.app-logo-name-flag` span). On **mobile** the button keeps its legacy behavior: click navigates to dashboard (`goToDashboard()`) and the flag emoji swaps to a home icon on hover.
- **Trip name + chevron** — chevron next to the name still triggers `toggleTripDropdown(event)`. The trip switcher's dropdown has an "All Trips" entry that routes to the dashboard — primary dashboard affordance now that the flag no longer goes there on desktop.
- **Profile chip** (`.profile-chip-wrap`, desktop only) — fixed top-right (`top:12px; right:20px`). Shows avatar + display name; click opens `.profile-popover` with account info + Sign out. Replaces the viz-menu dropdown on desktop.
- **Viz-menu / hamburger** (`.viz-menu-toggle`) — still rendered in the DOM for mobile fallback; hidden on desktop via `@media (min-width:769px) { body.in-trip .viz-menu { display:none; } }`.
- **Share button** (`.share-status-btn`) — restyled to match the tablist (40h / 16r).
- **Mobile (≤768px)**: flag button and nav-add-btn hidden, trip emoji prepended to the name via `.app-logo-name[data-flag]::before`. `data-flag` attribute is set in `updateHeader()`. Viz-menu hamburger is the canonical entry for settings on mobile; no left panel.

### Left Panel (`#leftPanel`, desktop only)

When `body.in-trip` on desktop (≥769px), a fixed 280px left panel hosts trip-level tools. Slides in from the left with fade + translate via the `body.left-panel-open` class. Header padding-left and `#main-content` margin-left transition in sync to reveal the panel.

Contents top-to-bottom:
- **Faropin brand** — static text
- **Trip head** — trip name + dates + Edit button (`openTripEdit(currentTripId)`)
- **Currency converter** (inline card) — replaces the deleted `#currModal`; reuses `loadCurrRates()` / `currConvert()` / `refreshCurrRates()`
- **Weather summary card** — per-day forecast rows (`renderLpWeather()` reads `weatherData` and `DAYS`; respects `weatherUnit`)
- **Export itinerary** button — opens `#itineraryModal`
- **Toggle row** — Theme (`cycleTheme()`), Language (`setLang()`), Weather unit (`toggleWeatherUnit()`)
- **Feedback** button — opens `#feedbackModal`
- **How to use** button — opens `#howToUseModal` (static 4-section help, en + ko)
- **"Built by Jihoon"** footer

State: `leftPanelOpen` (bool, `localStorage['palo-left-panel']`, default true desktop). `toggleLeftPanel()` flips + persists + reapplies class. `applyLeftPanelState()` reconciles the class on trip entry / resize / dashboard return. `renderLeftPanel()` populates trip head + i18n labels and calls `renderLpWeather()` + `renderLpCurrency()`; called from `updateHeader()`, `applyTheme()`, and any path that changes user-visible state.

### Weather unit toggle (C/F)

Global `weatherUnit` ('c' | 'f', persisted to `localStorage['palo-weather-unit']`, default 'c'). `toggleWeatherUnit()` flips the pref, persists, and calls `fetchWeather()` which appends `&temperature_unit=fahrenheit` to the Open-Meteo request when 'f'. Weather chips display the returned rounded integer with a `°` suffix — the unit is implied by the toggle state, not repeated per chip.

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
- Desktop: `calPage` tracks page of days (group); pagination nav bar (`.cal-page-nav`) with arrows, dots, and date range label

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
- `setCalPage(idx)` — calendar day/page switch (mobile: single day, desktop: group of days)
- `calDaysPerPage()` / `calTotalPages()` / `calPageDays()` / `renderCalPageNav()` — desktop calendar pagination
- `renderWishlist()` — wishlist grid
- `initMap()` / `rebuildMarkers()` / `fitMapToDay(idx)` — Leaflet map
- `clearRoutes()` / `buildRoutes()` — OSRM walking routes per day; falls back to dashed lines
- `renderMapMobTabs()` / `renderMapMobSheet()` / `setMapMobDay(idx)` — mobile map overlay
- `setMapFilter(id, btn)` — desktop sidebar day filter
- `goToMapDay(dayId)` / `goToCalDay(dayId)` — cross-view navigation
- `openEdit(dayId, evId)` / `saveEditEvent()` / `deleteCurrentEvent()` — edit event modal
- `openAdd(dayId)` / `saveNewEvent()` — add event modal
- `openWishAdd()` / `saveWishItem()` / `deleteWishItem()` — wishlist modal
- `quickAddPlace(containerId)` / `_addQuickPlace()` — quick-add from URL without modal
- `searchPlaces(query, dropdownId)` / `selectPlace(idx, dropdownId)` — Google Places autocomplete search + selection → opens modal with pre-filled fields
- `_addPlaceFromSearch(d)` / `_populateWishModalFromSearch(d)` — create wishlist item or populate modal from Places API response
- `renderViewSearchBar(containerId, dropdownId)` — renders search bar in map sidebar
- `onQuickSearchInput(el)` / `onWishSearchInput(el)` — debounced autocomplete triggers (300ms)
- `detectCategory(name)` — returns category string from place name (used by quick-add and modal)
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

### Edit Event Modal — Simplified Layout

Two modes driven by event id prefix:

**Time block** (default, `ev_*` events): minimal form — Date, Start/End, Title, Notes. A row of pill buttons at the bottom (`+ Map link`, `+ Description`, `+ Link`, `+ Category`, `+ Optional`) reveals each optional field on demand; each revealed field has an `×` dismiss button in its label that re-hides and clears the value. The Time/Place toggle that used to sit at the top is removed entirely — new non-wishlist events always save as time blocks. `toggleEditField(field, show)` + `_resetEditFields()` drive the reveal/hide. On `openEdit()`, any populated optional field auto-reveals so legacy events look natural.

**Wishlist-linked** (`wl_ev_*` events, detected via `WISHLIST.find(w => w.calEventId === evId)`): `#editForm` gets the `mode-wishlist` class which hides title/sub/category/map fields and the pill row; only time + notes remain editable. The `#editPlaceHeader` is populated with:
- Top-aligned category icon (`align-items:flex-start` on `.edit-place-header`)
- Place name + subtitle
- **Action row**: primary "지도 보기" button (closes modal, calls `goToMapDay(dayId)`) and secondary "Google Maps ↗" link (opens `ev.mapsUrl` / `wl.mapsUrl` / `lat,lng` query in new tab)
- The shared `#editDeleteBtn` is relabeled **"시간 해제"** in this mode — `deleteCurrentEvent()` already preserves the wishlist item and only clears `calDayId`/`calEventId`/`visited`/`dayLabel`. Reset to "삭제" for non-place events.

To add a new place, users flow through the Places tab (wishlist → Add to Schedule). Calendar-click empty slots only create time blocks — one true path per CLAUDE.md's event-type-as-id-prefix invariant.

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

**Auth:** Firebase Auth with **Google sign-in** (popup). `auth.onAuthStateChanged` gates all routing — unauthenticated users see a login screen, unless the URL is a public trip (`#trip/<id>` where `trip.public === true`), in which case `_isPublicView = true` and the trip loads read-only without auth. `currentUser` holds the Firebase user object. Viz-menu (hamburger + share button) hidden on login screen.

**User profiles:** `users/{uid}` doc with `email`, `displayName` — written on sign-in via `writeUserProfile(user)`.

**Trip access control:** Trip metadata has `access: { [uid]: 'owner'|'write' }` and `accessEmails: [email]` for query indexing.
- `getTripRole()` — returns `'owner'`, `'write'`, or `'none'` based on `currentUser.uid` in `currentTripMeta.access`
- `canEdit()` — true for `owner` or `write` roles
- `isOwner()` — true for `owner` only

**Sharing UI:** Owner-only share modal (`#shareModal`) to invite by email. `addShareUser(e)` looks up user by email in `users` collection — if found, adds UID to `access`; if not, adds `pending_<email>` entry. Pending invites auto-resolve on sign-in via `resolvePendingInvites(user)`. `renderShareList()` also auto-resolves stale pending entries and fixes corrupted dot-path entries (where Firestore split `pending_user@gmail.com` into nested `{"pending_user@gmail":{"com":"write"}}`). Share status button in header shows lock icon when private, globe icon when public, member count when shared. Share button hidden on dashboard.

**Public trip links:** Owner can toggle `public: true` on a trip via the share modal's "Public Link" toggle. When enabled, a copyable URL is shown. Unauthenticated users can view public trips read-only — all edit UI is hidden via existing `canEdit()` gates. Firestore rules allow anonymous reads when `resource.data.public == true`. `_isPublicView` global flag tracks public viewing state.

**Authorship:** Wishlist items have `addedBy` (display name), `addedByPhoto` (Google avatar URL), `addedByUid` (Firebase UID), and `addedAt` (epoch ms). Calendar events also have `addedByUid` and `addedAt`. Shown as avatar or initials chip on wishlist cards.

### Activity Badges

Tab notification badges show when a collaborator adds new places or schedules events. Red badge pill with count on Calendar/Places tabs; clears when the user switches to that tab. Red dot on individual new cards/events from other users, auto-expires after 24 hours.

- `updateTabBadges()` — counts items where `addedByUid !== currentUser.uid && addedAt > lastViewed`, renders `<span class="tab-badge">` on tab buttons
- `_isNewItem(item)` — returns true if item was added by someone else within the last 24 hours (used for red dot rendering)
- `lvKey(tab)` / `getLV(tab)` / `setLV(tab)` — localStorage-based `lastViewed` timestamps per trip per tab
- Called from `switchView()` (sets lastViewed + updates badges), `rerender()` (updates badges on remote changes)
- Legacy items without `addedByUid`/`addedAt` fields are silently ignored

### Internationalization (i18n)

Two languages: English (default) and Korean. `STRINGS` dictionary with `{ko, en}` pairs (some entries are functions for parameterized strings like `dayN`). `t(key)` lookup returns current language value. `setLang(lang)` persists to localStorage, calls `applyLangToStaticHTML()`, `refreshDayLabels()`, and re-renders. `refreshDayLabels()` regenerates `day.date` and `day.dayName` from `isoDate` using current language — must be called after `reconcileDays()` and inside `onSnapshot` handler to prevent Firestore overwriting labels.

City search (Nominatim) always uses `Accept-Language: en` so stored city names are English. One-time migration (`city-en-v1`) reverse-geocodes existing Korean city names.

### Place Cards

Place cards in the Places tab have this structure (top to bottom):
1. **Photo** (optional, from Google Places API, `wl-card-photo`)
2. **Name + notes + author (top slot)** — author chip = `[avatar] Display Name 👍 N` with the Like button inline next to the name. `voteBtnH` is assembled once and injected into both the top slot (visible in grid view) and the meta row below (visible in list view).
3. **Place details** — editorial summary (italic), price/hours/phone meta row via `placeDetailsHtml()`
4. **Category + author (meta slot) + Edit Place row** — category label on left, author+Like chip appended (hidden in grid, shown in list), "Edit Place" button on right
5. **Schedule row** — if scheduled: date/time on left + "Edit Schedule" button on right; if unscheduled: right-aligned "+ Schedule" button
6. **Dividing line** (`<hr>`)
7. **Links row** — left-aligned inline text links: Google Maps ↗, Web, phone number (`.wl-card-links`)

Cards have no whole-card tap target — interaction is through distinct buttons. No hover lift effect. All action buttons use `.wl-visited-toggle` for uniform sizing (30px height).

**Add panel** (`.wl-add-panel`): the quick-add search input + Discover pills are grouped into one light-tinted card at the top of the Places tab (`color-mix(in srgb, var(--text) 3%, transparent)`). Discover label is inline with the pills and reads `🌐 Explore near <city>:`.

**View toggle** (`.wl-view-toggle`): grid / list switcher on the right side of the Places header, persisted via `localStorage['palo-wish-view']`. `wishViewMode` controls the `.wl-grid.grid` / `.wl-grid.list` class. List view uses a 2-column CSS grid per card when a photo exists (60×60 thumbnail spans all rows; all other children flow in column 2). In list view, Edit Place is absolute-positioned to the top-right, category + author meta row appears under the title, and Like button sits inline next to author.

**Category filter chips**: `all / food / bar / culture / hotel / transport` plus a status row (`all / unscheduled / scheduled`) and a `Most loved` sort toggle that applies `sortByVotes(list)` to the filtered wishlist.

### FAB (Floating Action Button)

**Mobile only.** Fixed-position "Add Place" button (`.fab`). Hidden on dashboard, on mobile map view (≤768px), for non-editable trips, and **on desktop** (replaced by `.nav-add-btn` in the navbar). Visibility updated via `updateFab(v)` — also re-evaluated on `window.resize`.

### Google Places Search

Dual-mode input: detects URL pattern (→ URL expansion via worker) vs. search text (→ Google Places Autocomplete API). Session tokens (`crypto.randomUUID()`) bundle autocomplete + details requests for billing. Location bias uses trip city coords (50km radius).

**Worker endpoints** (`worker.js`):
- `POST /api/places/autocomplete` — proxies Google Places Autocomplete (New) API
- `GET /api/places/details?placeId=...` — proxies Google Places Details (New) API with enterprise-tier field mask including `rating,userRatingCount`
- `POST /api/places/discover` — proxies Google Places Text Search (New) API for bulk discovery (returns top 5 results for a category in a city, deduplicates against existing places)
- `GTYPE_TO_CAT` maps Google `primaryType` → app categories (food, bar, culture, hotel, transport)
- `DISCOVER_CATEGORIES` maps 6 category keys → query templates + Google types

**Add-place modal** (`#wishModal`): Two-mode toggle — "Search a place" (default, search input + form) and "Recommend me" (category buttons + inline results). Shows photo preview (`#wishPhotoPreview`) and indigo checkmark in hint text (`#wishMapsHint`) when place data is populated from search. Toggle hidden in edit mode.

**Discover Places**: Six categories (Restaurants, Cafes, Bars, Museums/Attractions, Bakeries, Parks). Two entry points: Places tab horizontal pill buttons → standalone `#discoverModal`, and Add Place modal recommend pane → inline results. Results show photo, name, address, rating (stars + count), price level, with individual Add buttons + "Add All" footer. Per-session cache (`_wishRecommendCache`) keyed by `tripId:category` avoids repeated API calls.

### Currency Converter

Inline card inside the desktop left panel (`#lpCurrencyCard`, rendered by `renderLpCurrency()`). Rate from `https://api.frankfurter.dev/v1/`. Currency auto-detected from trip's `cityCountryCode` via `CC_TO_CURR` map / `_detectTripCurrency()`. The standalone `#currModal` and `openCurrConverter` / `closeCurrConverter` functions are removed; mobile has no currency UI this pass (follow-up ticket will port to a mobile sheet).

### Lodging chips (calendar day header)

Each day object may carry `day.lodgingWishId`, a pointer to a wishlist item with `category:'hotel'`. `renderDayChips(day)` renders a full-width `🏨 <hotel name>` chip under the date in both the desktop (`renderCalHeader`) and mobile (`renderCalDayNav`) headers. Empty days show a dashed `+ 🏨 Lodging` button when `canEdit()`.

`openLodgingModal(dayId)` opens `#lodgingModal` — a picker of WISHLIST items (default-filtered to `category === 'hotel'`, "show all" checkbox, plus an inline Google Places search input that creates a new wishlist item with the forced category on selection via `_addPlaceForChip`). An "Apply to all days" checkbox bulk-assigns the selection across `DAYS[*].lodgingWishId` when saving. Orphan pointers (item deleted from wishlist) gracefully render as empty via `resolveLodging(day)` returning null.

When a trip is created, `_seedAirportWishlistItem(city, lat, lng, timeoutMs)` fires a best-effort Google Places autocomplete for `"<city> airport"` and includes the top result in the initial wishlist with `category:'transport'` (3.5s timeout — trip creation never blocks on a slow Places API).

### Itinerary export (markdown)

`buildItineraryMarkdown(metaArg?, daysArg?, wishlistArg?, weatherArg?, opts?)` — pure function returning a markdown string. Optional args let it be reused for bulk export of other trips (passing loaded data); default args read current trip globals. `opts.headingLevel` shifts the heading depth (used in bulk export to nest trips under an H1 wrapper); `opts.skipPromptStub` suppresses the trailing "Notes for the LLM" paragraph.

Output sections: trip header (city, flag, dates, party size, timezone), Weather table (historical-avg footnote for dates beyond forecast window), Overview (event counts, category histogram, scheduled/unscheduled split), Lodgings (deduped hotel list with night dates), Itinerary (per-day headers include weather + lodging prefix, events sorted by time with wishlist details inline), Unscheduled Places grouped by category, and an LLM prompt stub.

- **Per-trip export**: `openItineraryModal()` in the left panel → Generate → Copy / Download `.md`.
- **Bulk export** from dashboard: "Export multiple" CTA → `openBulkExportModal()` → select trips → loads each trip's data (localStorage → Firestore fallback) → concatenates under a single `# Faropin Trip Export` wrapper with `---` separators.

### Email Notifications

Sent via **Resend** (`noreply@faropin.com`). Bilingual templates (en/ko) follow user's `lang` preference.
- **Welcome email** — triggered on first sign-in (`welcomeEmailSent` flag in user profile)
- **Invite email** — fire-and-forget on `addShareUser()`, includes trip name/city/dates
- **Trip reminders** — cron worker (`0 9 * * *`) sends reminders 7 days and 1 day before departure
- Email templates use Faropin thumbnail (`og-image.jpg`) as header image
