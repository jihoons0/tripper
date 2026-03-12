# Multi-Trip Platform — Implementation Roadmap

This document outlines the plan to evolve the app from a single Mexico City itinerary into a general-purpose multi-trip management platform.

---

## Goal

Users can create and manage multiple trips (destination city, dates, emoji, cover color). Each trip has its own calendar, map, and wishlist. The dashboard lists all trips as cards. Existing Mexico City data migrates automatically.

---

## Firestore Schema

```
trips/{tripId}                    ← metadata doc (dashboard list query)
  id:          string             "mexico_legacy"
  name:        string             "멕시코시티"
  emoji:       string             "🇲🇽"
  city:        string             "Mexico City"
  startDate:   string (ISO)       "2026-03-17"
  endDate:     string (ISO)       "2026-03-21"
  timezone:    string (IANA)      "America/Mexico_City"
  coverColor:  string (hex)       "#f97316"
  createdAt:   Timestamp
  archived:    boolean            false

trips/{tripId}/data/main          ← data doc (heavy payload, loaded on trip open)
  days:      Day[]
  wishlist:  Wishlist[]
```

**Key Firestore paths:**
- Dashboard list: `db.collection('trips').where('archived','==',false).orderBy('createdAt','desc')`
- Load data: `db.collection('trips').doc(tripId).collection('data').doc('main')`
- Save data: same path `.set({ days, wishlist })`

---

## New Global State

```js
var currentTripId   = null;  // null = on dashboard
var currentTripMeta = null;  // Trip metadata object
var DATA_REF        = null;  // replaces hardcoded DOC_REF, set per trip
```

---

## Implementation Phases

### Phase 1 — Abstract the Data Layer
> No visible UI change. Foundation for everything else.

- [ ] Replace `const DOC_REF = db.collection('travel').doc('mexico')` with `var DATA_REF = null`
- [ ] Add `lsKeyForTrip(tripId)` → `'travel-data-' + tripId`
- [ ] Replace `lsLoad()` / `lsSave()` with `lsLoadTripData(tripId)` / `lsSaveTripData(tripId)`
- [ ] Add `lsLoadTripList()` / `lsSaveTripList(trips)` for dashboard cache
- [ ] Update `doSave()` to guard with `if (!DATA_REF) return`
- [ ] Write `loadTripData(tripId)` — mirrors `loadData()` but uses dynamic `DATA_REF`

---

### Phase 2 — Auto-Migration
> Moves the existing Mexico trip into the new schema on first load. One-time, idempotent.

- [ ] Write `migrateIfNeeded()`:
  1. `db.collection('trips').limit(1).get()` — if non-empty, skip
  2. Read `db.collection('travel').doc('mexico')`
  3. Write `trips/mexico_legacy` metadata doc (hardcoded Mexico values)
  4. Write `trips/mexico_legacy/data/main` with existing `days` + `wishlist`
  5. Copy `localStorage['mexico-travel-data']` → `localStorage['travel-data-mexico_legacy']`
- [ ] Call `migrateIfNeeded()` in `DOMContentLoaded` before router init

---

### Phase 3 — Hash Router
> Enables direct linking to trips. Works with existing `vercel.json`.

```
(no hash) / #dashboard  →  showDashboard()
#trip/{tripId}          →  openTrip(tripId)
```

- [ ] Add `initRouter()` — attaches `hashchange` listener, calls `handleRoute()`
- [ ] Add `handleRoute()` — parses `location.hash`, dispatches to `showDashboard()` or `openTrip()`
- [ ] Add `navigateTo(hash)` — sets `location.hash`
- [ ] Add `openTrip(tripId)`:
  - Show loading screen
  - Fetch `trips/{tripId}` metadata → set `currentTripMeta`
  - Call `loadTripData(tripId)` → populates `DAYS`, `WISHLIST`
  - Call `updateHeader(currentTripMeta)`
  - Show trip views (hide dashboard), call `switchView('calendar')`
- [ ] Add `goToDashboard()`:
  - Clears `currentTripId`, `currentTripMeta`, `DAYS`, `WISHLIST`
  - Calls `destroyMap()` to reset Leaflet instance
  - Calls `navigateTo('#dashboard')`
- [ ] Add `destroyMap()`: `leafletMap.remove(); leafletMap=null; mapMarkers=[]; tileLayer=null;`

---

### Phase 4 — Dynamic Header
> Replaces the hardcoded "🇲🇽 멕시코시티 · 5일" header.

- [ ] Refactor `<header>` HTML to use dynamic IDs:
  ```html
  <div class="app-logo" id="appLogo" onclick="handleLogoClick()">
    <span id="appBackBtn" style="display:none">← 전체</span>
    <span id="appLogoFlag">🌍</span>
    <div class="app-logo-text">
      <h1 id="appLogoName">여행 플래너</h1>
      <div class="dates" id="appLogoDates"></div>
    </div>
  </div>
  ```
- [ ] Write `updateHeader(trip)`:
  - `trip = null` → shows "여행 플래너", hides back button and view tabs
  - `trip = {...}` → shows trip emoji, name, date label, back button, view tabs
- [ ] Write `tripDateLabel(trip)` → `"3월 17일(화) ~ 21일(토) · 5일"` from `startDate`/`endDate`
- [ ] Add `handleLogoClick()` → calls `goToDashboard()` when inside a trip

---

### Phase 5 — Dashboard View
> The home screen listing all trips.

- [ ] Add `<section id="view-dashboard" class="view">` to HTML
- [ ] Add dashboard CSS: `.dash-view`, `.dash-grid`, `.trip-card`, `.trip-card-top`, `.trip-card-emoji`, `.trip-card-name`, `.trip-card-dates`, `.trip-card-meta`, `.new-trip-card`
- [ ] Write `showDashboard()`:
  - Hides trip views (`#view-calendar`, `#view-wishlist`, `#view-map`), hides FAB
  - Shows `#view-dashboard`
  - Calls `updateHeader(null)` then `loadDashboard()`
- [ ] Write `loadDashboard()`:
  - Fetches `trips` collection (Firestore → `lsLoadTripList()` fallback)
  - Calls `renderDashboard(trips)`
- [ ] Write `renderDashboard(trips)`:
  - innerHTML string builds "＋ New Trip" dashed card + one `.trip-card` per trip
  - Card: emoji badge (background: `coverColor+'20'`, border-left: `coverColor`), name, city, date range, day count pill, archive button
  - Empty state if `trips.length === 0`

---

### Phase 6 — Trip Creation
> Users create new trips from the dashboard.

- [ ] Add `#tripCreateModal` HTML with fields:
  1. Emoji/flag (text, max 2 chars, placeholder `🌍`)
  2. Trip name (text, required)
  3. Destination city (text)
  4. Start date (`<input type="date">`)
  5. End date (`<input type="date">`)
  6. Timezone (`<select>`: Asia/Seoul, America/Mexico_City, America/New_York, Europe/London, Europe/Paris, Asia/Tokyo, UTC)
  7. Cover color (`<input type="color">` + 6 preset swatches)
- [ ] Write `openTripCreate()` / `closeTripCreate()` / `saveTripCreate(e)`
- [ ] Write `generateDaysForRange(startDate, endDate, color)` → `Day[]` one per calendar day, empty `events: []`
- [ ] Write `createTrip(meta)`:
  1. Generate `tripId = 'trip_' + Date.now().toString(36)`
  2. Write `trips/{tripId}` metadata
  3. Write `trips/{tripId}/data/main` with generated days + empty wishlist
  4. Cache to localStorage
  5. `navigateTo('#trip/' + tripId)`

---

### Phase 7 — Archive / Delete
- [ ] Add archive (🗑️) icon button to each trip card
- [ ] Write `archiveTrip(tripId)`:
  - `confirm()` prompt
  - `trips/{tripId}.update({ archived: true })`
  - `localStorage.removeItem(lsKeyForTrip(tripId))`
  - Reload dashboard

---

### Phase 8 — Variable Day Count
> Allows trips of any length (not just 5 days).

- [ ] Change `grid-template-columns: 58px repeat(5,1fr)` → `58px repeat(var(--day-count,5),1fr)` in CSS
- [ ] Set `--day-count` inline style on `.cal-header-row` and `.cal-body-row` using `DAYS.length`
- [ ] Mobile calendar nav: derive day count from `DAYS.length` instead of hardcoded `5`

---

### Phase 9 — Polish
- [ ] Hide FAB on dashboard; show only inside a trip
- [ ] Disable PNG export / print in viz-menu when on dashboard
- [ ] Trip edit modal — reuse create modal form, pre-populated, updates metadata only
- [ ] Mobile: dashboard grid single-column at `<480px`
- [ ] `<title>` updates to trip name when inside a trip
- [ ] Firestore composite index: `archived ASC + createdAt DESC` (or sort client-side to avoid it)

---

## Helper Function Reference

| Function | Purpose |
|---|---|
| `migrateIfNeeded()` | One-time auto-migration from `travel/mexico` → `trips/mexico_legacy` |
| `loadTripData(tripId)` | Replaces `loadData()` — uses dynamic `DATA_REF` |
| `lsKeyForTrip(tripId)` | Returns per-trip localStorage key |
| `lsLoadTripData(tripId)` | Scoped localStorage read |
| `lsSaveTripData(tripId)` | Scoped localStorage write |
| `lsLoadTripList()` / `lsSaveTripList(trips)` | Dashboard metadata cache |
| `initRouter()` | Attaches hash router on DOMContentLoaded |
| `handleRoute()` | Reads `location.hash`, dispatches view |
| `navigateTo(hash)` | Sets `location.hash` |
| `openTrip(tripId)` | Loads trip data, updates header, shows trip views |
| `goToDashboard()` | Clears trip state, shows dashboard |
| `destroyMap()` | Tears down Leaflet instance between trips |
| `showDashboard()` | Shows `#view-dashboard`, hides trip views |
| `loadDashboard()` | Fetches trip list from Firestore |
| `renderDashboard(trips)` | innerHTML renders trip cards |
| `updateHeader(trip)` | Dynamic header update (null = dashboard) |
| `tripDateLabel(trip)` | Human-readable date range string |
| `handleLogoClick()` | Back navigation from trip → dashboard |
| `openTripCreate()` / `closeTripCreate()` | Create modal open/close |
| `saveTripCreate(e)` | Form submit → `createTrip()` |
| `createTrip(meta)` | Writes Firestore docs, navigates to new trip |
| `generateDaysForRange(s,e,c)` | Produces `Day[]` for a date range |
| `archiveTrip(tripId)` | Soft-deletes trip |

---

## Key Risks

| Risk | Mitigation |
|---|---|
| Firestore composite index needed for `where + orderBy` | Sort client-side after fetching to avoid index requirement |
| Leaflet instance persists between trips | `destroyMap()` before every `openTrip()` |
| `grid-template-columns` hardcoded to 5 days | CSS variable `--day-count` set dynamically from `DAYS.length` |
| Migration runs on every load | Guard: `trips.limit(1).get()` — skip if collection non-empty |
| Old `travel/mexico` doc not deleted | Keep it as safe fallback; delete manually once confirmed |
