# Faropin — Product Requirements Document

## Overview

Faropin is a collaborative travel planning app. Plan trips with a time-grid calendar, interactive map, and wishlist. Invite travel companions to co-plan. Mobile-first, works offline-ready via localStorage cache.

**Live:** https://faropin.com

---

## Current Features

### Authentication
- **Google sign-in** (Firebase Auth popup) — no magic link, no password
- Login screen shown when unauthenticated; nav menu hidden until signed in
- User profile (`users/{uid}`) written on each sign-in

### Dashboard
- Animated globe (cobe.js) showing trip cities with flag emoji overlays
- Trip card grid: emoji, name, city, date range, edit/delete actions
- Trip emoji auto-derived from country flag
- "+ Add New Trip" CTA

### Trip Views
Three tabs per trip: **Calendar → Map → Places**. On desktop the views render inside an inset rounded canvas card; mobile uses a flat full-width layout.

**Calendar**
- Time-grid (8AM–midnight, 64px/hr)
- Desktop: paginated when trip has many days (min 160px column width), with page navigation dots/arrows at top
- Two-color event scheme: indigo for time-assigned places, gray for free time blocks (no category-based coloring in the grid)
- **Lodging chip per day header:** full-width `🏨 <hotel name>` pointer into a wishlist hotel. Empty days show a dashed "+ 🏨 Lodging" button. "Apply to all days" in the picker bulk-assigns a hotel across the trip.
- Tapping a time-assigned place opens a place-card modal with "View on map" button, "Google Maps" external link, and "Remove from schedule" to unschedule (keeps the place in Places)
- Per-event edit / delete modal, simplified: **minimal default fields** (Date, Start/End, Title, Notes) with a pill row to reveal optional fields on demand (Map link, Description, Link, Category, Optional). Calendar-click empty slots always create time blocks; new places flow through the Places tab instead. **Date picker** locked to trip date window.
- Weather forecast per day (Open-Meteo), with °C / °F toggle in the left panel
- Mobile: single-day view with swipe nav

**Map**
- Leaflet.js interactive map with emoji-badge markers
- OSRM walking routes per day
- Day filter pills; mobile bottom sheet with event cards
- Fly-to on event tap; popovers for assigned places include an 편집 button

**Places** (formerly Wishlist)
- Place cards with photo thumbnails, editorial summary, price level, opening hours, phone number
- Card layout: author + Like button inline next to the title, category + Edit Place row, schedule row (date/time + Edit Schedule or right-aligned + Schedule), dividing line, links row (Google Maps ↗, Web, phone)
- **Voting:** up-only thumbs-up per user per place; shows count + avatar stack of voters. Filter bar includes a "Most loved" sort. Denormalized voter info (name + photo) stored on each vote so avatars render without async user lookups.
- **Add panel** at top groups the search input and Discover pills in a light-tinted card. Discover label inlines with the pills (`🌐 Explore near <city>:`).
- **Search bar**: type to search via Google Places API autocomplete or paste a Google Maps link
- Selecting from autocomplete opens add-place modal with photo preview, all fields pre-filled (name, category, address, coords, Google Places metadata)
- **Google Places API integration**: autocomplete with session tokens, place details with enterprise-tier fields (opening hours, editorial summary, price level, phone number)
- **Category filters:** All / Food / Bar / Culture / Hotel / Transport. Status filters: All / Unscheduled / Scheduled. "Most loved" sort toggle.
- **Grid / List view toggle** on the right side of the Places header (persisted to localStorage). List mode shows a 60×60 thumbnail on the left with the name + notes, author+Like chip, schedule row, and links inline.
- Desktop: **search icon button in navbar** next to view tabs. Replaces FAB on desktop.
- Schedule directly to calendar from a place card

**Map**
- Search bar in desktop sidebar for adding places directly from map view (same autocomplete as Places tab)

### Trip Creation
- City search → auto-detects country flag, timezone
- Name + date range required to enable create
- **Party size** field (default 1) — surfaces in exported itinerary markdown
- **Airport auto-seeded** into wishlist — best-effort Google Places lookup for "`<city>` airport" (3.5s timeout; never blocks trip creation)
- Per-trip day colors auto-assigned

### Trip Sharing (Collaboration)
- Owner-only share modal: invite by email
- Roles: `owner` (full control) and `write` (add/edit events & wishlist)
- Pending invites: if invitee has no account, stored as `pending_<email>` — auto-resolved on their sign-in. Share modal also auto-repairs corrupted dot-path entries (Firestore splits dots in emails into nested fields).
- **Public trip links:** Owner can toggle "Public Link" in share modal — generates a shareable URL that anyone can view without signing in (read-only). Share status button shows globe icon when public, lock when private, member count when shared.
- Wishlist items show author avatar/initials

### Activity Badges
- Red badge pill with count on Calendar/Places tabs when a collaborator adds new places or schedules events
- Badge clears when user switches to that tab
- Red dot indicator on individual new place cards and calendar event blocks (from other users, within last 24 hours)
- Own additions never show badges or dots

### Email Notifications
- **Welcome email** on first sign-in
- **Invite email** when trip owner shares with a new collaborator
- **Trip reminders** at 7 days and 1 day before departure (via Cloudflare Worker cron)
- Bilingual templates (en/ko), styled with Faropin thumbnail header

### Trip Chrome (desktop)
- **Left side panel** (280px, toggleable): Faropin brand, trip name + dates + Edit, inline currency converter, per-day weather summary, Export itinerary, theme / language / °C–°F toggles, Feedback, How to use, "Built by Jihoon" footer. Slides in from the left; header and main content animate to make space.
- **Flag button** toggles the panel (hamburger icon when closed, side-panel-collapse icon when open). The trip's flag emoji is displayed inline before the trip title instead.
- **Profile chip** (top-right): avatar + display name → popover with account info + Sign out. Replaces the old hamburger dropdown on desktop.
- **Trip switcher:** trip name + chevron open the trip dropdown listing all trips reverse-chronological. "All Trips" entry routes to the dashboard (primary dashboard affordance on desktop).
- **How-to-use** static help modal: 4 sections (Add places, Schedule them, Share with friends, Export for ChatGPT), bilingual.

### Trip Chrome (mobile)
- Flag button (top-left) navigates to the dashboard; on hover, the flag emoji swaps to a home icon
- Viz-menu hamburger (top-right) is the canonical entry for settings (theme, language, feedback, sign-out)
- Mobile: flag button hidden on certain views, trip emoji prepended inline before the trip name

### Internationalization
- English (default) and Korean
- Language toggle in hamburger menu, persists to localStorage
- All UI strings translated; city names always stored in English (Nominatim `Accept-Language: en`)

### Discover Places
- Six categories: Restaurants, Cafes, Bars, Museums/Attractions, Bakeries, Parks
- Two entry points: Places tab discover buttons and Add Place modal "Recommend me" toggle
- Results show photo, name, address, rating (stars + count), price level
- Individual Add buttons + "Add All" footer
- Per-session cache avoids repeated API calls when switching categories

### Export for AI
- **Per-trip export** (left panel → Export itinerary) generates a markdown file with party size, weather table, lodging section, per-day itinerary, unscheduled places grouped by category, and an LLM prompt stub. Copy to clipboard or download `.md`.
- **Bulk export** from dashboard: "Export multiple" CTA → pick trips → generate a single merged markdown with all selected trips.
- Designed for pasting into ChatGPT / Claude / Gemini for itinerary-aware questions.

### Other
- Dark / light theme toggle, weather unit toggle (°C / °F; refetches Open-Meteo with the right `temperature_unit` param)
- Currency converter inline in left panel (currency auto-detected from trip country via Frankfurter API)
- Google Maps short URL parsing + Google Places API proxy (Cloudflare Worker: `palo-travel-expand-url.jihoon8846.workers.dev`)
- Mobile: FAB hidden on map view; paste from Google Maps share handles name+URL text
- Place photo thumbnails on cards (Google Places Photos API, browser HTTP-cached)
- Place cards show rating (stars + review count) when available

---

## Data Model

```
users/{uid}
  email, displayName, createdAt, lang, welcomeEmailSent

trips/{tripId}
  id, name, emoji, color, startDate, endDate, partySize
  city, cityLat, cityLng, cityCountryCode, timezone
  access: { [uid]: 'owner'|'write', [pending_email]: 'write' }
  accessEmails: [email]  (for Firestore query indexing)
  public: boolean  (enables unauthenticated read-only access)
  createdAt, archived, remindersSent: { '7d': bool, '1d': bool }

trips/{tripId}/data/main
  days: [{ id, date, isoDate, theme, color, events[], lodgingWishId? }]
  wishlist: [{ id, name, notes, category, mapsUrl, lat, lng, visited, calDayId, calEventId, addedBy, addedByPhoto, addedByUid, addedAt, googlePlaceId, photoUrl, websiteUrl, primaryType, openingHours, editorialSummary, priceLevel, phoneNumber, rating, userRatingCount, votes?: { [uid]: { name, photo, at } } }]
```

**Event fields:** `id, time, endTime, title, subtitle, notes, category, optional, lat, lng, link, mapsUrl, addedByUid, addedAt`

**Event types:** distinguished by id prefix — `wl_ev_*` = time-assigned place (linked to a wishlist entry via `calEventId`), `ev_*` = standalone time block. No explicit `type` field. Calendar grid renders the two with different colors.

**Firestore rules:** per-trip access enforced — users whose email is in `accessEmails` can read/write a trip. Public trips (`public == true`) allow unauthenticated reads. Owner-only for metadata edits, invites, and deletion. `users/{uid}` world-readable for email→UID lookup.

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Vanilla JS, single `index.html` (no framework) |
| Database | Firebase/Firestore (`mexico-trip-c5644`) |
| Maps | Leaflet 1.9.4 + OSRM routes |
| Places search | Google Places API (New) via Cloudflare Worker proxy |
| Geocoding | Nominatim (OpenStreetMap) |
| Weather | Open-Meteo |
| Currency | Frankfurter API |
| URL expansion + API proxy | Cloudflare Worker |
| Hosting | Vercel |

---

## Implemented: Auth & Collaboration

### User Accounts

- Auth via **Google sign-in** (Firebase Auth popup)
- On sign-in: auto-create/update `users/{uid}` doc

```
users/{uid}
  email, displayName, createdAt
```

### Trip Access Control

- Trip doc has `access: { [uid]: 'owner'|'write' }` and `accessEmails: [email]`
- `owner` — full control (edit metadata, invite/remove users, delete trip)
- `write` — add/edit events and wishlist items
- Non-members cannot access trip data

| Action | Owner | Write | Non-member |
|--------|-------|-------|------------|
| View trip | ✅ | ✅ | ❌ |
| Edit trip metadata | ✅ | ❌ | ❌ |
| Add/edit events & wishlist | ✅ | ✅ | ❌ |
| Invite/remove users | ✅ | ❌ | ❌ |
| Delete trip | ✅ | ❌ | ❌ |

### Invitations

- Owner invites by email from share modal
- If email matches existing `users` doc → UID added to `access` immediately
- If no account → stored as `pending_<email>` in `access`
- On sign-in: `resolvePendingInvites(user)` queries trips with matching `accessEmails`, converts `pending_<email>` → UID entry

### Authorship

Wishlist items have:
- `addedBy: string` (display name at creation)
- `addedByPhoto: string` (Google avatar URL)

**UI:** Wishlist card shows author avatar or initials chip with tooltip.

**Note:** Calendar events do not yet track authorship.

---

## UX Flows

### Sign In
1. User taps "Google로 로그인" on login screen
2. Google sign-in popup → authenticated → dashboard loads
3. User profile written/updated in `users/{uid}`

### Invite Flow
1. Owner: hamburger menu → "공유 설정" → enter email → add
2. If email has account → added immediately with `write` role
3. If no account → stored as pending; auto-resolved when invitee signs in
4. Owner can remove users from share modal

---

## Future / Out of Scope

- Real-time collaborative editing / presence indicators
- Comments or reactions on events
- Guest leave / kick with item cleanup
- Trip duplication (copy as template)
- Export to PDF / image
- **Left panel on mobile** — current implementation is desktop-only; mobile still uses the legacy hamburger dropdown
- **Gemini "polish with AI" pass** on exported itinerary markdown (markdown is currently templated client-side; a future pass could route through a worker endpoint for narrative rewriting)
- **Multi-leg flights / intercity transport entities** — brainstormed but scoped out; current model only supports single-pointer lodging per day, no dedicated transport entity (airports live as wishlist items with `category:'transport'`)
