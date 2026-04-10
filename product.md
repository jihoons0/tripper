# Palo — Product Requirements Document

## Overview

Palo is a collaborative travel planning app. Plan trips with a time-grid calendar, interactive map, and wishlist. Invite travel companions to co-plan. Mobile-first, works offline-ready via localStorage cache.

**Live:** https://palo-travel.vercel.app

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
- Tapping a time-assigned place opens a place-card modal with "View on map" button, "Google Maps" external link, and "Remove from schedule" to unschedule (keeps the place in Places)
- Per-event edit / delete modal with **date picker** (locked to trip date window) for moving events between days
- Weather forecast per day (Open-Meteo)
- Mobile: single-day view with swipe nav

**Map**
- Leaflet.js interactive map with emoji-badge markers
- OSRM walking routes per day
- Day filter pills; mobile bottom sheet with event cards
- Fly-to on event tap; popovers for assigned places include an 편집 button

**Places** (formerly Wishlist)
- Place cards with category + visited/unvisited filters
- **Quick-add URL bar** at top: paste a Google Maps link to instantly add a place without opening the modal
- Full add modal: paste Google Maps URL → auto-fill name, coords, category (via Cloudflare Worker + Nominatim)
- Desktop: **"+ Add" button in navbar** next to view tabs (contrasting style: dark on light, white on dark). Replaces FAB on desktop.
- Schedule directly to calendar from a place card

### Trip Creation
- City search → auto-detects country flag, timezone
- Name + date range required to enable create
- Per-trip day colors auto-assigned

### Trip Sharing (Collaboration)
- Owner-only share modal: invite by email
- Roles: `owner` (full control) and `write` (add/edit events & wishlist)
- Pending invites: if invitee has no account, stored as `pending_<email>` — auto-resolved on their sign-in. Share modal also auto-repairs corrupted dot-path entries (Firestore splits dots in emails into nested fields).
- Share status button in header: lock icon when private, member count when shared
- Wishlist items show author avatar/initials

### Trip Switcher
- Flag button (top-left) navigates to the dashboard; on hover, the flag emoji swaps to a home icon
- Trip name + chevron next to it open the trip dropdown listing all trips reverse-chronological
- Mobile: flag button hidden, trip emoji prepended inline before the trip name
- "모든 여행 보기" link to dashboard

### Internationalization
- English (default) and Korean
- Language toggle in hamburger menu, persists to localStorage
- All UI strings translated; city names always stored in English (Nominatim `Accept-Language: en`)

### Other
- Dark / light theme toggle
- Currency converter (currency auto-detected from trip country via Frankfurter API)
- Google Maps short URL parsing (Cloudflare Worker: `palo-travel-expand-url.jihoon8846.workers.dev`)
- Mobile: FAB hidden on map view; paste from Google Maps share handles name+URL text

---

## Data Model

```
users/{uid}
  email, displayName, createdAt

trips/{tripId}
  id, name, emoji, color, startDate, endDate
  cityName, cityLat, cityLng, cityCountryCode, timezone
  access: { [uid]: 'owner'|'write', [pending_email]: 'write' }
  accessEmails: [email]  (for Firestore query indexing)
  createdAt, archived

trips/{tripId}/data/main
  days: [{ id, date, isoDate, theme, color, events[] }]
  wishlist: [{ id, name, notes, category, mapsUrl, lat, lng, visited, calDayId, calEventId, addedBy, addedByPhoto }]
```

**Event fields:** `id, time, endTime, title, subtitle, notes, category, optional, lat, lng, link, mapsUrl`

**Event types:** distinguished by id prefix — `wl_ev_*` = time-assigned place (linked to a wishlist entry via `calEventId`), `ev_*` = standalone time block. No explicit `type` field. Calendar grid renders the two with different colors.

**Firestore rules:** per-trip access enforced — only users whose email is in `accessEmails` can read/write a trip. Owner-only for metadata edits, invites, and deletion. `users/{uid}` world-readable for email→UID lookup.

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | Vanilla JS, single `index.html` (no framework) |
| Database | Firebase/Firestore (`mexico-trip-c5644`) |
| Maps | Leaflet 1.9.4 + OSRM routes |
| Geocoding | Nominatim (OpenStreetMap) |
| Weather | Open-Meteo |
| Currency | Frankfurter API |
| URL expansion | Cloudflare Worker |
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
- Read-only role (currently only `owner` and `write`)
- Email notification for invites
- Comments or reactions on events
- Calendar event authorship tracking
- Guest leave / kick with item cleanup
