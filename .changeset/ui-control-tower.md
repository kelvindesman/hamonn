---
"@hamonn/shell": minor
---

Redesigned web UI: hand-written CSS (light + dark, no Tailwind CDN), pinned htmx with SRI, a board with state glyphs,
collapsed empty columns, an activity log and the ancestor proof (`main@sha ⊇ lane@sha`) on every landed lane; an
admin-key dialog and an aria-live toast region replace `prompt()`/`alert()`. New `landingPage(projects)` renders the
front page; the Worker serves it at `/`.
