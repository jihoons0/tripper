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

**There is no linter or build step, and the only automated test is `npm run test:sync` (multiplayer sync).** Verification is manual: run `npm run dev` and exercise the change in a browser (the Playwright MCP server is configured for this). Since the app writes straight to production Firestore from the browser, any change touching `doSave()` / `reconcileDays()` / delete paths should be tested against a throwaway trip, not a real one — see **Data Safety**.

## Deployment

- **Vercel project:** `palo-travel` (team: `jihoon-suhs-projects`) — internal project name, not renamed; users never see it
- **Production URL:** https://faropin.com (purchased on GoDaddy; GoDaddy DNS holds `A @ 76.76.21.21` + `CNAME www cname.vercel-dns.com`). Legacy alias `https://palo-travel.vercel.app` also points to the same deploy and is preserved so pre-rename share links keep working.
- **Deploy command:** `vercel --prod` (auto-aliases to `faropin.com`) then `vercel alias set <deploy-url> palo-travel.vercel.app` to refresh the legacy alias
- **Firebase `authDomain`:** `faropin.com`. Requires `faropin.com` + `www.faropin.com` in Firebase Auth → Settings → Authorized domains. `palo-travel.vercel.app` is also still in the authorized list (remove only after confirming no traffic hits it).
- **Google Places API key:** HTTP referrer allowlist must include `https://faropin.com/*` and `https://www.faropin.com/*`. (Key lives as a Cloudflare Worker secret, so referrer checks fire on Worker-originated requests — if the key has restrictions at all.)
- `vercel.json` routes `/__/auth/*` to Firebase auth proxy, `/api/*` to Vercel Node functions, and everything else to `index.html`. The auth proxy matches on path, not host, so it works on both `faropin.com` and the legacy alias.

**Cloudflare Worker** (`worker.js` + `wrangler.toml`): handles Google Maps URL expansion, Google Places API proxy (autocomplete, details, discover), and email notifications. `index.html` calls the worker directly (Vercel's `/api/expand-url` is blocked by auth protection on the team plan).
- Worker URL: `https://palo-travel-expand-url.jihoon8846.workers.dev`
- Endpoints: `GET /api/expand-url`, `POST /api/places/autocomplete`, `GET /api/places/details`, `POST /api/places/discover`, `GET /api/places/photo`, `POST /api/email/welcome`, `POST /api/email/invite`
- **Photo proxy:** Google photo bytes are never fetched directly from the browser. `buildPlacesPhotoProxyURL()` rewrites `photos[0].name` into a worker-origin `/api/places/photo` URL, and *that* string is what gets persisted as a wishlist item's `photoUrl` in Firestore. Changing the worker URL therefore breaks every stored photo — treat the workers.dev hostname as a data-model dependency, not just a deploy detail.
- Cron: `0 9 * * *` — daily trip reminder emails (7d + 1d before departure)
- Secrets: `GOOGLE_PLACES_API_KEY`, `RESEND_API_KEY`, `FIREBASE_SERVICE_ACCOUNT` (set via `wrangler secret put`)
- Deploy: `npx wrangler deploy` (requires Cloudflare login)
- **Category contract / deploy order:** the worker's `GTYPE_TO_CAT` / `DISCOVER_CATEGORIES` may only return categories the live app knows. When adding one (as with `shopping`), deploy the **app first**, smoke-test it on a throwaway trip, **then** the worker; roll back in reverse (worker first, `npx wrangler rollback`). An older app build that receives an unknown category has no matching `<option>`, so saving the Place modal writes `category: ''`, a permanent loss. Until the worker ships, the new Discover pill just fails with a 400 (nothing is written).

**Data:** Firebase/Firestore (project: `mexico-trip-c5644`), localStorage as cache (see **Trip cache** under Multiplayer sync).

**Firestore security rules** (`firestore.rules`, deployed; changing them needs `npx firebase deploy --only firestore:rules`, `.firebaserc` pins project `mexico-trip-c5644`). What the deployed rules allow, and what the client mirrors in `getTripRole()`:
- **Trips.** Read: `public == true`, or a signed-in user whose lowercased token email is in `accessEmails` ("member"). Create: `ownerId == auth.uid`. Delete: the owner only. Update: the owner (anything); an invitee resolving their own invite (`pending_<email>` swapped for their uid as `'write'`, or the role that uid already had, touching only `access`); a member with `access[uid] == 'write'` changing trip details only (`name`, `emoji`, dates, `timezone`, `coverColor`, `partySize`, `city*`), never ownership, sharing, `public` or `archived`; any non-owner member leaving (removes only their own uid / pending key from `access` and their email from `accessEmails`).
- **`trips/{id}/data/{doc}`.** Read: public trip or member. Create/update: the owner or a member (email in `accessEmails`). **Delete: never** (no version history).
- **`users/{uid}`.** `get` when signed in; `list` only with `limit <= 1` (every email lookup is `.limit(1)`); create/update only your own doc, and `email` must equal your token email lowercased (so an invite by email can't be steered to another account); no delete.
- **`feedback/`.** Create when signed in. **Caveat:** read and update are still open to anyone, because `fetch-feedback.js` uses the unauthenticated client SDK; lock them down only after that script moves to the Admin SDK, or `npm run feedback` breaks.
- Legacy `travel/**` stays public-read, no writes.
- There is no `rev` check in the rules, so a tab still running a pre-merge build (blind `DATA_REF.set()`) can overwrite merged data; a rule requiring `rev` to increase may only be deployed once no such build remains open, or it would refuse every save from it.

## Feedback Workflow

`npm run feedback` fetches bug/feature reports from Firestore `feedback/` collection into `feedback.md`. **Always read items aloud and ask permission before resolving** — never auto-resolve. Resolve with `npm run feedback:resolve <id>` (= `node fetch-feedback.js resolve <id>`).

## File Structure

- `index.html` (~8,500 lines) — the entire app: HTML, CSS, and JS in one file. Use offset/limit when reading.
- `tests/sync.test.js` — the multiplayer sync harness behind `npm run test:sync` (see **Multiplayer sync**)
- `server.js` — Express dev server; serves static files + `/api/expand-url` for local Google Maps URL expansion
- `api/expand-url.js` — Vercel serverless function (same expand-url logic, but bypassed in prod due to Vercel auth)
- `worker.js` + `wrangler.toml` — Cloudflare Worker: Google Maps URL expansion + Google Places API proxy (autocomplete, details, discover) + email notifications (welcome, invite, trip reminders via Resend)
- `fetch-feedback.js` — Node script behind `npm run feedback` / `npm run feedback:resolve`
- `firebase.json` / `.firebaserc` — Firebase CLI config; only used to deploy `firestore.rules`
- `categorize-wishlist.js` / `fix-categories.js` / `import-saved-places.js` — one-off Node scripts for data migration (not part of the app). **Do not re-run:** they predate `shopping`, overwrite the whole data doc with `setDoc` (no merge, no `rev`), and use the unauthenticated client SDK, which the current rules refuse anyway
- `product.md` / `TODO.md` / `itenary.md` — planning docs (not code)
- `archive/01-…` … `archive/07-…` — **seven frozen full copies of `index.html`** (1k–6.3k lines each), snapshots of the app at past milestones, plus `archive/README.md` (the build story). They are never edited as part of feature work.

**Grep hazard:** because of `archive/`, a repo-wide search for any app symbol returns 8 hits — one real, seven historical. Scope searches to the live app (`grep -n "renderCal(" index.html`) or exclude the folder (`--exclude-dir=archive --exclude-dir=node_modules`); `node_modules/` is also untracked-but-present since `.gitignore` only lists `.vercel`.

**Static assets are opt-in:** `index.html` is the catch-all route, so any new top-level file (favicon, `og-image.jpg`, `manifest.json`, `robots.txt`, `sitemap.xml`) must be added to **both** the `builds` array and the `routes` regex in `vercel.json` or it 200s with the HTML page instead of the asset.

## Architecture

Everything lives in `index.html`: HTML, CSS (CSS variables for theming), vanilla JavaScript. No frameworks, no bundler. CDN libraries:
- **Leaflet 1.9.4** — interactive map (`#leaflet-map`)
- **cobe** — interactive 3D globe on dashboard (via `esm.sh/cobe`)

### Icons

All icons use **Heroicons v2 outline** SVGs via the `ICONS` object and `icon(name, size)` helper function (an unknown name falls back to `pin`). Category icons via `catIcon(cat, size)`. **Never use emoji** for UI elements — only country flag emoji are acceptable. (Existing exception, kept for consistency: native category `<select>` option labels, `STRINGS.catOpt*` such as `🛍️ Shopping`, because an `<option>` can't hold an SVG. Discover pills and the `#discoverModal` title are text only now.) The itinerary markdown export is text, not UI, and keeps its emoji (weather, `🏨`). A trip with no flag (`emoji` empty) shows the `globe` icon instead, in the header flag button, before the trip name and in the bulk-export list. SVG icons available: `calendar`, `map`, `star`, `pencil`, `trash`, `food`, `bar`, `culture`, `hotel`, `conference`, `transport`, `shopping`, `pin`, `globe`, `currency`, `home`, `plus`, `minus`, `phone`, `link`, `code` (left panel's Export row), `search` / `x` (the search field's magnifier and clear button, see **Search field**), `bug` / `bulb` (the feedback modal's Bug / Feature buttons, set in `applyLangToStaticHTML`; their `STRINGS` carry no emoji), and the weather set `wxSun`, `wxPartly`, `wxCloud`, `wxFog`, `wxRain`, `wxShowers`, `wxSnow`, `wxStorm` (see **Weather icons**). `wxSun` / `wxCloud` are Heroicons; the other weather glyphs are drawn on the same 24px grid and 1.5 stroke, a 75% cloud with rain, snow, fog or a bolt underneath.

### Data Model

Per-trip data stored at `db.collection('trips').doc(tripId).collection('data').doc('main')` as `{ days, wishlist, rev, revEpoch }` (`rev` is a sync counter bumped by every merge commit, `revEpoch` names the run of that counter, see **Multiplayer sync**). The whole trip is this one doc, so it is capped at Firestore's 1 MiB.

Trip list stored at `db.collection('trips').doc(tripId)` (metadata: `name`, `emoji`, `coverColor`, `startDate`, `endDate`, `city`, `cityDisplayName`, `cityLat`, `cityLng`, `cityCountry`, `cityCountryCode`, `timezone`, `partySize`, plus `ownerId`, `ownerEmail`, `access`, `accessEmails`, `public`, `archived`, and `type:'hometown'` for the undated hometown trip; see **Authentication & Sharing**). **Note:** the city name field is `city`, not `cityName`. `partySize` is an integer (default 1) set from the trip create/edit modal; surfaced in the exported itinerary markdown.

`DAYS` and `WISHLIST` are loaded via `loadTripData(tripId)`. Each day has `id`, `date`, `dateShort`, `theme`, `color`, `isoDate`, `events[]`, and optionally `lodgingWishId` (pointer to a wishlist item with `category:'hotel'`) rendered as a full-width chip in the calendar day header. Each event has `id`, `time`, `endTime`, `title`, `subtitle`, `notes`, `category`, `optional`, `lat`, `lng`, optional `mapsUrl`/`link`.

**Wishlist items** additionally have Google Places fields: `googlePlaceId`, `photoUrl`, `websiteUrl`, `primaryType`, `openingHours` (weekday strings array), `editorialSummary`, `priceLevel` (0-4), `phoneNumber`, `rating` (1-5 float), `userRatingCount` (integer). They may also have `votes: { [uid]: { name, photo, at } }` — up-only thumbs from collaborators, with denormalized voter info so avatars render without async user lookups (legacy string `'up'` values are also tolerated). These are populated when adding a place via Google Places search or discover. Helper functions: `fmtPrice(level)`, `getTodayHours(openingHours)`, `placeDetailsHtml(w, compact)`, `voteCount(w)`, `hasUserVoted(w)`, `voterList(w)`, `toggleVote(id)`, `sortByVotes(list)`.

**Event id prefix is the source of truth for "is this a place vs. a time block":** events created from a wishlist place use id `wl_ev_*`; standalone time blocks use `ev_*`. There is no `type` field. The reliable check is `WISHLIST.some(w => w.calEventId === ev.id)`; the cheap heuristic is `ev.id.indexOf('wl_ev_') === 0`. Calendar rendering uses this to color events (see Theme/Calendar sections).

**One event per place** (except `hotel` / `transport`, `_multiAssignCat`, which get a new `wl_ev_<genId>` per night or leg): every scheduling path goes through `_schedulePlace(w, day, s, e, notes, fe)`. A place's event id is deterministic, `'wl_ev_' + w.id`, and moving it to another day moves the same object and keeps its id, so two people scheduling the same place at once merge into one event instead of leaving twins. Look events up by id across the whole trip with `_findEv(evId)` → `{day, ev}` (or `_findEvOn(dayId, evId)` when an old trip may hold two events with one id); remove with `_dropEv(evId)`. A stored `calDayId` / `editingDayId` can be behind a collaborator's move, so never assume the event is still on it.

Changes auto-saved via `scheduleSave()` → `doSave()` (debounced 1s) → writes to localStorage + Firestore through `_commitTripData()` (a merging transaction — never `DATA_REF.set()` directly). Both are no-ops unless `canEdit()`.

`DATA_REF` points to the current trip's Firestore doc. `currentTripId` / `currentTripMeta` hold active trip state.

Category constants: `CAT` object (`food`, `bar`, `culture`, `shopping`, `hotel`, `conference`, `transport`, `other`; `shopping` is pink `#ec4899`). Icons: `catIcon(cat, size)`, which falls back to `pin` for `other` or any category missing from `_catKeys` / `ICONS`. Labels: `catLabel(cat)` (the only definition) reads `_catKeys`. Every `CAT[x]` lookup uses `CAT[x] || CAT.other`.

**Adding a category** touches: `CAT`, `_catKeys`, `ICONS`, `STRINGS` (`cat<Name>`, `catOpt<Name>`, and `discover<Name>` if it gets a Discover pill), the `<option>`s in `#wishCategory` and `#editCategory` (relabeled by **value** in `applyLangToStaticHTML`, so order doesn't matter), the Places filter chip row in `renderWishlist`, `detectCategory`, the itinerary export's `_ITN_CATS` **and** its unscheduled-section `order` array (a category missing from `order` is silently dropped from the export), optionally `DISC_TITLE`, and the worker (see the deploy-order note under **Deployment**).

### Routing

Hash-based: `navigateTo('#dashboard')`, `navigateTo('#trip/<tripId>')`. `DOMContentLoaded` reads `location.hash` to decide initial view. Trip links percent-encode the id (`encodeURIComponent`); `_hashTripId(hash)` decodes it once and tolerates legacy raw links. Any route other than a trip goes through `showDashboard()`, which leaves the open trip via `_exitTrip()`.

### Views

- **Dashboard** (`#view-dashboard`) — globe (cobe.js) + "+ Add New Trip" CTA + trip cards grid. `renderDashboard(trips)` / `loadDashboard()`. Uses original page bg (no inset chrome). `loadDashboard()` never touches the open trip's listeners (leaving a trip goes through `_exitTrip()`).
- **Calendar** (`#view-calendar`) — time-grid, 8AM–midnight, 64px/hr (`HOUR_PX`). `renderCal()`. Desktop: paginated when days exceed viewport (min column width `CAL_COL_MIN=160`px). `calDaysPerPage()` / `calTotalPages()` / `calPageDays()` / `renderCalPageNav()`.
- **Map** (`#view-map`) — Leaflet map + sidebar (desktop) / fullscreen + overlay (mobile). `initMap()` / `rebuildMarkers()`. Desktop sidebar has the same search field as the Places tab at the top (`renderViewSearchBar()` → `_searchFieldH()`, see **Search field**).
- **Places** (`#view-wishlist`) — card grid with category/status filters. `renderWishlist()`. Tab is labeled "Places" in the UI; the underlying view id and `WISHLIST` array still use the legacy "wishlist" name. **Search field** at top (visible when `canEdit()`; see **Search field**) — type to search via Google Places API autocomplete or paste a Google Maps link. Selecting from autocomplete opens the add-place modal with fields pre-filled (photo, name, category, address, coords). `quickAddPlace()` / `_addQuickPlace()` / `_addPlaceFromSearch()` / `_populateWishModalFromSearch()`.

Three in-trip views toggled via `switchView(v)`; the tab buttons call `onTabTap(v)`, which on the tab already showing calls `_scrollViewHome(v)` instead (Calendar: scroll to the first event; Map: refit the day or all markers; Places: top). Tab labels: **Calendar / Map / Places** (English). `body.in-trip` class is added/removed by `switchView()` and the dashboard route to drive the chrome (see Trip Canvas Chrome below).

Tab switches animate directionally by tab order (calendar → map slides in from the right; map → calendar from the left) via `view-enter-right` / `view-enter-left`; first entry uses `view-enter` (rise). `_prevTripView` tracks the previous tab, reset in `goToDashboard()`. Under `prefers-reduced-motion` all view enters become opacity fades (`viewFade`), transitions/animations are near-instant, but the loading spinner, the button spinners and the sign-in busy spinner keep spinning (status feedback). `prefers-reduced-transparency` drops `backdrop-filter` from chrome surfaces.

### Trip Canvas Chrome (design-update)

When `body.in-trip` is set, the trip views render inside an inset rounded "canvas card" pinned to the viewport (height = `100vh - 80px`). Content scrolls inside the card; body scroll is suppressed. Mobile (≤768px) reverts everything to a flat full-width layout with normal body scroll.

CSS variables driving the chrome (defined in both `html.theme-dark` / `html.theme-light`):
- `--page-bg` — outside the card. Dark `#000`, light `#F3F3F3`.
- `--canvas-bg` — inside the card, also the floating tablist bg. Dark `#171717`, light `#FFFFFF`.
- `--tab-active-bg` / `--tab-active-fg` — selected tab in the floating pill. Dark `#000`/`#fff`, light `#F3F3F3`/`#0f172a`.

Header chrome under `body.in-trip`:
- **Floating tablist** (`.nav-tabs-group` > `.view-tabs` + `.nav-add-btn`) — centered absolutely via `.nav-tabs-group`. The tab pill is 380×40, 16px radius. The search icon button sits adjacent in the same flex row. When the left panel is open, `.nav-tabs-group` shifts to `left: calc(50% + 156px)` so it re-centers within the remaining viewport space.
- **Desktop search button** (`.nav-add-btn`) — 36px circle with search icon, matches flag/hamburger style. Calls `openWishAdd()`. Hidden on mobile, dashboard, and for non-edit users. Visible on all tabs including Places. Visibility controlled by `updateFab()`; while the trip is still loading it stays in place (so the centred pill doesn't jump) but carries `aria-disabled`, and a click only explains why (`_addBlocked()`).
- **Flag button** (`.app-logo-flag`) — 36px circle on the left. On **desktop** it toggles the left panel (`toggleLeftPanel()`), showing a hamburger icon when closed and a side-panel-collapse icon when open; the flag emoji is displayed inline before the trip title instead (`.app-logo-name-flag` span). On **mobile** the button keeps its legacy behavior: click navigates to dashboard (`goToDashboard()`) and the flag emoji swaps to a home icon on hover. A trip without a flag shows `icon('globe')` in both spots (set with `innerHTML`, the emoji escaped).
- **Trip name + chevron** — `#appLogoText` is a `<button>` that triggers `toggleTripDropdown(event)`. On desktop it is hidden while the left panel is open (the panel's `#lpTripSelect` takes over); with the panel collapsed (and always on mobile) it shows only the city (`#appLogoCompact`) with a status line (`#appLogoDepart`, `_tripDepartLabel()`) underneath: "Day 3 of 7" during the trip (`data-live`), "Oct 10 · In 12 days" in the 60 days before it, otherwise just the departure date. Long names truncate with an ellipsis. The trip switcher's dropdown has an "All Trips" entry that routes to the dashboard — primary dashboard affordance now that the flag no longer goes there on desktop; long lists scroll inside the dropdown with "All Trips" pinned. `updateHeader(meta, {keepDropdown:true})` (live meta updates) redraws an open dropdown via `_refreshOpenTripDropdown()` instead of closing it.
- **Profile chip** (`.profile-chip-wrap`, desktop only) — fixed top-right (`top:10px; right:20px`). Shows avatar only (name hidden). Click opens `.profile-popover` with account info + Sign out. Replaces the viz-menu dropdown on desktop.
- **Viz-menu / hamburger** (`.viz-menu-toggle`) — still rendered in the DOM for mobile fallback; hidden on desktop via `@media (min-width:769px) { body.in-trip .viz-menu { display:none; } }`.
- **Share button** (`.share-status-btn`) — moved outside `.viz-menu` to its own fixed-position element. Hidden on desktop in-trip (lives in the left panel instead) and hidden on phones too (`display:none !important` at ≤768px), where the viz-menu's Share entry (`#shareMenuBtn`) opens the share modal. `updateShareBtnVisibility()` still sets its label (lock / globe / member count) and hides it from non-members.
- **Flag button hidden on dashboard** — `body.on-dashboard .app-logo-flag { display:none !important }` prevents stray hamburger/collapse icons on the dashboard view.
- **Mobile (≤768px)**: flag button and nav-add-btn hidden, header trip label shows the city with the status line underneath (same as desktop with the panel collapsed; no flag emoji). Viz-menu hamburger is the canonical entry for settings on mobile; no left panel. Its entries: Share (`#shareMenuBtn`, members only), Export itinerary (`#exportItineraryMenuBtn`), **Edit trip** (`#editTripMenuBtn` → `openTripEditFromMenu()`, shown when `canEdit()`; the phone counterpart of the left panel's Edit trip row), Theme, Feedback, Language, then the account block with Sign out. `updateShareBtnVisibility()` toggles the three trip entries.

### Left Panel (`#leftPanel`, desktop only)

When `body.in-trip` on desktop (≥769px), a fixed 280px left panel (`z-index:250`, above the header at 200) hosts trip-level tools. Slides in from the left with fade + translate via the `body.left-panel-open` class. Header padding-left and `#main-content` margin-left transition in sync to reveal the panel. Trip name + dates stay in the main header bar (not duplicated in the panel).

Contents top-to-bottom:
- **Weather** accordion (`.lp-card`) — section label "Weather" (`.lp-card-title` style), avg high/low on the right, chevron on far-right pointing down (rotates 180° when open). Toggle is a static HTML `button#lpWxToggleBtn` with inline `onclick` and `aria-expanded`; `renderLpWeather()` only updates text + list rows + `aria-expanded` (never rebuilds the toggle). Per-day rows show the weather icon (`wxIcon(w,16)`, a `·` for a day without data) + date + high°/low°. Default closed (`_lpWxOpen = false`).
- **Currency converter** (`.lp-card`, currently `display:none`) — inline card replacing the deleted `#currModal`; reuses `loadCurrRates()` / `currConvert()` / `refreshCurrRates()`. Hidden pending redesign.
- **Share** card (`.lp-card`) — section label "Share". Two button rows (SVG icons, like every row here): `N travelers · Share` (opens `#shareModal`; members only) and `Copy link` (calls `copyPublicLink()`, disabled when trip is not public with "Public only" hint).
- **Settings** card (`.lp-card`) — section label "Settings". Two button rows: `Export itinerary` (`icon('code')`) with "Export as itinerary.md" subtitle (opens `#itineraryModal` and auto-generates markdown immediately) and `Edit trip` (pencil; opens `openTripEdit(currentTripId)`, gated by `canEdit()`).
- **Spacer** — flex:1
- **Feedback + How to use** — 2-column grid row (each a `.lp-button`)
- **"Built by Jihoon"** footer
- **Toggle row** — Theme (`cycleTheme()`), Language (`setLang()`), Weather unit (`toggleWeatherUnit()`)

State: `leftPanelOpen` (bool, `localStorage['palo-left-panel']`, default true desktop). `toggleLeftPanel()` flips + persists + reapplies class, re-paginates an open Calendar (`_onCalResize()`, since the panel changes how many day columns fit) and re-measures the map after the slide. `applyLeftPanelState()` reconciles the class on trip entry / resize / dashboard return. `renderLeftPanel()` populates share/settings labels + i18n and calls `renderLpWeather()` + `renderLpCurrency()`; called from `updateHeader()`, `applyTheme()`, and any path that changes user-visible state.

### Weather unit toggle (C/F)

Global `weatherUnit` ('c' | 'f', persisted to `localStorage['palo-weather-unit']`, default 'c'). `toggleWeatherUnit()` flips the pref, persists, and calls `fetchWeather()` which appends `&temperature_unit=fahrenheit` to the Open-Meteo request when 'f'. Weather chips display the returned rounded integer with a `°` suffix — the unit is implied by the toggle state, not repeated per chip.

### Weather icons

`fetchWeather()` stores `weatherData[iso] = {tempMax, tempMin, code, icon}` (in memory only, never cached). The UI draws **SVG icons from the WMO `code`**; `icon` is the old emoji from `wmoIcon(code)`, kept only for the itinerary markdown export (`_itnWeatherStr`, the weather table, day headers).
- `wmoKey(code)` → `ICONS` key: `0` `wxSun`, `1–2` `wxPartly`, `3` `wxCloud`, `≤48` (45/48) `wxFog`, `65` `wxShowers` (heavy rain), the rest of `51–67` (drizzle, rain, freezing rain) `wxRain`, `71–77` `wxSnow`, `80–82` `wxShowers`, `85–86` `wxSnow`, anything above `wxStorm`. A missing or non-numeric code returns `''` (no icon, the temperatures still show).
- `wxIcon(w, size)` → `<span class="wx-ic" role="img" aria-label title>` around the icon, labelled via `WX_LABEL` → `STRINGS.wxClear` / `wxPartly` / `wxCloudy` / `wxFog` / `wxRain` / `wxShowers` / `wxSnow` / `wxStorm`. Icons use `currentColor`, so they follow the surrounding text color in both themes.
- Used by `weatherChip(day)` (desktop calendar headers, the phone day meta line), `mapWeatherChip(day)` (desktop map sidebar day groups), the left panel's weather rows, the phone map sheet's weather row, and the phone calendar date strip (12px, in place of the day-color dot).

### Dashboard

- **Cobe globe** — 3D interactive globe with flag emoji overlays positioned via `projectGlobe()`. Uses `createGlobe()` + `globe.update({ phi })` + `requestAnimationFrame` loop. Markers show trip locations. It makes no Firestore reads (the old per-trip `getPinCount` is gone).
  - **Lifecycle / generation token:** `initCobe(trips)` is synchronous up to the `import(COBE_URL)` (`https://esm.sh/cobe`). `destroyCobe(keepReady)` bumps `_cobeGen`, and an init whose module arrives after that (dashboard rendered from cache then from the server, a theme toggle, a trip opened) returns without starting a second loop or drawing on a hidden canvas. Each loop also only drives the globe it created. `applyTheme` rebuilds only a globe already on screen (the dark flag is read when the globe is created, not when init starts); `showLoginScreen` destroys the globe and prefetches the module after 1s.
  - **Fade-in:** `#cobeCanvas` starts at `opacity:0` and gets `.is-ready` after the first drawn frame; `#globeOverlay` (the flags) fades with it, so the blank canvas never flashes. A re-init in place (`destroyCobe(true)`) keeps `.is-ready`; leaving the dashboard clears it.
  - **Rotation:** `_cobeS` holds `phi` for every loop and the drag handlers. It is seeded once to face the first trip; later inits keep the current rotation. Auto-spin is delta-time based (`COBE_AUTO`, 0.0003 rad/ms), so it doesn't depend on the display's refresh rate.
  - **Drag:** Pointer Events bound once per page (`_cobeBind`), with pointer capture; horizontal movement only. `touch-action:pan-y pinch-zoom` leaves vertical drags to the page (they end in `pointercancel`).
  - **Reduced motion:** no auto-spin. The loop idles (`cobeRafId = null`) once a frame changes nothing, but not in the first second (cobe loads its land texture asynchronously); a drag, scrolling back into view, or the media query turning off restarts it (`_cobeResume`).
  - **Off screen:** an `IntersectionObserver` (threshold 0.05) stops drawing while the canvas is scrolled away or hidden, and resumes when it's back. A `ResizeObserver` rebuilds the globe (150ms debounce) when the canvas width changes, ignoring 0 (hidden) and the same size.
  - **Size:** cobe sizes the buffer as `width × devicePixelRatio`, so it's created at `width:s` with `devicePixelRatio:2` (the old `s*2` drew 16× the on-screen pixels). At ≤520px `.globe-wrap` is `min(300px,100%)` square, so it fits a 320px screen.
- **CTA buttons** — one filled primary action, "Add New Trip" (`.dash-cta-btn.dash-cta-primary`), plus a secondary bulk-export button (icon-only on phones). With no trips the CTA row is hidden and the empty state (`.dash-empty`, "Plan your first trip") carries the action.
- **Trip cards** — emoji + name, city, a countdown pill + date range, place/member counts. Split into two sections: planned (upcoming or ongoing, ascending by start) and **Past Trips** (descending), each judged by the trip's own timezone's today (`_tripNow(trip)`). The pill comes from `_tripWhen(trip)` (`{kind:'soon', n}` → `STRINGS.whenIn`, "In 12 days"; `{kind:'now', k, tot}` → `STRINGS.dayNofM`, "Day 3 of 7"); the nearest trip's pill is filled. Actions: edit for the owner or a `'write'` member (the fields the rules let them change), delete for the owner, leave for everyone else.

### Mobile-Specific UI

**Shell (≤768px):**
- `viewport-fit=cover` plus `env(safe-area-inset-*)` padding on the header, toast and sheets; `html { touch-action:manipulation }` (drops double-tap zoom, keeps pinch-zoom) and no UA tap flash, so tappables get their own press state; hover effects only under `(hover:hover) and (pointer:fine)` so they don't stick after a tap.
- In a trip, `overscroll-behavior-y:contain` (no pull-to-refresh, which would drop a pending debounced save).
- `<meta name="theme-color">` and `html.style.colorScheme` follow the theme (set in `applyTheme`). `applyTheme` overwrites `html.className`, so never keep state in html classes.
- Phones scroll the page, not the view: `switchView` remembers each tab's `window.scrollY` in `_tabScroll` and restores it on return (a first Calendar visit still scrolls to its first event).
- Dialogs are bottom sheets with 44px hit areas around the 32px close buttons; the schedule picker (`#schedModal`) is a sheet too, its days one scrolling row with the picked day kept in view, the hour grid taking the leftover height so Save stays on screen.

**Header (≤768px):**
- View tabs right-aligned next to hamburger menu
- Tab labels hidden, icons only
- Viz menu toggle 40px (the mobile-polish rule overrides the older 34px one)

**Calendar (≤768px):**
- `calPage` (0-indexed) tracks visible day; `setCalPage(idx)` switches days; only the `.active-day` column is shown. Swiping the grid (`_initCalSwipe`) also changes the day.
- **Date strip** (`renderCalDayNav()` → `#calDayNav`, sticky at `top:56px`, replaces `.cal-header-row`): a `.cal-strip` of one 44×52px `.cal-strip-day` button per trip day, showing the weekday (`STRINGS.dpDow`), the date number, and the day's weather icon (else a day-color dot). The chosen day is filled with `--accent`. Today, in the trip's timezone (`_tripNow`), is red (`--now`) with `aria-current="date"`, and keeps a red inset ring when it's also the chosen day. The strip is an edge-faded horizontal scroller with 16px gutters. Pills are `flex:1 0 44px`: when every pill fits the screen at 44px they share the whole row, so a short trip fills the width (2 days = two halves), and when they don't fit they stay 44px and the row scrolls sideways (7 days fill a 390px phone, 8 scroll). Tap → `calStripPick(i)`. Keyboard: the strip is one tab stop (roving tabindex, `role="group"` labelled `daysA11y`, pills `aria-pressed`), and `calStripKey(e)` moves the day with arrows / Home / End, focus following. Focus rings are inset because the scroller clips outside ones. The prev/next arrows and dot row are gone (`prevDayA11y` / `nextDayA11y` removed).
- **Strip scrolling:** the scroller element (`data-trip`) survives re-renders of one trip; only its pills are redrawn, so the user's scroll position (and a centring still animating) survives a weather update or a collaborator's edit. `_calStripKey` (`tripId|calPage`) centres the chosen day (`_centerCalStrip` → `_centerInRow`) only when the day changes. `null` means "centre instantly when it next shows"; it's reset on trip open, on leaving the Calendar tab (a hidden scroller loses its position) and in `_onCalResize`. A pill that had focus gets it back after the redraw.
- **Meta line** (`#calDayMeta`, under the strip, not sticky, scrolls away with the page): the day-color dot, "Day k" (`dayN`, deliberately without the total, since the header status line already says "Day 3 of 7") + the date, `weatherChip(day)`, a 40px map button (`goToMapDay`), then `renderDayChips(day)` (lodging).
- A one-day trip gets no strip, just the meta line with the date. The undated hometown trip has no days, so neither shows. Above 768px `renderCalDayNav()` empties both, since desktop pages through day columns instead.
- `renderCalSkeleton()` draws placeholder pills shaped like the strip and sized by the same `flex:1 0 44px` rule (count from the trip's date range, at most 14, none for a one-day or hometown trip) plus a meta-line placeholder. `renderCalNowLine()` redraws the strip when the trip's date passes midnight (`data-today`). `.cal-nav-btn` is 40px on phones.
- Desktop: `calPage` tracks page of days (group); pagination nav bar (`.cal-page-nav`) with arrows, dots, and date range label. `calDaysPerPage()` subtracts the open left panel (292px) from the width available for `CAL_COL_MIN` columns.
- **Now line** (all widths): `renderCalNowLine()` draws a red line (`--now`) with its time in the gutter on today's column and dims finished events (`.is-past`, from each event's `data-end`), all in the **trip's** timezone via `_tripNow(meta)` so collaborators at home see the traveller's day (`'UTC'` counts as unknown → device time). It ticks on the minute boundary and catches up on `visibilitychange`.

**Map (≤768px):**
- Fullscreen map; `.map-mob-tabs` (day pill buttons) + `.map-mob-sheet` (bottom sheet)
- `mapMobDay` (0-indexed); `setMapMobDay(idx)` switches days + calls `fitMapToDay()`
- **One current day:** the map opens on the day the calendar shows (`_calAnchor`), and `setMapMobDay` moves the calendar anchor too. `_lastFitDay` remembers the day last framed, so coming back to the tab on it keeps the user's pan/zoom.
- The pill row is full width with edge fades; it centres the active day only when the day changes (`_mapTabsCentered`), not on every re-render. Today's pill gets `.is-today` / `aria-current="date"`.
- **Controls follow the width:** `_syncMapControls()` (from `initMap` and `_resizeMap`, which runs on every window resize) gives phones no +/- (pinch instead) and the attribution top-right under the day pills, and desktop +/- top-left with the attribution bottom-right. It acts only when the width crosses 768px (`_mapCtlMob`), e.g. a resized window or a rotated tablet. The attribution is moved by its element rather than re-added, because re-adding a control recounts the credits of layers already on the map and a later tile swap would leave the old credit behind.
- **Framing inside the visible band:** the day pills cover the top of the map and the sheet its bottom. `_mapInsets()` returns the band between them (`{top, bottom, side, mob}`), measuring the sheet at its resting state (collapsed or not) rather than its live transform, so a frame taken mid-animation lands where the sheet ends up. It keeps at least a 120px band on a short landscape phone. Desktop gets a plain 16px all round. `_bandFit(maxZoom)` builds `fitBounds` options from it; on phones the top pad adds 48px because a marker's latlng is its tip and the badge stands above it. `_setViewInBand(ll, z, anim, bias)` puts a point at `bias` of the band (0 top, 1 bottom, default middle).
- `fitMapToDay(idx)`: one pin → `_setViewInBand` at zoom 15; several → `fitBounds(…, _bandFit(16))`; none → the trip's city (`cityLat`/`cityLng`) at zoom 13 instead of whatever the previous day left on screen. `_fitMapToMarkers()` band-fits on phones too. All map animation is off under `_rm()`.
- **Focusing a pin** (`focusWishMarker`, `focusMarker`) goes through `_focusAndOpen(key, ll, move)`. It closes any popup and moves the map (phones: `_setViewInBand` at bias 0.72, zoom ≥16, leaving room above the pin for the popup; desktop: `flyTo` / `setView` at 16). Once `moveend` fires (700ms fallback) it opens the popup, looking the marker up again by `_markerKey` because a collaborator's edit may have rebuilt it; a newer focus supersedes one still moving (`_focusGen`).
- **Popups auto-pan inside the band:** `_padPopup(m)` sets the popup's `autoPanPaddingTopLeft` / `BottomRight` from `_mapInsets()`. Markers register `_padPopupOnClick` on `click keypress` **before** `bindPopup`, so it runs ahead of the popup's own handler.
- **Empty day:** a day with nothing to pin shows `.map-mob-empty` in the sheet (pin icon + `mapDayEmpty`), plus an Add place button (`openCalAdd(dayId, null)`) for editors, instead of an empty card row. The sheet's add button is `icon('plus')`; its calendar button has an `aria-label`.
- Bottom sheet is draggable via Pointer Events: 1:1 vertical tracking, rubber-band past bounds, velocity-projected snap to expanded/collapsed (collapsed = title row visible, cards hidden), tap toggles. `_initMapSheetDrag()` (attached once to `#mapMobSheet`), `_applyMapSheetState(animate)`, `_mapSheetCollapsed` flag — state reapplied after every `renderMapMobSheet()` since content height varies. `.map-mob-cards` has `touch-action:pan-x` so horizontal card scroll still works.

### State

Global JS: `currentView`, `currentTripId`, `currentTripMeta`, `editingDayId`, `editingEvId`, `addingDayId`, `mapFilter`, `leafletMap`, `mapMarkers`, `mapRoutes`, `_routeBuildId`, `calPage`, `_calAnchor`, `mapMobDay`, `DATA_REF`, `_isPublicView`. Sync/load state: `_serverBase`, `_loadAncestor`, `_tripDataConfirmed`, `_tripLoading`, `_tripMetaFresh`, `_openTripGen` (see **Multiplayer sync** / **Data Safety**).

### Rendering

All views render via innerHTML string concatenation. `rerender(noSave)` refreshes current view + triggers `scheduleSave()` (not with `noSave`), then updates tab badges and an open calendar-add list (`_refreshCalAddList()`).

**Escaping (mandatory for every innerHTML sink).** Trip data, `users/*` profiles (`displayName`, `photoURL`) and Places API results are written by other people, and a member's script running in the owner's session could take the trip over. So every such value goes through the helpers next to `escH` in UTILS:
- `escH(s)` for text (`& < >`), `escA(s)` for attribute values (also `"` and `'`). Never put a raw data string in HTML.
- URLs: `safeUrl(u)` passes only `http(s)://` (a stored `javascript:` / `data:` URL renders as nothing); `urlA(u)` = `escA(safeUrl(u))` for `href` / `src`; `extUrl(u)` / `hrefA(u)` also accept typed links without a scheme (`example.com/x` → `https://…`); `_openSafe(u)` for opening one from a handler; `telA(p)` builds a digits-only `tel:` link.
- Ids inside inline handlers (`onclick="fn('ID')"`): `_sid(id)`, which emits only ids matching `[\w.:-]+` (anything else becomes `''`, so the handler finds nothing). Values that can't pass that (emails, trip ids from the URL, links) go in a `data-*` attribute read by the handler instead: `data-k="'+escA(v)+'" onclick="fn(this.dataset.k)"`, `data-href` + `_openSafe(this.dataset.href)`. The dialog focus-return logic keys on `data-k`, so keep using that name for per-item handlers.
- Colors from data into `style`: `_col(c, fallback)`; numbers: `_num(n)`; ids in selectors: `CSS.escape`.

**Remote updates must not disturb the user** (`_applyRemoteData` → `rerender(true)` runs on every collaborator change):
- Every swap of `DAYS` goes between `_viewDayKeys()` and `_restoreViewDays(k)`, which note the calendar/map days on screen by `isoDate` and point back at them (days added before, a collaborator's day id winning the merge).
- The Places add panel (search input, its suggestions, Discover) lives in `#wlPanelHost`, outside the `#wlBody` that each render rebuilds; `_setWlPanel` only rewrites it when its HTML changes. `renderViewSearchBar()` keeps an existing input as is. The field's clear button is shown by CSS alone (`:placeholder-shown`), so typed text, focus and the button never depend on a panel re-render. The Places filter rows keep their horizontal scroll, and so does the phone calendar date strip (only its pills are redrawn; it re-centres only when the day changes).
- `rebuildMarkers(true)` reopens the popup that was open on its new marker (`_markerKey`); a day/filter change still closes it.
- An open trip switcher is redrawn, not closed (`keepDropdown`), and the schedule modal's typed notes survive re-renders (`schedNotesDraft`).
- `updateTabBadges()` marks the tab being looked at as seen, so a change arriving there never badges it.
- Place cards compute their day label from the event's current day, not the stored `w.dayLabel` (another language, stale after moves).

### Key Functions

- `loadDashboard()` / `renderDashboard(trips)` — dashboard with hometown card, globe, CTAs, trip cards
- `loadTripData(tripId, gen)` — load trip into `DAYS`/`WISHLIST`: cache-first from the v2 trip cache, then the server (see **Trip cache**)
- `openTrip(tripId)` / `_exitTrip()` / `_detachTrip()` — enter / leave a trip (see **Data Safety**)
- `renderCal()` / `renderCalBody()` / `renderCalHeader()` / `renderCalDayNav()` — calendar (`renderCalDayNav` = the phone date strip + meta line; `calStripPick(i)` / `calStripKey(e)` / `_centerCalStrip()`)
- `setCalPage(idx)` — calendar day/page switch (mobile: single day, desktop: group of days). `_calAnchor` holds the exact chosen day; `calPage` is derived per layout, so resize never resets to day 1. Persisted per trip in `localStorage['palo-calday-<tripId>']`, default = today if within the trip
- `calDaysPerPage()` / `calTotalPages()` / `calPageDays()` / `renderCalPageNav()` — desktop calendar pagination
- `renderWishlist()` — wishlist grid
- `initMap()` / `rebuildMarkers()` / `fitMapToDay(idx)` — Leaflet map. Tiles are Esri gray canvas (keyless; CARTO now requires an API key and serves watermark tiles), `maxNativeZoom:16`, auto-fallback to OSM after repeated tile errors. `initMap` refuses to build while the Map tab is hidden; `_resizeMap()` runs on window resize and left-panel toggle, syncs the controls (`_syncMapControls()`) and sizes `#leaflet-map` with `_mapViewHeight()`, i.e. `#view-map`'s own height (the inset canvas card on desktop, which ends above the window's bottom; the window minus the header only while the view is hidden). On desktop the attribution sits inset 10px from the card's rounded corner on a translucent `--surface` background. Phone framing helpers: see **Map (≤768px)**
- `clearRoutes()` / `buildRoutes()` — OSRM walking routes per day (public demo server: sequential, 8s timeout, cached per coordinate string in `_routeCache`); falls back to dashed lines on any error incl. non-OK responses
- `renderMapMobTabs()` / `renderMapMobSheet()` / `setMapMobDay(idx)` — mobile map overlay
- `setMapFilter(id, btn)` — desktop sidebar day filter
- `goToMapDay(dayId)` / `goToCalDay(dayId)` — cross-view navigation
- `openEdit(dayId, evId)` / `saveEditEvent()` / `deleteCurrentEvent()` — edit event modal (`openAdd(dayId, timeStr)` opens the same modal in add mode; `saveEditEvent()` saves both)
- `openCalAdd(dayId, timeStr)` / `saveCalAdd()` — calendar add modal (time block, or schedule an existing place)
- `openWishAdd()` / `saveWishItem()` / `deleteWishItem()` — wishlist modal
- `openSchedModal(wishId)` / `saveSchedule()` / `removeFromCalendar()` — schedule picker for a place; `_schedulePlace()` does the actual placing
- `_addBlocked()` — every add entry point calls it first: returns true (with the "slow connection" status toast) while the trip is loading or has no `DATA_REF`, since `loadTripData` would replace the arrays and the addition would vanish
- `quickAddPlace(containerId)` / `_addQuickPlace()` — quick-add from URL without modal
- `searchPlaces(query, dropdownId)` / `selectPlace(idx, dropdownId)` — Google Places autocomplete search + selection → opens modal with pre-filled fields
- `_addPlaceFromSearch(d)` / `_populateWishModalFromSearch(d)` — create wishlist item or populate modal from Places API response
- `renderViewSearchBar(containerId, dropdownId)` — renders the search field in the map sidebar. `_searchFieldH(inputId, dropdownId, pasteJs)` builds the field markup for both it and the Places tab; `clearQuickSearch(btn)` is the clear button
- `onQuickSearchInput(el)` / `onWishSearchInput(el)` — debounced autocomplete triggers (300ms)
- `detectCategory(name)` — returns category string from place name (used by quick-add and modal)
- `openTripCreate()` / `openTripEdit(tripId)` / `saveTripCreate(e)` — trip create/edit modal
- `archiveTrip(tripId, confirmed)` — delete trip (owner; leaves it first when it's the open one). `leaveTrip(tripId)` — a non-owner member leaves
- `goToDashboard()` — `_exitTrip()` then routes to dashboard (also wired to flag-button click on phones)
- `showSaveToast(msg, icon, opts)` — the one toast API (see **Toasts**)
- `fetchWeather()` — Open-Meteo weather → `weatherData`. Uses forecast API for near-future dates, archive API for past dates, last-year-same-dates fallback for dates beyond forecast range (~16 days). Geocodes city name as fallback if `cityLat`/`cityLng` missing. Weather chips shown inline in calendar headers, the phone date strip and meta line, the map sidebar and the phone map sheet, drawn with `wxIcon()` (see **Weather icons**).
- `parseGmapsUrl(url)` / `parseEditMapsUrl(url)` — Google Maps URL parsing (calls CF Worker). Triggered via `oninput`, `onpaste`, and `onchange` for mobile compatibility. `extractMapsUrl(s)` extracts the actual URL from pasted text that may include place name + URL (common on mobile share).
- `geocodeWishItem(w)` — Nominatim geocode for wishlist items without coordinates
- `icon(name, size)` — Heroicons v2 outline SVG string from `ICONS` object
- `catIcon(cat, size)` — category-specific icon (maps 'other' and unknown categories → 'pin')
- `_tripNow(meta)` → `{iso, mins}` (today and minutes since midnight in the trip's timezone) / `_tripWhen(trip)` → countdown (`soon` / `now` / null) / `_rm()` (prefers-reduced-motion) — shared "now" and motion helpers
- `toggleTripDropdown(event)` / `closeTripDropdown()` — trip switcher dropdown
- `initCobe(trips)` / `destroyCobe(keepReady)` / `projectGlobe()` — cobe globe with flag overlays (see **Dashboard**)
- `showLoginScreen(notice)` / `doSignIn()` — sign-in card and its busy/error handling (see **Authentication & Sharing**)

### Trip Create/Edit Modal (`#tripCreateModal`)

Field order: City → Trip name → Date range. Emoji auto-derived from country flag. Submit disabled until name + dates filled. On phones the actions stay stuck to the bottom of the sheet.

- `autoDetectTimezone(city)` — geocodes via Nominatim, resolves IANA timezone silently
- `tcCityData` — holds `{ name, countryCode, lat, lng }` from city search
- `_tcSetSaving(on)` / `_tcSaving` — one save at a time (a second tap or Enter does nothing, so no duplicate trips); Cancel / Escape / backdrop wait for it, and `beforeunload` warns while it runs.
- **Edit writes only what changed:** `_tcFormMeta()` reads the form as stored; `_tcOrig` is what it held when it opened. `saveTripCreate` sends `update()` with just the differing keys (nothing at all when nothing changed), reconciles days only if `startDate`/`endDate` changed, and refetches weather only if the dates or city moved. For the open, confirmed trip the reconcile happens in memory and saves like any edit; otherwise (another trip, or the open one still loading) the server copy is reconciled in a transaction and `_lsRebaseTripCache()` updates its cache. Only when no trip is open does it reload the dashboard; inside a trip it just redraws the header. A `permission-denied` shows `ownerOnlyTripEdit`. Errors render inline in the sheet (see **Toasts**).

### Map Markers & Routes

Rounded-square emoji badges (day color bg, white border), category SVG icon centered, number badge top-right, triangle pointer. OSRM walking routes in day color (`opacity:0.55`); dashed fallback on error. **Place photos:** the desktop sidebar rows (32px) and mobile sheet cards (44px) use `_mapThumb()` to show the saved place's `photoUrl`, falling back to the category icon (also when the image fails to load); marker popups get a full-width photo banner via `_popupPhoto()`. Events find their saved place with `_placeForEvent(ev)`, i.e. `calEventId`, then name + coordinates, because multi-day hotels/transport only keep their latest `calEventId`. Thumbnails reuse the stored photo URL (400px) so they hit the browser cache instead of making new billed Photos requests. **Map popups** (`.fp-popup`, built from escaped fields) end in an action row: a **Directions** link (Google Maps walking directions to the marker, with `destination_place_id` when known) and, for assigned places, a primary **Edit** button that calls `openEdit(dayId, evId)` (gated by `canEdit()`). Popups auto-pan inside the part of the map the phone chrome leaves visible, and focusing a pin opens its popup only after the map settles (`_padPopup`, `_focusAndOpen`; see **Map (≤768px)**).

### Calendar Event Colors

Calendar grid events use **two kinds only** — category colors are not applied here. The class comes from the id prefix (`wl_ev_` → `.cal-ev-place`, otherwise `.cal-ev-block`) and the colors are theme tokens defined on `html.theme-dark` / `html.theme-light`:
- **Time-assigned places** — `--ev-place-bg` (indigo tint), `--ev-place-border` (a stronger tint of the same hue), text `--ev-place-fg` (dark `#c7d2fe` / light `#4338ca`).
- **Time blocks** — `--ev-block-bg` (slate tint), `--ev-block-border`, title in `var(--text)`, time a 72% mix of `var(--text)`.

An event is one tinted box: the fill (`--ev-bg`) is layered over the column's own background (`--ev-under`, so hour lines don't show through the text) inside a full 1px border (`--ev-border`) with a soft shadow. There is **no single-edge accent** (no left bar / inset shadow) anywhere in the calendar, including the schedule picker's mini calendar (`.sched-ev-block`, day-color tint + border). Hover and pressed states move the border toward the text color (`color-mix`), lift with a shadow and scale slightly; the keyboard focus ring is a solid 2px `--accent` outline over the border. Day columns and headers are separated by neutral 1px `--border` lines (not day-colored). Editors get `<button>` events (open the edit dialog); read-only viewers get `<div>`s that lay out the same and aren't tab stops. Finished events today get `.is-past` (see the now line under Mobile-Specific UI).

**Side-by-side events** (`.narrow`, when overlapping events share a column, `layout[ev.id].total > 1`) are laid out for thin boxes. They show the start time on its own line, with AM/PM in `.cal-ev-ap` (`_calTimeH`), which a container query drops below 46px. The title wraps to `--ev-lines` whole lines (1–4, so nothing is cut mid-line). There's no end time, subtitle, notes or `optional` badge; the dashed border already marks an optional event (a dashed border replaces the solid one on all four sides). `renderCalBody` computes `--ev-lines` from the box height with rem-based line heights that **mirror the `.narrow` CSS** (time 0.62rem / title 0.74rem at line-height 1.2; 0.66 / 0.78rem on phones), so change them together (the box's 1px border plus its padding is 5px per side, 3px when `.compact`, the same vertical space as before, so the `inner` allowance in `renderCalBody` did not change). A box too short for time plus one title line (a large default font) becomes `.narrow-row`: time and title share one row, the title ellipsized, and under 7rem wide the time is hidden to keep the title readable.

**Link badge:** a time block's `link` renders as `.cal-badge.cal-ev-link`, labelled in roomy events. In narrow or compact events it shrinks to an icon (`.icon-only`, the event gets `.has-link`, with a larger hit area on coarse pointers), so read-only viewers, whose events aren't buttons, can still open it. Compact events hide every other badge but keep this one.

The `CAT` color map is still used elsewhere (map markers, wishlist filters, edit modal place header).

### Edit Event Modal — Simplified Layout

Two modes driven by event id prefix:

**Time block** (default, `ev_*` events): minimal form — Date, Start/End, Title, Notes. A row of pill buttons at the bottom (`+ Map link`, `+ Description`, `+ Link`, `+ Category`, `+ Optional`) reveals each optional field on demand; each revealed field has an `×` dismiss button in its label that re-hides and clears the value. The Time/Place toggle that used to sit at the top is removed entirely — new non-wishlist events always save as time blocks. `toggleEditField(field, show)` + `_resetEditFields()` drive the reveal/hide. On `openEdit()`, any populated optional field auto-reveals so legacy events look natural.

**Wishlist-linked** (`wl_ev_*` events, detected via `WISHLIST.find(w => w.calEventId === evId)`): `#editForm` gets the `mode-wishlist` class which hides title/sub/category/map fields and the pill row; only time + notes remain editable. The `#editPlaceHeader` is populated with:
- Top-aligned category icon (`align-items:flex-start` on `.edit-place-header`)
- Place name + subtitle
- **Action row**: primary "View on map" / "지도 보기" button (`viewOnMap`; closes modal, calls `goToMapDay(dayId)`) and secondary "Google Maps ↗" link (opens `ev.mapsUrl` / `wl.mapsUrl` / `lat,lng` query in new tab)
- The shared `#editDeleteBtn` is relabeled **"Remove from schedule" / "시간 해제"** (`removeFromSchedule`) in this mode — `deleteCurrentEvent()` already preserves the wishlist item and only clears `calDayId`/`calEventId`/`visited`/`dayLabel` (and only when the event was really removed). Reset to `delete_` for non-place events.

**Saving writes only what changed.** `openEdit` stores `_editOrig = _readEditForm()`, the form as its inputs show it; `saveEditEvent` assigns only fields whose value differs, so a field left alone keeps whatever a collaborator changed while the modal was open (and a no-change save writes nothing). It finds the event with `_findEvOn(editingDayId, editingEvId)`, wherever it is now; if a collaborator deleted it, the modal closes with the `eventGone` toast. A date whose day no longer exists keeps the other changes and shows `dayGone`. The optional-field labels carry `for=` so clicking a label never hits its `×` button. The same changed-fields rule applies to the place modal (`_wishOrig` / `_readWishForm()` in `saveWishItem`), the schedule picker (`_schedOrig`, plus `schedNotesDraft` so typed notes survive picking another day) and the trip modal (`_tcOrig`).

To add a new place, users flow through the Places tab (wishlist → Add to Schedule). Calendar-click empty slots open `#calAddModal`, which creates a time block or schedules an **existing** place (never creates one) — one true path per CLAUDE.md's event-type-as-id-prefix invariant.

### Theme

`--accent` is monochrome: `#e8e8e8` (dark mode) / `#171717` (light mode). `--accent-fg` for text on accent backgrounds: `#0a0a0a` / `#ffffff`. Day/marker colors remain per-trip colored. `cycleTheme()` toggles; persisted in localStorage. See **Trip Canvas Chrome** for the additional `--page-bg` / `--canvas-bg` / `--tab-active-bg` / `--tab-active-fg` vars introduced for the inset shell, **Calendar Event Colors** for `--ev-place-*` / `--ev-block-*` (`-bg`, `-border`, `-fg`), and **Search field** for `--field-bg` / `--field-bg-focus` / `--field-border` / `--field-ph`; `--now` is the now-line red. Every color token is defined in both theme blocks; motion uses the `--dur-*` / `--ease-*` tokens and honors `prefers-reduced-motion` (`_rm()` in JS).

### Calendar Add Modal (`#calAddModal`)

Start time uses native `<input type="time">`. Duration slider (`CAL_ADD_DURS=[30,60,90,...,240]`) — index 0 is 30min, default is 30min. Ghost hover preview and click both snap to 30-minute intervals.

- `tpSetFromMin(min)` / `tpGetMin()` — set/get time from the native time input
- `updateCalAddEndTime()` — computes end time from start + duration slider
- Place mode offers `_calAddOffered(w)` places (not on the calendar yet, plus hotels / transport) and saves through `_schedulePlace`, so a place a collaborator scheduled meanwhile moves here instead of getting a twin. `rerender()` refreshes the open list (`_refreshCalAddList()`), keeping the selection, the typed note and focus.

### Multiplayer sync

Several people edit the same `data/main` doc, so writes are 3-way merges, not overwrites (`// MULTIPLAYER SYNC` block in `index.html`):
- `_serverBase` is the server state local was last rebased onto; anything `DAYS`/`WISHLIST` differ from it by is an unsaved local edit.
- `_commitTripData()` runs a Firestore transaction (`_commitOnce`): read the doc, `_mergeTripData(base, local, remote)`, write the result with `_nextRev(d)`. Commits from one browser are serialized (`_commitChain`); overlapping commits from the same browser would treat each other's writes as remote conflicts and could put stale values back. A commit that still sees the live trip re-captures `DAYS`/`WISHLIST` when it starts, so it carries every edit made while it waited.
- **Coalescing:** a save asked for while another commit for the same doc is still waiting its turn joins that one (`_pendingCommits` / `_pendingCommitFor(ref)`) instead of queueing its own, so an offline session doesn't pile up one transaction per debounce and retry. `doSave` returns early when it joined (`_saveRun`): the joined save reports and retries.
- **Our own commit landing:** `_applyCommitResult(tripId, sent, merged)` rebases whatever local changed *since `sent`* (the exact state the commit merged in) onto `merged`, and `merged` becomes `_serverBase`. Rebasing onto the pre-commit base instead would read an edit that undoes part of the commit (unlike, delete a place just added) as "unchanged" and lose it. A commit that lands after we left the trip rebases any save queued behind it and the trip's cache (`_lsRebaseTripCache`).
- **Held snapshots:** while `_commitsInFlight > 0`, `_onTripDataSnapshot` only keeps the newest snapshot in `_heldSnap`; `_commitSettled()` applies it through `_applyRemoteData` once the last commit settles (by then our own echo is recognised as stale). `_detachTrip` clears it.
- `_applyRemoteData()` rebases local onto any newer server state (`_mergeTripData(_serverBase, local, remote)`), with `_viewDayKeys` / `_restoreViewDays` around the swap and `rerender(true)` only if something changed.
- **`rev` + `revEpoch`:** `_nextRev(d)` continues `d.rev` and keeps `d.revEpoch`, or starts a new random epoch when the doc has no numeric `rev` or no epoch (a write from an older app build or a one-off script resets the count). `_isStaleRev(rev, epoch)` drops a snapshot or commit result only when its epoch equals the base's and its `rev` is ≤ the base's; anything from another epoch is accepted. `_revNewer(a, b)` compares cached bases the same way. **Every writer of a data doc uses `_nextRev`**: commits, `createTrip`, the legacy seed and migration, the dashboard days-fix and the other-trip date edit.
- Merge rules: days match by `isoDate` (the server's day `id` wins, and wishlist `calDayId` is remapped); events match by `id` **trip-wide**, with the day as a field, so a move between days isn't a delete plus an add; places match by `id`. The side that changed an item since base wins; when both changed it, fields merge recursively (`votes` included) and local wins a true same-field conflict. A delete sticks unless the other side edited the item, in which case the edit is kept. Repeated ids are never collapsed (`_keyed` suffixes `#2`, `#3`).
- **Merge normalization** (one pass at the end of `_mergeTripData`, in this order):
  1. Day labels: `_dayShell` leaves a dated day's `date` / `dayName` out of the merge (each viewer regenerates them in their own UI language, so a relabel alone would read as an edit and resurrect a day the other side removed); afterwards they're copied from the server's day (local's for a day only we have). `_sameContent` is `_sameData` ignoring those labels.
  2. Events onto days; an event whose day is gone (dates changed meanwhile) goes on the last day with the same `[<originalDate> <iso>]` notes tag as `reconcileDays`, instead of being lost.
  3. Links: `_normalizeLinks` sets each place's `calDayId` (and `dayLabel` when the day changes) from where its event actually is, clears the link (`calDayId`, `calEventId`, `visited`, `dayLabel`) when the event is gone, forces `visited` on linked places, and relinks a `wl_ev_` event that one side unlinked while the other edited it. `_linksFixed` first repairs each input side against its own calendar, without mutating it, so a legacy repair isn't mistaken for an edit.
  - Auto-filled / derived fields (`_AUTO_PLACE_KEYS`: `lat`, `lng`, `dayLabel`; `_AUTO_EVENT_KEYS`: `lat`, `lng`) don't count as edits when deciding delete-vs-edit (`_samePlace`, `_sameEvent`), so a background geocode never resurrects a place a collaborator deleted.
- Background lookups (`geocodeWishItem`, `_resolveWishCoords`, `backfillEventCoords`) capture the id and trip before the `await` and write to the item found again by id afterwards (`_liveWish`, `_findEv`), never to a stale object reference; a lookup that answers after leaving the trip writes nowhere.
- **Saving and retries** (`doSave`): contention codes (`aborted`, `failed-precondition`, `already-exists`) retry after 0.3–1s with no toast until the third failure; anything else backs off 5s → 60s and is announced once per error code (`_lastSaveErrCode`), so a dismissed error stays dismissed while it persists. `permission-denied` and `invalid-argument` are never retried. `beforeunload` warns while `saveTimer`, `_saveDeferred`, `_commitsInFlight` or `_tcSaving` is set.
- **Page lifecycle:** `pagehide` and `visibilitychange` → hidden flush a pending debounced save (`_flushPendingSave`; iOS discards background tabs without `beforeunload`, and `doSave` writes the local cache first); `online` retries a save sitting out its backoff at once (`_retrySaveNow`).
- **Size guard:** the trip is one ≤1 MiB doc. `_approxDocBytes` measures what `doSave` sends; past `DOC_WARN_BYTES` (900 KiB) a successful save shows the sticky `tripNearlyFull` warning instead of "Saved" (again at most every 5 minutes). An `invalid-argument` failure at that size shows `tripTooBig` and stops retrying (trimming, not retrying, fixes it).
- `_listenTripMeta()` keeps `currentTripMeta` live (rename, dates, role changes), with `includeMetadataChanges` so our own pending write is only judged once the server has it. When the dates or city moved, the trip's data is confirmed and we can edit, it runs `reconcileDays` (two concurrent date changes merge into days matching neither range; concurrent reconciles converge because days merge by date). It also detects lost access (see **Authentication & Sharing**) and keeps the cached trip list current (`_cacheTripMeta`).
- Read-modify-writes of *other* trips' data (dashboard days-fix, editing another trip's dates) use transactions too, followed by `_lsRebaseTripCache`.

**Trip cache (localStorage v2, the sync ancestor).** `travel-data-<tripId>` holds `{v:2, uid, copy, days, wishlist, base}`: `base` is the server state the cached edits are relative to (omitted when the cache is in sync; then `rev` / `revEpoch` sit inline). On reopen, `loadTripData` renders the cache and sets `_loadAncestor` to that base; `_applyFirstServerSnapshot` then takes the server as is when nothing was edited, otherwise merges `(ancestor, local, server)` and saves the result. So offline edits, edits deferred before the server answered, and edits made just before a reload, leaving or signing out all land instead of being overwritten. With no cache the ancestor is empty (plus the days `openTrip` generates), so the generated placeholder theme/color never beat the server's. A pre-v2 cache is its own ancestor (server wins); another account's unsaved edits (`uid`) are never replayed.
- Several tabs share one key, so while a tab has unsaved edits it also keeps them under a per-tab copy key `travel-data-<tripId>~<tabId>~<uid>` and holds a Web Lock of that name while the trip is open (`_holdCopyLock` / `_dropCopyLock`). On open, `_lsTripCache(tripId, live)` folds this account's copies from tabs that are gone (closed, reloaded, discarded, left the trip) into one, skipping copies whose tab still holds its lock.
- **Only `lsSaveTripData(tripId)` (open trip) and `_lsRebaseTripCache(tripId, server, queued)` (any other trip) may write these keys.** If storage is full, both clear the record rather than leave edits paired with a base they've already been saved against.

- **Tests:** `npm run test:sync` (`tests/sync.test.js`) extracts this block, plus the real cache, load, save, leave, sign-out, schedule and coordinate-lookup functions, from `index.html` and runs them in isolated `vm` contexts (one per simulated collaborator or tab) against an in-memory Firestore with optimistic transactions (SDK-like backoff, contention reported as `failed-precondition`), per-client snapshot latency, optional snapshot coalescing, network toggling, and a per-browser localStorage and Web Locks table that survive "reloads". Scenarios cover merge rules and concurrency (simultaneous adds, same-item edits, delete vs edit, votes, in-flight edits and undos, held echoes, rev-less writes, coalesced commits, 3- and 5-person chaos), the v2 cache (offline edit + reload, deferred edits, two tabs offline, account switch, storage full), save paths (offline delete, last-place delete, sign-out flush, back-online retry, size limit) and place/event linking (concurrent scheduling, moves vs edits). Timing-based, so run it a few times after touching sync/save/load code; it must end with `ALL MULTIPLAYER TESTS PASSED`. `DEBUG_REGRESS=1` / `DEBUG_DUP=1` print traces.

### Data Safety

**CRITICAL:** Firestore has no version history — data loss is permanent. Multiple guards are in place:

- **`reconcileDays(meta)`** rebuilds DAYS to match trip date range. Events on days that fall outside the new window are NEVER dropped — they are stitched onto the last remaining day with a `[<originalDate> YYYY-MM-DD]` note prefix (`t('originalDate')`: "Originally" / "원래") so the user can relocate them.
- **`doSave(opts)`** refuses to write if both DAYS and WISHLIST are empty (last-line defense against load/navigation race conditions). The only exception is **`doSave({force:true})`**, used by `deleteWishItem` (deleting the last place of a trip without days is legitimate): it lifts *only* that empty-state guard, and stays on for that trip's retries and flushes (`_saveEmptyTrip`) until a commit carrying the delete lands. Destructive paths save through `doSave` (never `_commitTripData` directly), so a failure retries and keeps the unload warning like any edit.
- **Edit event modal** has a date picker (`#editDate`) constrained to the trip's `startDate`/`endDate` window — `_moveEventToDate(dayId, evId, newIsoDate)` moves events between days without loss, and updates linked wishlist `calDayId`/`dayLabel`.
- **`addShareUser`** writes `access` as a full object (`update({access: {...}})`) instead of dot-path (`update({'access.key': val})`) because emails contain `.` which Firestore interprets as nested field paths.
- Never add code paths that silently reduce event/wishlist counts. Any destructive action must show a confirmation dialog first.
- **`_tripDataConfirmed` gate:** trips open cache-first (localStorage renders instantly, calendar/Places show shimmer skeletons while `_tripLoading`). `doSave()` writes nothing until the server has answered for the current trip — it sets `_saveDeferred` and writes the local cache instead. The first server snapshot goes through `_applyFirstServerSnapshot()`, which merges whatever local differs from the load's ancestor into the server state (see **Trip cache**). `doSave()` also refuses when `DATA_REF` isn't the current trip's doc, or a dated trip has zero days. Adding is blocked until the trip has loaded (`_addBlocked()`, and `updateFab` hides the FAB while `_tripLoading || !DATA_REF`).
- **Leaving a trip:** every way out goes through `_exitTrip()` — `goToDashboard`, `showDashboard` (the browser's Back button included), `_leaveSignedOut`, `doSignOut`, `_tripAccessEnded`. It closes the trip's modals (`_closeTripModals`), calls `_detachTrip()` (flush a pending save, unsubscribe both listeners, null `DATA_REF`, reset the sync/retry state, clear status toasts, drop the copy lock), then forgets the trip (`currentTripId`, `currentTripMeta`, `DAYS`, `WISHLIST`, the map), so nothing afterwards (editing its dates from the dashboard, a modal left open, a late quick-add or Places details callback) can take it for the open trip. Both return the flush promise. `doSignOut` waits for it and `_commitChain` (capped at 10s, so an offline sign-out still completes) **before** `auth.signOut()`, because the rules refuse the flushed commit once signed out; an edit that didn't land stays in the v2 cache tagged with the account and comes back with its next sign-in. `openTrip` uses a generation token (`_openTripGen`) passed into `loadTripData`; check it after every `await`.
- **No unscoped one-off migrations in the client.** The old `access-undo-v2` block in `loadDashboard` ran for *any* account whose browser lacked its localStorage flag, and stripped collaborators (and pending invitees' `accessEmails`) from trips by name pattern; it has been deleted. A client-side data fix must be gated on the account and an explicit list of trip ids, must go through a transaction, and must never rebuild `accessEmails` without the pending emails. (The remaining `owner-migration-v1` only runs for `jihoon8846@gmail.com` and only touches trips with no `ownerId`.)
- **Never swap global `DAYS` across an `await`** to reuse `reconcileDays` for another trip — use `_reconcileOtherDays(meta, days)`.
- **`access` map writes must be whole-object** (`update({access: newMap})`), never `'access.' + key` dot-paths — email keys contain `.`. This caused duplicated guests (stale `pending_<email>` next to the resolved uid). Every read-modify-write of `access` / `accessEmails` runs in `db.runTransaction` so a concurrent invite, leave or resolve isn't undone.
- **Backups:** read-only full export via the Firestore REST API using the logged-in firebase-tools token; snapshots live in `~/Desktop/faropin-backups/` (outside the repo — contains user data).

### Authentication & Sharing

**Auth:** Firebase Auth with **Google sign-in** (popup on desktop; redirect on phones or when the popup is blocked). `auth.onAuthStateChanged` gates all routing — unauthenticated users see a login screen, unless the URL is a public trip (`#trip/<id>` where `trip.public === true`), in which case `_isPublicView = true` and the trip loads read-only without auth. `currentUser` holds the Firebase user object. Viz-menu (hamburger + share button) hidden on login screen.

**Sign-in card.** `showLoginScreen(notice)` fills `#loadingScreen` with a `.login-card`: an optional `.login-notice` (`role="alert"`, the message a signed-out public viewer gets from `_tripAccessEnded`), the `h1.login-wordmark`, the `signInTagline`, a full-width 48px `#loginBtn.login-btn` (Google mark + `.login-btn-label`), an always-present empty `#loginError` (`role="alert"`, so a message written into it is announced) and `.login-fine` (`signInPrompt`). The card uses divs, not `<p>`, because `.loading-screen p` restyles every paragraph. `.loading-screen` centres by auto margins on its first and last child and scrolls, so a card taller than the screen (landscape phone, large text) starts at the top instead of being cut off. `showLoginScreen` also resets the busy state and destroys the dashboard globe.
- **Busy state:** `doSignIn()` does nothing while `_signInBusy`, so a second tap can't open a second popup. `_setSignInBusy(on)` disables the button, swaps the Google mark for a spinner (`.is-busy::before`, which keeps spinning under reduced motion) and the label for `signInOpening`, sets `aria-busy`, and gives focus back to the button when it re-enables.
- **Popup (desktop):** a popup attempt only fails 8–10s after its popup closes, and never while the popup sits forgotten behind the window. So `_watchSignInReturn(attempt)` re-enables the button 1s after this window regains focus. The attempt stays pending, so a sign-in finished in that popup still lands. Each attempt carries a token (`_signInAttempt`); a newer attempt cancels the old popup and the old one's late result or error is dropped. `auth/popup-blocked` / `auth/cancelled-popup-request` fall back to the redirect, still busy.
- **Redirect (phones):** straight to `signInWithRedirect`. A `pageshow` with `persisted` (Back from Google's page restores the page from bfcache, spinner and all) clears the busy state.
- **Errors:** `_loginError(msg)` writes `signInFailed` plus the Firebase code into `#loginError`. Closing the popup (`auth/popup-closed-by-user`, `auth/user-cancelled`) shows nothing. With no card on screen it uses a sticky toast. There is no `alert()`.

**User profiles:** `users/{uid}` doc with `email` (always `normalizeEmail`, which the rules require to match the token email), `displayName`, `photoURL`, `lang` — written on sign-in via `writeUserProfile(user)`.

**Trip access control:** Trip metadata has `ownerId`, `access: { [uid | 'pending_'+email]: 'owner'|'write' }` and `accessEmails: [email]`. The roles mirror the rules:
- `getTripRole()` — `'owner'` when `currentTripMeta.ownerId === currentUser.uid` (the access map's `'owner'` value is only a label); `'write'` when the user's normalized email is in `accessEmails`; otherwise `'none'` (including a signed-in non-member on a public link).
- `canEdit()` — `!_isPublicView && getTripRole() !== 'none'`. Gates every edit control, `toggleVote`, `scheduleSave` and `doSave`. Only valid with a trip open: roles are never read off another trip's metadata (`openTrip` sets `currentTripMeta` from the cached list first).
- `isOwner()` — `getTripRole() === 'owner'`

**Access ending while inside a trip.** `_tripAccessEnded(tripId, msgKey)` runs when the trip doc disappears or gets `archived` (`tripDeleted`), or when the meta or data listener reports `permission-denied` (`tripAccessEnded`): it drops the pending save (the rules would refuse it), closes the trip's modals, deletes the trip's local copy and cached-list entry, goes to the dashboard and shows a sticky toast (a signed-out public viewer lands on the login screen with the notice). A member removed from a trip that is **public** stays in it read-only instead, with the sticky `tripReadOnlyNow` toast. Signing out elsewhere (Firebase syncs sign-out across tabs) is not lost access: `_leaveSignedOut()` keeps the local copy, including an edit still waiting on the debounce, and shows the login screen. `doSave` ignores a `permission-denied` for a trip that's already closed or read-only, so that notice stays on screen.

**Sharing UI:** the share modal (`#shareModal`, `openShareModal()`) opens for **members** only (its list shows everyone's email): owners see "Share settings" with the invite form and the public-link toggle; other members see "Members". Only the owner gets trash buttons; a non-owner's own row has **Leave trip** (`leaveTripFromShare()`). Membership flows, all whole-map writes inside transactions:
- `addShareUser(e)` (owner) — rejects your own email (`inviteSelf`); looks up the email in `users` (`.limit(1)`); adds the uid, or `pending_<email>` when there's no account, as `'write'` plus the email in `accessEmails`. Someone already on the trip keeps their role (`alreadyMember`; a missing email is restored). Fires the invite email.
- `removeShareUser(key)` (owner, confirmed) — removes the key, any `pending_` duplicate of the same person, and their email from `accessEmails` unless another entry still uses it. The owner can't be removed.
- `resolvePendingInvites(user)` (on sign-in) — for each trip listing the email, swaps `pending_<email>` for the uid as `'write'` (or keeps the role the uid already has): exactly what the invitee branch of the rules allows.
- `_tidyAccessMap(tripId, meta)` (owner, each time the share list renders) — repairs dot-path-split keys (`_normAccess`: `{"pending_user@gmail":{"com":"write"}}` → one key), labels the owner as owner, swaps a pending key for the uid once that email has an account, and drops a pending key whose email is no longer in `accessEmails` (the leftover of someone who left must not re-grant access).
- `leaveTrip(tripId)` (non-owner, confirmed; `ownerCantLeave` for the owner) — leaves the open trip first, then removes its own uid, `pending_<email>` and email in one transaction (what the rules' leave branch accepts), and drops the trip's local copy.

Share status button in header shows lock icon when private, globe icon when public, member count when shared (phones use the menu entry). Share button hidden on dashboard.

**Public trip links:** Owner can toggle `public: true` on a trip via the share modal's "Public Link" toggle. When enabled, a copyable URL is shown. Signed-out users can view public trips read-only (`_isPublicView = true`); signed-in non-members get the same read-only view through `getTripRole() === 'none'`. All edit UI is hidden via the `canEdit()` gates (a signed-in non-member sees the vote buttons disabled; a signed-out viewer doesn't see them). Firestore rules allow anonymous reads when `resource.data.public == true`.

**Authorship:** Wishlist items have `addedBy` (display name), `addedByPhoto` (Google avatar URL), `addedByUid` (Firebase UID), and `addedAt` (epoch ms). Calendar events also have `addedByUid` and `addedAt`. Shown as avatar or initials chip on wishlist cards.

### Activity Badges

Tab notification badges show when a collaborator adds new places or schedules events. Red badge pill with count on Calendar/Places tabs; clears when the user switches to that tab. Red dot on individual new cards/events from other users, auto-expires after 24 hours.

- `updateTabBadges()` — counts items where `addedByUid !== currentUser.uid && addedAt > lastViewed`, renders `<span class="tab-badge">` on tab buttons
- `_isNewItem(item)` — returns true if item was added by someone else within the last 24 hours (used for red dot rendering)
- `lvKey(tab)` / `getLV(tab)` / `setLV(tab)` — localStorage-based `lastViewed` timestamps per trip per tab
- Called from `switchView()` (sets lastViewed + updates badges), `rerender()` (updates badges on remote changes). `updateTabBadges()` itself first marks the Calendar or Places tab being viewed as seen. The first visit to a trip marks both tabs seen, so it doesn't badge the whole trip as new.
- Legacy items without `addedByUid`/`addedAt` fields are silently ignored

### Accessibility plumbing

- **Dialogs:** a `MutationObserver` (next to the global Escape handler) watches every `.modal-overlay` for its `.open` class. On open it marks every other `<body>` child `inert`, focuses the first control (or the dialog box on touch, so the keyboard doesn't pop), and on close returns focus to the trigger. New dialogs get this for free only if they are a top-level `.modal-overlay` toggled via `.open`, with `role="dialog" aria-modal="true" aria-labelledby="<h2 id>"` and a close function added to the Escape handler.
- **Focus return:** save paths close the dialog and re-render in the same task, so the button that opened it is usually replaced by a copy. The observer therefore remembers the trigger by element, `id`, `onclick` string and `data-k` (a shared `this.dataset.k` handler only matches the item with the same key), and on close focuses the live equivalent. If the trigger is gone (item deleted or moved), focus goes to the active view (a temporary `tabindex="-1"`, removed on blur) instead of falling to `<body>`. A dialog opened from one closing in the same step (calendar pick → schedule) inherits that dialog's trigger; closing a dialog stacked on another returns focus to the button in the one underneath. Closing also removes any inline `.modal-alert` (a still-failing save re-appears as a toast).
- **Toasts:** `showSaveToast()` writes its text into the always-present `#srStatus` (`role="status"`) or, for errors, `#srAlert` (`role="alert"`), both `.sr-only`; the visual toast is `aria-hidden`. Both are excluded from the dialog `inert` sweep so toasts fired inside a dialog still announce. See **Toasts** below for the API.
- **Left panel:** `_syncLeftPanelA11y()` sets `#leftPanel.inert` whenever the panel is collapsed (it's only faded out) or a dialog is open, and keeps `#appLogoFlag`'s `aria-label`/`aria-expanded` in sync.
- **Keyboard paths that replace pointer-only gestures:** calendar events are `<button>`s; each day column has a `.cal-add-kb` button (visually hidden until focused) that opens `openCalAdd(dayId, null)`, since clicking an empty slot is mouse-only. The trip date picker (`#dpTrigger`, `.dp-day` buttons) uses roving tabindex with arrows / Home / End / PageUp / PageDown (`dpGridKey`), and Escape closes only the picker. View tabs follow the tabs pattern (roving tabindex, arrows, Home/End). The phone calendar date strip is one tab stop the same way (`calStripKey`), since swiping the grid is touch-only. Dashboard trip cards are a stretched `<a href="#trip/<id>">` (`.trip-card-link::after`).
- **Autocompletes:** `_comboSync(dropdown, idx)` wires any `.city-option` / `.place-search-option` dropdown and its sibling input as combobox + listbox with `aria-activedescendant`; call it after rendering results and when the highlight moves. Close one only through `_hideCombo(dd)`, so the input never keeps saying it's expanded. Escape closes an open dropdown first (even one showing only "Searching…" / "No results") before it closes the dialog.
- **Zoom:** the viewport meta no longer caps zoom (`touch-action:manipulation` keeps pinch-zoom); a `(pointer:coarse)` rule sets inputs to 16px so iOS doesn't auto-zoom on focus.
- **Trip dropdown:** a disclosure, not a listbox. Triggers (`#lpTripSelect`, `#appLogoText`) carry `aria-expanded`; items are `<button>`s; Escape closes and refocuses the trigger, and focus leaving the list closes it.

### Toasts

`showSaveToast(msg, icon, opts)` is the only toast API (`#saveToast`, one at a time). The kind comes from `opts`, **not** from the icon (`'!'` just renders a red bang, `TOAST_CHECK` an animated checkmark for confirmations such as "Saved" or "Link copied"):
- **default** — a confirmation; fades after `opts.ms` (1.6s by default), announced via `#srStatus`.
- **`{status:true, ms}`** — a transient connection notice ("Slow connection — still syncing…", "Couldn't load trip"); fades after `ms`, and `_clearStatusToast()` removes it as soon as the trip confirms or is left.
- **`{sticky:true}`** — an error or warning: stays until dismissed (✕) or replaced, announced via `#srAlert`, and not re-shown (or re-announced) while the same message is up. Raised while a dialog is open, it renders **inside** that dialog instead (`_dialogAlert` → `.modal-alert` under the heading), since the page behind is inert. **`{persist:true}`** (save failures) re-shows it as a toast when the dialog closes if saving is still failing.
- Placement: bottom-centre on desktop; on phones at the top, under the header (clear of the FAB and map sheet), or at the very top while a sheet is open. `z-index` is above dialogs, except a sticky toast that was already up when a dialog opened, which sits under the scrim.
- Save errors are rate-limited in `doSave` (see **Multiplayer sync**). Sign-in errors render inside the sign-in card (`_loginError`), because the login screen sits above the toast; only when no card is on screen (a public viewer signing in from the menu) do they fall back to a sticky toast.

### Internationalization (i18n)

Two languages: English (default) and Korean. `STRINGS` dictionary with `{ko, en}` pairs (some entries are functions for parameterized strings like `dayN`, `dayNofM`, `whenIn`, `discoverNearCity`; call them as `STRINGS.key[currentLang](…)`). Every new user-visible string goes into `STRINGS` with both languages. `t(key)` lookup returns current language value. `setLang(lang)` persists to localStorage, calls `applyLangToStaticHTML()`, `refreshDayLabels()`, and re-renders. `refreshDayLabels()` regenerates `day.date` and `day.dayName` from `isoDate` using current language — must be called after `reconcileDays()` and inside `onSnapshot` handler to prevent Firestore overwriting labels.

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

Links (Google Maps, Web, photos, avatars) render only through `urlA` / `hrefA` / `telA` (see **Escaping**), so a stored non-http(s) URL shows nothing. On touch, the small in-card controls get larger hit areas via pseudo-elements.

**Add panel** (`.wl-add-panel`): the search field + Discover pills sit at the top of the Places tab as a plain stack, with no card around them (the field is the container). It lives in `#wlPanelHost`, outside the list that re-renders (see **Rendering**). The Discover label (`globe` icon + `discoverNearCity`, "Explore near <city>:") is inline with the pills on desktop and on its own line on phones, where the pills are one edge-faded scrolling row. Pills are text only, built by `_discPills(fn)` from `DISC_TITLE`.

**View toggle** (`.wl-view-toggle`): grid / list switcher on the right side of the Places header, persisted via `localStorage['palo-wish-view']`; with no saved choice, phones start on the compact list and wider screens on the grid. `wishViewMode` controls the `.wl-grid.grid` / `.wl-grid.list` class. List view uses a 2-column CSS grid per card when a photo exists (60×60 thumbnail spans all rows; all other children flow in column 2). In list view, Edit Place is absolute-positioned to the top-right, category + author meta row appears under the title, and Like button sits inline next to author.

**Category filter chips**: `all / food / bar / culture / shopping / hotel / transport` plus a status row (`all / unscheduled / scheduled`, hidden for hometown trips) and a `Most loved` sort toggle that applies `sortByVotes(list)` to the filtered wishlist. On phones the rows scroll sideways and keep their scroll across re-renders. The empty state says whether the trip has no places or the filters hide them all, and then offers **Clear filters** (`clearWlFilters()`).

**A place you just added** (`_wlLanded(w)`) resets any filter that would hide it, scrolls its card into view and lets it rise in with a fading ring (when on Places).

### FAB (Floating Action Button)

**Mobile only.** Fixed-position "Add Place" button (`.fab`). Hidden on dashboard, on mobile map view (≤768px), for non-editable trips (`canEdit()`), while the trip is still loading (`_tripLoading || !DATA_REF`), and **on desktop** (replaced by `.nav-add-btn` in the navbar). **Visibility always goes through `updateFab(v)`** (never set `.fab` `display` directly): `switchView`, `_enterTripChrome`, `_listenTripMeta`, `showDashboard`, the end of loading, and `window.resize` all call it.

### Search field

One component (`.fp-search`, built by `_searchFieldH()`) is used by the Places tab (`#wlQuickUrl`, in `#wlPanelHost`) and the desktop map sidebar (`#mapSearchBar`); the lodging picker and `#wishModal` keep their own inputs. It is a single 46px bar (12px radius) with the `search` icon on the left, an opaque `--field-bg` fill and a 1px `--field-border`; hover strengthens the border, focus (`:focus-within`) switches to `--field-bg-focus` with an `--accent` border and a 3px ring (no layout shift; a transparent outline keeps it visible in forced-colors). The bare `<input class="fp-search-input">` inside carries the combobox ARIA (`_comboSync` finds it as the sibling of the dropdown), its long accessible name is `STRINGS.quickAddLabel` and its short one-line placeholder is `quickAddPlaceholder` (fits 320px in English and Korean). The clear button (`.fp-search-clear`, `icon('x')`, `STRINGS.clearSearch`, 44px hit area on coarse pointers) is visible only while the field has text, via `:has(.fp-search-input:not(:placeholder-shown))`, so programmatic value changes (`selectPlace`, `quickAddPlace`) update it with no JS; `clearQuickSearch()` empties the field, cancels a pending or in-flight autocomplete and returns focus to the input. The suggestions attach flush under the bar (same width, bottom radius 12px, one shared `--fp-bd` border; the bar squares its bottom corners while they are open, detected with `:has(> .place-search-dropdown:not([style*="none"]))` because the dropdown is toggled by inline `display`). Emptying the field (backspace or clear) also cancels the debounced search so stale suggestions never reopen.

### Google Places Search

Dual-mode input: detects URL pattern (→ URL expansion via worker) vs. search text (→ Google Places Autocomplete API). Session tokens (`crypto.randomUUID()`) bundle autocomplete + details requests for billing. Location bias uses trip city coords (50km radius).

**Worker endpoints** (`worker.js`):
- `POST /api/places/autocomplete` — proxies Google Places Autocomplete (New) API
- `GET /api/places/details?placeId=...` — proxies Google Places Details (New) API with enterprise-tier field mask including `rating,userRatingCount`
- `POST /api/places/discover` — proxies Google Places Text Search (New) API for bulk discovery (returns top 5 results for a category in a city, deduplicates against existing places)
- `GTYPE_TO_CAT` maps Google types → app categories (food, bar, culture, shopping, hotel, transport). Details and Discover both go through `mapGoogleTypesToCategory(primaryType, types)`: the `primaryType` wins if mapped; otherwise the secondary types are scanned for a **non-shopping** category first, then shopping, so a museum or food court that also carries `gift_shop` / `shopping_mall` keeps its category. The generic `store` counts only as the `primaryType` (`GTYPE_PRIMARY_ONLY`), since Google also puts it on pharmacies, gas stations and delis. Shopping covers retail destinations only (malls, department stores, clothing, shoes, jewelry, cosmetics, gifts, books, electronics, sporting goods, toys, thrift, furniture…); grocery and errand types (`supermarket`, `grocery_store`, `convenience_store`, `food_store`, `liquor_store`, `market`, `farmers_market`, `hardware_store`, …) stay unmapped → `''` / `other`. `osmToCategory` maps the matching OSM `shop=*` values to shopping the same way.
- `DISCOVER_CATEGORIES` maps 7 category keys → query templates + Google types: `restaurants`, `cafes`, `bars`, `museums` (`type: null`), `bakeries`, `parks`, `shopping` (`type: null`, "best shopping malls, department stores and boutiques in", `cat: 'shopping'`)

**Add-place modal** (`#wishModal`): Two-mode toggle — "Search a place" (default, search input + form) and "Recommend me" (category buttons + inline results). Shows photo preview (`#wishPhotoPreview`) and indigo checkmark in hint text (`#wishMapsHint`) when place data is populated from search. Toggle hidden in edit mode.

**Discover Places**: Seven categories (Restaurants, Cafes, Bars, Museums/Attractions, Bakeries, Parks, Shopping), in `DISC_TITLE` order; the Shopping pill only returns results once the worker with `DISCOVER_CATEGORIES.shopping` is deployed (400 until then). Two entry points: Places tab horizontal pill buttons → standalone `#discoverModal`, and Add Place modal recommend pane → inline results. While loading, `_discLoading(id)` shows skeleton rows shaped like results so the sheet opens at about its final height; results then fade in. Results show photo, name, address, rating (stars + count), price level, with individual Add buttons + "Add All" footer. Per-session cache (`_wishRecommendCache`) keyed by `tripId:category` avoids repeated API calls.

**`detectCategory(name)`** (quick-add and the modal's prefill) has a shopping rule after the bar rule: mall / outlet / store(s) / shops / boutique / centro comercial / duty free / souvenir / bazaar / artesanías / 쇼핑 / 백화점 / 아울렛 / 면세점 / trailing 몰, unless the name also says hotel, café, coffee, bakery, restaurant and the like. "Market" / mercado / 시장 are deliberately not shopping (food halls).

### Currency Converter

Inline card inside the desktop left panel (`#lpCurrencyCard`, rendered by `renderLpCurrency()`). Rate from `https://api.frankfurter.dev/v1/`. Currency auto-detected from trip's `cityCountryCode` via `CC_TO_CURR` map / `_detectTripCurrency()`. The standalone `#currModal` and `openCurrConverter` / `closeCurrConverter` functions are removed; mobile has no currency UI this pass (follow-up ticket will port to a mobile sheet).

### Lodging chips (calendar day header)

Each day object may carry `day.lodgingWishId`, a pointer to a wishlist item with `category:'hotel'`. `renderDayChips(day)` renders a full-width chip, `icon('hotel')` + the hotel name, under the date in the desktop header (`renderCalHeader`) and in the phone meta line under the date strip (`renderCalDayNav` → `#calDayMeta`). Empty days show a dashed `+ Lodging` button (`icon('plus')` + `icon('hotel')` + `addLodging`) when `canEdit()`. No emoji; the itinerary export still writes `🏨` in its text.

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
