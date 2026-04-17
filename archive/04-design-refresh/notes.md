# Chapter 4 — Design refresh (Figma → code)

**Commit:** [`6294b3e`](../../../../commit/6294b3e) · 2026-04-09 · 4,071 lines (+168) · Opus 4.6

## What I was solving

The MVP looked like an MVP. Tabs were flush to the viewport edge, the calendar had rainbow events in six category colors, and the header was a strip of buttons with no hierarchy. I'd been sketching a cleaner shell in Figma — rounded inset canvas, a floating pill tablist, two-color calendar.

## What shipped

- **Trip canvas chrome**: when `body.in-trip` is set, the trip views render inside an inset rounded card pinned to the viewport (`100vh - 80px`). Body scroll is suppressed; content scrolls inside the card. Mobile reverts to a flat full-width layout.
- **Theme tokens**: `--page-bg` (outside the card), `--canvas-bg` (inside), `--tab-active-bg` / `--tab-active-fg` (selected tab). Both light and dark get full values.
- **Floating tablist**: centered absolutely, 380×40, 16px radius. "Calendar / Map / Places" in English; the underlying `WISHLIST` array still uses the legacy name.
- **Two-color calendar events**: indigo for time-assigned places (`wl_ev_*`), gray for time blocks (`ev_*`). Category color coding moved to map markers + place cards only — the calendar grid became scannable.
- **Flag button → dashboard**. Mobile hover swaps the emoji for a home icon.
- **Place edit modal**: top-aligned category icon, primary "Map view" + secondary "Google Maps ↗" action row. Delete relabeled "시간 해제" for wishlist-linked events so time unlinks without deleting the place.

## Working with Claude + Figma

This chapter was design-led. I mocked the canvas shell + tablist in Figma, then pasted the frame into Claude (figma MCP) along with the target file (`index.html`). Claude's job was translation — match the Figma tokens to the project's CSS variables, reuse existing selectors instead of inventing new ones, preserve the mobile fallback. The `--page-bg` / `--canvas-bg` naming came from the Figma variable set.

The two-color calendar was the opposite direction: code-led, then rationalized in Figma after. I decided category colors on the calendar made it harder to scan at a glance — indigo/gray collapsed the decision down to "is this a place or a time block," which is the only question you're actually asking at that zoom level. The invariant ("event id prefix = type, no `type` field") got written into CLAUDE.md so future sessions wouldn't undo it.
