# How I built Faropin with AI

A single-file travel planning app, shipped across 36 days and 29 commits, built almost entirely in collaboration with Claude Code. This folder archives the build as seven chapters — each a working snapshot of `index.html` at the moment a major capability clicked into place, plus a short note on what I was solving and what the AI collaboration actually looked like.

> **Try them locally:** `npm run dev`, then open `http://localhost:3000/archive/01-mexico-bootstrap/index.html`. Chapters 1–2 render with real data (the legacy `travel/mexico` Firestore doc is still public-read). Chapters 3+ gate behind Google sign-in.

---

## The seven chapters

| # | Chapter | Commit | When | Lines | What clicked |
|---|---|---|---|---|---|
| [1](01-mexico-bootstrap/) | Mexico City bootstrap | [`a235c88`](https://github.com/jihoons0/palo/commit/a235c88) | 2026-03-11 | 1,031 | Calendar + Map + Firestore + Google Maps URL parsing |
| [2](02-multi-trip/) | Multi-trip + globe dashboard | [`4a45f11`](https://github.com/jihoons0/palo/commit/4a45f11) | 2026-04-01 | 2,977 | cobe globe, trip switcher, emoji→SVG |
| [3](03-multiplayer/) | Multiplayer (auth + sharing) | [`bec92f0`](https://github.com/jihoons0/palo/commit/bec92f0) | 2026-04-05 | 3,903 | Google sign-in, email invites, per-trip access |
| [4](04-design-refresh/) | Design refresh (Figma → code) | [`6294b3e`](https://github.com/jihoons0/palo/commit/6294b3e) | 2026-04-09 | 4,071 | Inset canvas chrome, two-color calendar |
| [5](05-google-places/) | Google Places enrichment | [`0138b87`](https://github.com/jihoons0/palo/commit/0138b87) | 2026-04-10 | 4,701 | Autocomplete, enriched cards, Discover |
| [6](06-voting-lodging-export/) | Voting + lodging + export | [`65532dc`](https://github.com/jihoons0/palo/commit/65532dc) | 2026-04-15 | 5,994 | Collab signals, itinerary markdown, airport seed |
| [7](07-left-panel/) | Left panel polish | [`d05dd08`](https://github.com/jihoons0/palo/commit/d05dd08) | 2026-04-16 | 6,258 | Header declutter, feedback-driven fixes |

---

## How I work with AI

### 1. Start with a self-use case, not a pitch deck

Chapter 1 was a trip I was taking with a friend in six days. I needed the app to work, not to impress anyone. Every interaction I tested was a real scenario — a place I'd actually researched, a Google Maps link I'd actually pasted, a rescheduling I actually wanted to do.

This changes the AI collaboration in a specific way: I could push back on Claude's defaults with real evidence. "Don't collapse overlapping events into a stack — the whole point of seeing this Tuesday is noticing that the conference runs into dinner." That kind of note only exists if you're actually going to Tuesday's dinner.

### 2. Hardcode the seed, generalize on a real second case

[Chapter 1](01-mexico-bootstrap/) has `SEED_DAYS` and `SEED_WISHLIST` as literals in the HTML. No trip model, no trip list. `DOC_REF = db.collection('travel').doc('mexico')` — one trip, one doc, forever.

[Chapter 2](02-multi-trip/) is when I generalized — not a day earlier. The second trip arriving on my calendar was the forcing function, and by that point I knew exactly which fields a trip actually needed (`city`, `cityLat`, `cityLng`, `startDate`, `endDate`, `color`, `emoji`) because I'd been living with the literals. Generalizing from a real second case is vastly faster than generalizing in theory.

Claude will happily over-abstract if you let it. The fix isn't to tell Claude to slow down — it's to not ask for the generalization until you have two real instances.

### 3. Feature branches, merge when live-testable

The branch graph tells the story:

```
main
├── claude/vibrant-elion   → auth, sharing, data-safety (ch 3)
├── design-update          → inset canvas chrome         (ch 4)
├── feature/google-places-search → search, enriched cards (ch 5)
├── feature/lodging-transport-votes → voting, export     (ch 6)
└── feature/left-panel-redesign → panel + polish         (ch 7)
```

Each branch is one cohesive user-facing capability. I merge when I can use the feature end-to-end on the live site, not when every edge case is handled. [Chapter 6](06-voting-lodging-export/) is the only exception — I bundled three features that shared the same data-model touches because splitting would have meant two more migrations. Claude suggested splitting; I overruled. That's a judgment call worth naming: **ask Claude for its read, then decide yourself**.

### 4. CLAUDE.md as the shared brain

The most important file in this repo after `index.html` is [`../CLAUDE.md`](../CLAUDE.md). It's ~350 lines and it grows with the codebase. Every time I add a subsystem, I add a section for it. Every time I state an invariant ("event id prefix is the source of truth for place-vs-time-block"), I write it down.

The reason: **documentation is a force multiplier for the AI, not just for me**. When I ask "move the share button into the left panel," Claude already knows the share button is a fixed-position outlier — because the architecture section says so. Without that, same request takes three clarifying turns.

You can see the effect in the commits: later chapters have shorter iterations. By chapter 7, feedback fixes land in one pass because the architecture is well-described.

### 5. Figma → code via MCP

Two design-heavy chapters used Figma as the pre-step:

- **[Chapter 4](04-design-refresh/)** — the inset canvas chrome. Drawn in Figma first with `--page-bg` / `--canvas-bg` / `--tab-active-bg` as named variables. Claude translated the Figma frame into the project's CSS variables, reusing existing selectors where they matched and only introducing new ones where the design genuinely differed.
- **[Chapter 5](05-google-places/)** — the place card redesign. Card layout drawn in Figma, Claude generated the HTML + CSS grid. The constraint I held firm on: every action button reuses `.wl-visited-toggle` (30px uniform height). State the rule once, save it to CLAUDE.md, and Claude will respect it; skip that, and it'll drift.

The figma MCP turns "here's a mock" into a concrete diff instead of a vibes-based re-implementation.

### 6. Name invariants so future sessions don't undo them

The codebase has three invariants that would be easy to break, and each lives in CLAUDE.md verbatim:

- **Event id prefix is the type.** `wl_ev_*` is a place, `ev_*` is a time block. No `type` field. Reliable check: `WISHLIST.some(w => w.calEventId === ev.id)`.
- **`reconcileDays()` never drops events.** Events falling outside the trip's new date window are stitched onto the last remaining day with a `[원래 YYYY-MM-DD]` prefix. Data loss is permanent on Firestore; there's no version history.
- **`doSave()` refuses to write if DAYS and WISHLIST are both empty.** Last-line defense against load/navigation race conditions.

These are the kind of rules that don't survive a refactor unless they're written down. I got bitten early — see the [`4404315`](https://github.com/jihoons0/palo/commit/4404315) "Data-loss guards" commit — and everything about how I work with Claude now reflects that. Hard-to-reverse actions get written into CLAUDE.md as invariants, not comments.

### 7. Let users tell you what's broken

`npm run feedback` fetches bug/feature reports from a Firestore `feedback/` collection into `feedback.md`. [Chapter 7](07-left-panel/) was mostly reading that file with Claude, deciding what to fix, and letting Claude write the fixes.

The pattern that matters: **I never auto-resolve**. Every item gets read aloud, I decide whether it's real, whether the fix is worth the risk, and only then does Claude write code. A lot of feedback items are "this is confusing" not "this is broken" — those usually want a design fix, not a code change, and the difference is invisible to the AI.

---

## What this isn't

This archive is a narrative of capability milestones, not every commit. The actual git log has 29 commits including merge commits, documentation updates, and the sort of "fix button alignment" pass you'd expect. If you want the full history: `git log --oneline --reverse`.

The Figma files aren't archived here — they live in Figma and are referenced by URL in the [figma/](figma/) placeholder. The screenshots in [01-mexico-bootstrap/](01-mexico-bootstrap/) and [02-multi-trip/](02-multi-trip/) were captured live from the archived HTML via Playwright; chapters 3–7 render current-rules Firestore behind Google sign-in and need a logged-in capture.

---

## Running the archive locally

```bash
npm run dev
# Then open any of:
#   http://localhost:3000/archive/01-mexico-bootstrap/index.html
#   http://localhost:3000/archive/02-multi-trip/index.html
#   http://localhost:3000/archive/03-multiplayer/index.html
#   ...
```

The files are preserved verbatim from their commits — the Firebase config is baked in, and the app connects to the live `mexico-trip-c5644` project. Chapters 1–2 will show seeded Mexico City data via the public `travel/mexico` doc. Chapters 3+ require signing in with a Google account that has access to a trip.
