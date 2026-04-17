# Chapter 5 — Google Places enrichment

**Commit:** [`0138b87`](../../../../commit/0138b87) (tip of `feature/google-places-search`) · 2026-04-10 · 4,701 lines · Opus 4.6

## What I was solving

Up to chapter 4, the only way to add a place was to paste a Google Maps link. That worked but missed the thing people actually want — search. And the place cards were bare: name, category, a dot on a map. No photo, no rating, no hours, no price. "Is this open?" and "is this any good?" had to be answered by tabbing away to Google.

## What shipped

- **Google Places Autocomplete** (New API) via a Cloudflare Worker proxy. Session tokens bundle autocomplete + details requests for billing.
- **Search bar** at the top of the Places tab and in the map sidebar. Type to search, paste a URL to expand — same input, two modes.
- **Selecting a result opens the add modal** (not direct-add). Photo, name, category, address, coords all pre-filled; user reviews + saves. The indigo checkmark in the hint text is the "yes, Google gave me data" signal.
- **Enterprise-tier fields** on the details request: `rating`, `userRatingCount`, `openingHours`, `priceLevel`, `phoneNumber`, `editorialSummary`, `websiteUrl`, `primaryType`, `photoUrl`. All stored on the wishlist item so the card can render without a follow-up fetch.
- **Card redesign**: photo at top, name + notes + author chip, enriched details row (price · hours · phone), dividing line, left-aligned external links (Google Maps, Web, phone). Category moved to plain text. "Edit Place" as a dedicated button — no more whole-card tap target.
- **Discover Places**: six categories (Restaurants, Cafes, Bars, Museums, Bakeries, Parks). Horizontal pills on the Places tab pop a modal with top-5 results around the trip city, each with its own Add button and an "Add All" footer.
- **Worker endpoints** (`worker.js`): `POST /api/places/autocomplete`, `GET /api/places/details`, `POST /api/places/discover`. Enterprise field mask lives here; the client never sees the API key.

## Working with Claude (Opus 4.6)

Multi-commit feature on its own branch (`feature/google-places-search`). Five commits, each scoped: (1) bring in search, (2) add enriched detail fields, (3) redesign the card around the new data, (4) add the worker's `/discover` endpoint, (5) add the Discover UI. Each merge into `main` was only when the feature was live-testable.

The card redesign is a textbook Figma → code step. I had the new layout drawn; Claude generated the HTML structure + CSS grid. The constraint I held firm on: reuse `.wl-visited-toggle` for every action button (30px uniform height) so the card didn't become a zoo of button styles. This is the sort of rule Claude will respect if you state it once and save it to CLAUDE.md; otherwise it'll drift.
