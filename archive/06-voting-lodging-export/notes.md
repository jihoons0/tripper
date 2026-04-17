# Chapter 6 — Voting, lodging, itinerary export

**Commit:** [`65532dc`](../../../../commit/65532dc) (tip of `feature/lodging-transport-votes`) · 2026-04-15 · 5,994 lines (+1,293) · Opus 4.6

## What I was solving

With 3+ people on a trip, two real questions came up. First: how do we decide which places actually go on the calendar when the wishlist has 40 and the trip has 5 days? Second: once we've scheduled things, how do we hand the itinerary to someone (family, ChatGPT for suggestions, a travel agent) without re-typing it?

## What shipped

- **Wishlist voting**: thumbs-up per collaborator. `votes: { [uid]: { name, photo, at } }` — voter info is denormalized so avatars render without async lookups. "Most loved" sort applies `sortByVotes()` to the filtered wishlist. Up-only (no downvotes) — deliberately; downvotes are negotiation, upvotes are signal.
- **Lodging chip** on each calendar day header: `🏨 <hotel name>`, full width, dashed `+ 🏨 Lodging` placeholder when empty. Picker modal lists wishlist hotels + an inline Google Places search for adding a new hotel with the category forced. "Apply to all days" checkbox bulk-assigns.
- **Airport auto-seed**: on trip creation, a best-effort Places autocomplete for `"<city> airport"` runs with a 3.5s timeout. Trip creation never blocks on it; if it lands, the airport is in the wishlist as `category:'transport'`. If not, no harm done.
- **Itinerary markdown export**: `buildItineraryMarkdown()` is a pure function, reusable for per-trip or bulk export. Output includes trip header (city, flag, dates, party size, timezone), a weather table (historical-avg footnote for dates beyond forecast), overview (counts, category histogram), lodgings (deduped with night dates), per-day itinerary with events sorted by time, unscheduled places grouped by category, and an LLM prompt stub at the end.
- **Bulk export** from the dashboard: select multiple trips, concatenate under a single `# Faropin Trip Export` wrapper with `---` separators.
- **Party size** field in the trip create/edit modal; surfaced in the exported markdown.
- **Edit Event modal** cleanup: removed the Time/Place toggle at the top — event id prefix is now the only source of truth. New calendar-clicked events always save as time blocks; wishlist-linked events flow through the Places tab. A row of `+ Map link / + Description / + Link / + Category / + Optional` pills reveals fields on demand.

## Working with Claude (Opus 4.6)

Three features merged together because they all touched the same data model and I didn't want two more migrations. This is a judgment call — Claude would happily have split it into three PRs. I asked, it pushed back mildly, I overruled and it wrote the consolidated change. The convention of asking Claude for its read, then deciding, is more useful than asking Claude to decide.

The itinerary exporter is a good example of "write the pure function first, wire it in second." `buildItineraryMarkdown(meta, days, wishlist, weather, opts)` — all dependencies are arguments, no globals touched. That let the bulk-export reuse it verbatim instead of copy-pasting, and it's trivially testable from a Node REPL if anything goes wrong later.

The Edit Event modal cleanup is data-safety territory. Reclassifying events between "time block" and "place" used to be possible via a toggle; removing it closed off an easy way to lose wishlist ↔ calendar links. The invariant got re-stated in CLAUDE.md.
