# CLAUDE.md

Personal site for Aji Setyoko — a Hugo static site with a hand-built terminal-styled
theme, deployed to GitHub Pages at https://ajisetyoko.github.io/.

## Commands

```bash
hugo server -D          # local dev at http://localhost:1313, includes drafts
hugo                    # build into ./public (gitignored)
hugo --minify           # what CI runs
hugo new posts/some-title.md   # scaffold from archetypes/default.md (draft = true)
```

There is no npm/package.json, no test suite, and no linter. Verifying a change means
running `hugo server` and looking at it, or `hugo --minify` to confirm the build is clean.

## Deployment

`.github/workflows/hugo.yml` builds and deploys on every push to `master`. There is no
PR preview build, so a broken template only surfaces after merge — run `hugo --minify`
locally before pushing.

CI pins `HUGO_VERSION: 0.133.0` (extended). Local installs are usually newer, so a
feature that works locally can fail in CI. Bump the workflow env var rather than relying
on whatever is installed locally.

## Layout of the repo

```
hugo.toml            site config: params, menu, markup, outputs
content/             all pages (Markdown, YAML front matter)
  _index.md          home page intro text
  about.md           about page
  contact.md         uses layout: "contact"
  posts/             blog
  projects/          project write-ups
  publications/      academic papers
layouts/             the theme — hand-written, no external theme module
  index.html         home page
  index.json.json    generates /index.json, consumed by the JS terminal
  _default/          baseof, list, single, contact
  partials/          header, footer, cli.html (vim bar), cli-default.html (bash bar)
static/
  css/terminal.css   the entire stylesheet, 300 lines, no preprocessor
  js/terminal.js     the interactive command bar
  files/             PDFs (papers)
  images/, favicon.svg
```

## The theme

Hand-built, deliberately. There is **no `theme` setting in hugo.toml** — an empty
`theme = ''` previously broke the CI build (commit `6cd7f21`). Don't add one back.

Everything renders inside a fake terminal window (`.term` → `.term-bar` + `.term-body`).
Templates lead sections with a fake shell prompt line, e.g. `$ ls posts/` on list pages
and `$ cat about.md` on single pages. New templates should follow that idiom:

```html
<div class="prompt-line"><span class="dollar">$</span> cat {{ .File.ContentBaseName }}.md</div>
<article class="output page">...</article>
```

`single.html` calls `.File.ContentBaseName`, so every single page must be backed by a
real file — a page generated without one will fail the build.

CSS and JS are linked with `?v={{ now.Unix }}` cache-busting, which means every build
produces a new URL. That's intentional for a site this small; don't "fix" it into a
static filename without a replacement fingerprinting scheme.

## The interactive command bar (static/js/terminal.js)

The site has two input modes, toggled in the header and persisted in `localStorage`
under `termMode`; `baseof.html` applies it to `document.documentElement.dataset.mode`
before first paint to avoid a flash.

- **default (bash)** — `ls`, `cd`, `cat`, `pwd`, `tree`, `clear`, `help`, Tab completion
- **vim** — `:e <page>`, `:ls [section]`, `:q`, `:h`, plus `j`/`k`/`gg`/`G` scrolling

Both modes resolve targets from two sources: the nav links in the DOM
(`.prompt-nav a`) and `/index.json`, produced by `layouts/index.json.json` via the
`home = ["HTML", "RSS", "JSON"]` output config. **Adding a nav entry means adding a
`[[menu.main]]` block in hugo.toml** — the JS reads nav from the rendered header, so a
hardcoded link in a template won't be navigable by command. Never remove the JSON output
without rewriting terminal.js; the command bar goes inert with no error.

The script is plain ES5-style IIFE JavaScript with no build step, no bundler, and no
dependencies. Keep it that way — edit `static/js/terminal.js` directly.

## Content conventions

Front matter is YAML (`---`), even though `archetypes/default.md` scaffolds TOML (`+++`).
Match the existing files, not the archetype.

```yaml
---
title: "Sentence case, quoted"
date: 2026-04-06        # posts only; drives sort order and the displayed date
tags: ["sre", "kubernetes"]   # posts only
summary: "One or two sentences, shown in list views."
---
```

- **Don't start the body with an `<h1>`/`# Title`** — `single.html` already renders
  `<h1>{{ .Title }}</h1>`. A heading in the body duplicates it.
- `summary` is what renders under each entry in list views; skip it and the listing
  looks bare.
- Posts sort by date descending; projects and publications sort by title.
- Section index pages (`content/*/_index.md`) hold only a lowercase `title`. Any body
  content renders as a `.section-intro` above the listing.
- Site titles and nav labels are lowercase throughout — it's a terminal aesthetic, not
  an oversight.
- PDFs go in `static/files/` and are linked as `/files/name.pdf`.

Some posts are short teasers that link out to a full article elsewhere (the Verihubs
engineering blog); others are complete posts hosted here. Both patterns are fine.

## Known rough edges

- **The contact form does not deliver anywhere.** `layouts/_default/contact.html` posts
  to `https://formspree.io/f/PLACEHOLDER`. It needs a real Formspree form ID.
- `hugo.toml` sets `paginate = 10`, but nothing paginates: `_default/list.html` ranges
  over `.Pages` directly and never touches `.Paginator`. The key is also the pre-0.128
  spelling of `[pagination] pagerSize`. It's dead config either way.
- `hugo.toml` sets `languageCode`, deprecated in favour of `locale` in Hugo 0.158+.
  Recent local Hugo warns on every build; the pinned CI version (0.133.0) does not, so
  don't change it without checking 0.133.0 still accepts `locale`.
