# Chapter 1 — Mexico City bootstrap

**Commit:** [`a235c88`](../../../../commit/a235c88) · 2026-03-11 · 1,031 lines · Sonnet 4.6

## What I was solving

A friend and I were flying to Mexico City 3/17–3/21. I wanted a shared itinerary that showed both a calendar view and a map of every place, with the option to reshuffle during the trip. Google Sheets and Notion both stopped being useful once you wanted pins on a map with walking routes. Apple's "Plans" was close but couldn't be collaboratively edited.

## What shipped

- Single-page app. One `index.html`, no bundler, no framework.
- Hardcoded `SEED_DAYS` and `SEED_WISHLIST` — 5 days of Mexico City, all places pre-pinned with coords.
- Calendar (time-grid 8am–midnight) and Map (Leaflet) views toggled by tabs.
- Firestore persistence (`travel/mexico` doc) with localStorage fallback. No auth yet — single shared doc, anyone with the link could edit.
- "Wishlist" → schedule flow: click an empty calendar slot, pick a wishlist item, it snaps to the half-hour.
- Parse Google Maps URLs (`maps.app.goo.gl` shortlinks + full URLs) to auto-create wishlist items with coords + category.

## Working with Claude (Sonnet 4.6)

One big commit. I described the domain ("trip with a friend, calendar + map, pull place data from Google Maps links") and let Claude scaffold the whole file. The seed data is handwritten — I wanted real places I'd already researched, not generated suggestions. Claude filled in the mechanical stuff: Leaflet init, the overlapping-event geometry for the calendar, the URL-expansion serverless function.

Bootstrapping with real trip data (not Lorem Ipsum) meant every interaction I tested was a real scenario. Every ugly edge — two events overlapping in the calendar, a Korean place name in a Maps URL, a place I needed to move from Tuesday to Thursday — came from my actual week.
