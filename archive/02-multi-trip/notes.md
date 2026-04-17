# Chapter 2 — Multi-trip + globe dashboard

**Commit:** [`4a45f11`](../../../../commit/4a45f11) · 2026-04-01 · 2,977 lines (+1,946) · Opus 4.6

## What I was solving

Mexico worked. I had two more trips on the calendar and didn't want to throw away the tool. The single-doc model (`travel/mexico`) had to go. I also wanted something more interesting than a dropdown to jump between trips.

## What shipped

- **Dashboard view** (`#dashboard`) with a cobe.js 3D globe. Each trip pins a flag emoji to its city's lat/lng; the globe autorotates and you can drag it.
- **Trip metadata** moved to its own Firestore doc (`trips/{id}`) with `name`, `emoji`, `color`, `startDate`, `endDate`, `city`, `cityLat`, `cityLng`, `cityCountryCode`. Per-trip data nests under `trips/{id}/data/main`.
- **Hash-based routing**: `#dashboard` and `#trip/<id>` — so deep-linking worked before auth did.
- **Trip switcher dropdown** in the header (chevron next to trip name).
- **Emoji → Heroicons SVG migration**. Only country flags stayed as emoji. Built an `ICONS` object + `icon(name, size)` helper so every button used the same source.
- **Hometown card** (later removed) — a special "always-on" trip type anchored above the globe.

## Working with Claude (Opus 4.6)

I switched from Sonnet to Opus at this step. The refactor was the first real architectural shift — everything that hardcoded `DOC_REF = travel/mexico` had to generalize to `trips/{currentTripId}/data/main`. I wanted one pass that caught every path (load, save, wishlist, schedule, the debounced autosave) instead of chasing bugs one at a time. Opus could hold the whole 1k-line file in view and produce the diff in a single shot.

The cobe globe fix is a good example of where Claude earned its keep — the docs are terse, the `update({ phi })` + `requestAnimationFrame` loop is non-obvious, and projecting flag overlays onto a rotating 3D sphere is real math. I described what I wanted; Claude wrote `projectGlobe()`.
