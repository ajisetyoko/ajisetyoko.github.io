---
title: "Rebuilding this site as a terminal"
date: 2026-07-31
tags: ["meta"]
summary: "Retired the 2021 Bootstrap resume theme for a hand-built Hugo terminal UI, ready for actual blog posts."
---

The old version of this site was a 2021 Bootstrap/jQuery resume theme, plus a couple of dead directories of orphaned project write-ups and a PHP contact form that never had a chance of working on GitHub Pages. It did its job, but it wasn't a place I'd actually write in.

This rebuild is [Hugo](https://gohugo.io/) with a hand-built theme instead of an off-the-shelf one — monospace type, a `$`-prompt nav, dark terminal palette. No JavaScript framework, no build step beyond `hugo`, one CSS file.

Going forward this is where I'll write about SRE practice, security, and program management — the stuff I actually work on day to day, rather than the computer-vision research this site used to be about.

```bash
$ hugo new posts/something-worth-writing.md
```
