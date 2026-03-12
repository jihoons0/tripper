# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A single-file static web app (`index.html`) for a Mexico City travel itinerary (3/17~3/21). Deployed via Vercel as a static site. Data is persisted via `/api/data`, `/api/days`, `/api/wishlist` endpoints (not hardcoded).

## Local Development

```bash
npm run dev   # starts Express server with --watch (auto-restart on file changes)
npm start     # starts Express server without watch
```

`server.js` is an Express server that serves `index.html` as a static file and provides the API endpoints. Data is persisted locally to `data.json`. Visit `http://localhost:3000` after starting.

**API endpoints (all backed by `data.json`):**
- `GET /api/data` — returns `{ days, wishlist }`
- `PUT /api/days` — replaces `days` array
- `PUT /api/wishlist` — replaces `wishlist` array
- `GET /api/expand-url?url=<shortUrl>` — server-side redirect-follow for Google Maps short URLs (`maps.app.goo.gl`)

## Deployment

Hosted on Vercel as a static site (`vercel.json` routes everything to `index.html`). In production, data persists via Firebase/Firestore (not `data.json`).

## Architecture

Everything lives in one file (`index.html`): HTML structure, CSS (CSS variables for theming), and vanilla JavaScript. No frameworks, no bundler, no dependencies beyond CDN-loaded libraries:
- **Leaflet 1.9.4** — interactive map (`#leaflet-map`)
- **html-to-image** — PNG export feature

### Data Model

`DAYS` and `WISHLIST` start empty and are loaded async from `/api/data` via `loadData()` on `DOMContentLoaded`. Each day has `id`, `date`, `dateShort`, `theme`, `color`, `isoDate`, and an `events` array. Each event has `id`, `time`, `endTime`, `title`, `subtitle`, `notes`, `category`, `optional`, `lat`, `lng`.

Changes are auto-saved via `scheduleSave()` → `doSave()` (debounced 800ms, PUTs to `/api/days` and `/api/wishlist`).

Category constants are in `CAT` object: `food`, `bar`, `culture`, `hotel`, `conference`, `transport`, `other`. Category icons are in `CAT_ICONS` object.

### Views

Three views toggled via `switchView(v)`, tab order: **Calendar → Map → Wishlist**:
- **Calendar** (`#view-calendar`) — time-grid layout, 8AM–midnight, 64px per hour (`HOUR_PX`)
- **Map** (`#view-map`) — Leaflet map with sidebar event list (desktop) / fullscreen map with overlay UI (mobile)
- **Wishlist** (`#view-wishlist`) — card grid with category/status filters

### Mobile-Specific UI

**Calendar (≤768px):**
- `.cal-header-row` is hidden; a sticky `.cal-day-nav` bar replaces it
- Nav bar shows: colored dot + date, weather chip, pagination dots, map-shortcut button, prev/next arrows
- Day theme text is hidden in both desktop header and mobile nav (removed)
- `calPage` (0-indexed) tracks the visible day; `setCalPage(idx)` switches days
- Only the `.active-day` column is shown; others are `display:none`
- `renderCalDayNav()` renders the nav bar (also called after weather loads)
- Each day column (desktop) and nav bar (mobile) has a map icon button → `goToMapDay(dayId)`

**Map (≤768px):**
- Sidebar hidden; map is fullscreen
- `.map-mob-tabs` — Day 1–5 pill buttons float top-left over the map
- `.map-mob-sheet` — bottom sheet with day label, fit-map button, calendar-shortcut button, horizontal-scroll event cards
- `mapMobDay` (0-indexed) tracks selected day; `setMapMobDay(idx)` switches days and calls `fitMapToDay()`
- `fitMapToDay(idx)` flies the map to fit all pins for that day
- Desktop map sidebar group titles have a calendar icon button → `goToCalDay(dayId)`

### State

Global JS variables: `currentView`, `editingDayId`, `editingEvId`, `addingDayId`, `mapFilter`, `wishCatFilter`, `wishStatusFilter`, `leafletMap`, `mapMarkers`, `mapRoutes`, `_routeBuildId`, `calPage`, `mapMobDay`.

Changes are persisted server-side via `scheduleSave()` (silent — no UI indicator).

### Rendering

All views render via innerHTML string concatenation (no virtual DOM). Call `rerender()` to refresh the current view after data mutations (also triggers `scheduleSave()`).

### Key Functions

- `renderCal()` / `renderCalBody()` / `renderCalHeader()` / `renderCalDayNav()` — calendar rendering
- `setCalPage(idx)` — switch mobile calendar day
- `renderWishlist()` — wishlist card grid
- `initMap()` / `rebuildMarkers()` / `fitMapToDay(idx)` — Leaflet map setup
- `clearRoutes()` / `buildRoutes()` — remove and redraw OSRM walking route polylines per day (called inside `rebuildMarkers()`); falls back to dashed straight lines on network error; `_routeBuildId` prevents stale fetches
- `renderMapMobTabs()` / `renderMapMobSheet()` / `setMapMobDay(idx)` — mobile map overlay
- `setMapFilter(id, btn)` — desktop sidebar filter (updates list + rebuilds markers); respects current `mapFilter` when rendering active button styles
- `goToMapDay(dayId)` — sets `mapFilter` + `mapMobDay`, switches to Map tab, triggers route/marker rebuild and `fitMapToDay`
- `goToCalDay(dayId)` — sets `calPage`, switches to Calendar tab (lands on correct day on mobile)
- `openEdit(dayId, evId)` / `saveEditEvent()` / `deleteCurrentEvent()` — edit modal
- `openAdd(dayId)` / `saveNewEvent()` — add event modal
- `openWishAdd()` / `saveWishItem()` / `deleteWishItem()` — wishlist modal
- `fetchWeather()` — fetches forecast from open-meteo, populates `weatherData`, re-renders header/nav
- `evTop(time)` / `evH(start, end)` — pixel position helpers for calendar events
- `icon(name, size)` — returns a sized Heroicons v2 outline SVG string; icon paths stored in `ICONS` object (`calendar`, `map`, `star`)

### Map Markers & Routes

Pins are rounded-square emoji badges (day color background, white border) with the category emoji centered and a number badge in the top-right corner. A triangle pointer anchors to the location.

Walking route polylines are drawn between each day's pins in time order via OSRM (`router.project-osrm.org`). Routes render in the day's color (solid, `opacity:0.55`). On network failure, falls back to dashed straight lines (`opacity:0.35`, `dashArray:'6 5'`). Routes respect `mapFilter` and rebuild on every `rebuildMarkers()` call.

### Icons

All UI icons use **Heroicons v2 outline** (24px viewBox, `stroke-width="1.5"`). The `ICONS` object holds SVG strings keyed by name (`calendar`, `map`, `star`). Use `icon(name, size)` to get a sized SVG string in JS-generated HTML. Tab buttons in static HTML have the paths inlined directly.

### Theme

Dark/light theme via `html.theme-dark` / `html.theme-light` classes and CSS custom properties (`--bg`, `--surface`, `--accent`, etc.). `cycleTheme()` toggles between them. Preference is persisted in `localStorage`.

## Roadmap

See [`TODO.md`](./TODO.md) for the multi-trip platform implementation plan — turning this single-trip app into a general-purpose trip manager with a dashboard, trip creation, hash routing, and Firestore schema migration.
