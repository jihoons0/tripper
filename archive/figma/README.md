# Figma files

Faropin used Figma as the design pre-step for two chapters:

- **[Chapter 4 — Design refresh](../04-design-refresh/)**: the inset canvas chrome, floating tablist, two-color calendar system. Design tokens (`--page-bg`, `--canvas-bg`, `--tab-active-bg`, `--tab-active-fg`) were named in Figma first and ported verbatim into the CSS variable set.
- **[Chapter 5 — Place card redesign](../05-google-places/)**: the enriched card layout with photo, author chip, enriched details row, external links. Grid structure drawn in Figma, translated via Claude + the figma MCP.

## How to link your Figma files

Drop a `links.md` in this folder with the frame URLs, or paste exports here as `.png` / `.svg`. The main archive README references this folder but doesn't assume a specific structure.

## Design tokens

The CSS variables in `index.html` that originated in Figma:

```
--page-bg            /* outside the inset card */
--canvas-bg          /* inside the inset card, also floating tablist bg */
--tab-active-bg      /* selected tab in the floating pill */
--tab-active-fg      /* selected tab text */
--accent             /* monochrome: #e8e8e8 dark / #171717 light */
--accent-fg          /* text on --accent: #0a0a0a / #ffffff */
```

Category colors, day colors, and trip emoji stay outside the design token system — they're per-trip user data, not part of the shell.
