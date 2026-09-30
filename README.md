# Study Cards

A distraction-free, retro-styled flashcard app for exam prep. Spaced repetition
(SM-2, the same family of algorithm Anki uses), a 2-minute timer per question,
and nothing else competing for your attention.

## Folder structure

```
study-cards/
├── index.html              ← the page
├── css/
│   └── style.css           ← all styling
├── js/
│   ├── scheduler.js        ← the spacing algorithm (pure, unit-tested)
│   └── app.js               ← UI, timer, storage, session loop
├── data/
│   └── gate-me-2026-deck.txt  ← sample deck, ready to import
├── scripts/
│   ├── test_scheduler.js   ← unit tests for the scheduler
│   ├── validate_deck.py    ← deck file linter (runs in CI)
│   └── smoke_test.sh       ← docker build + HTTP smoke test
└── README.md
```

This is a fully static site — no build step, no server, no dependencies
beyond a font loaded from Google Fonts at runtime. Any static host works.

## Running it locally

Just open `index.html` in a browser. For import-from-file to behave
consistently across browsers, it's a little more reliable to serve it over
a local server rather than opening the raw file:

```bash
cd study-cards
python3 -m http.server 8000
# then visit http://localhost:8000
```

## Deploying it

Pick any static host — here are the three easiest:

### Netlify (drag and drop, no account setup needed)
1. Go to https://app.netlify.com/drop
2. Drag the whole `study-cards` folder onto the page
3. You get a live URL immediately; add a custom domain later if you want

### Vercel
1. `npm i -g vercel` (needs Node.js installed)
2. `cd study-cards && vercel --prod`
3. Follow the prompts

### GitHub Pages
1. Push this folder to a GitHub repo
2. Repo Settings → Pages → Deploy from branch → select `main` and `/ (root)`
3. Your site is live at `https://<username>.github.io/<repo>/`

## How data is stored

Cards and progress are saved in the browser's `localStorage`, scoped to
whatever domain you deploy this on. That means:
- Data persists across visits on the same device/browser
- It does **not** sync across devices — this is a single-user, single-browser
  app by design (keeps it simple and private)
- Clearing browser data/cache will wipe the deck, so use **Export Backup** in
  Manage Cards (it writes a JSON file with your deck *and* your progress) before
  clearing site data or switching devices

The stored payload carries a `version` field. Cards written by older builds are
migrated on load: a card that only had `ef/reps/interval/due` is given a
learning state that matches where it was in the ladder. If a stored deck is ever
unreadable, the raw string is kept under a `studycards.deck.corrupt.<timestamp>`
key before the app starts from an empty deck.

## Adding your own cards

Two ways, both inside the app under **Manage Cards**:
1. **One at a time** — type a question and answer, hit Add Card
2. **Bulk** — paste or upload text in this format:

```
Q: Your question here
A: The answer here
---
Q: Next question
A: Next answer
```

Pairs can be separated by `---` or just a blank line, and LF or CRLF line
endings both work. Duplicate questions are skipped (case- and
whitespace-insensitive), so re-importing a file never resets a card you have
already reviewed. **Load Sample Deck** imports the bundled GATE deck in one
click, and **Clear Deck** wipes everything after a confirmation.

## The scheduling algorithm

`js/scheduler.js` holds the scheduler as pure functions — no DOM, no storage —
so the same file runs in the browser and in Node's unit tests. It is a small
SM-2 variant following Anki's stock defaults.

**New cards** walk a learning ladder instead of jumping straight to a day:

| Rating | Effect on a new/learning card |
| --- | --- |
| Again | back to the 1-minute step |
| Hard  | repeat the current step |
| Good  | advance a step (1m → 10m); from the last step, graduate to 1 day |
| Easy  | skip the ladder and graduate straight to 4 days |

**Review cards** grow by the ease factor (EF, starts at 2.5):

| Rating | New interval | Ease |
| --- | --- | --- |
| Hard | `max(interval + 1, interval × 1.2)` | −0.15 |
| Good | `max(interval + 1, interval × EF)` | unchanged |
| Easy | `max(interval + 2, interval × EF × 1.3)` | +0.15 |

EF is clamped to [1.3, 3.5] and no interval exceeds 36500 days. Those `+1` /
`+2` floors matter: a bare `round(interval × EF)` can round back to the
interval it started from (1 day at EF 1.3), which is how a card gets stuck on a
1-day loop forever while its ease drains to the floor.

**Lapses** (an `Again` on a review card) drop the card onto a 10-minute
relearning step, cost 0.2 EF *once*, and then restart it at
`LAPSE_NEW_INTERVAL_FACTOR` of the interval it had — 0% by default, i.e. back to
1 day, which is Anki's default "new interval".

**Study days, not timestamps.** Any interval of a day or more is aligned to a
04:00 local rollover, so a card answered at 23:55 is due at 04:00 on the due
date rather than 23:55 that night, and a 02:00 session still counts as the
previous day. Learning steps keep minute precision.

**Sessions.** A session shows due learning cards first (oldest step first), then
due reviews, then at most 20 new cards per day — the rest are held back and
reported on the home screen. A card still on a learning step is put back into
the *same* session's queue (up to 4 times) instead of waiting for tomorrow,
which is what makes the 1m/10m steps actually happen.

The four rating buttons preview the interval they will produce, with the exact
due date/time in their tooltip.

## Tests

```bash
node scripts/test_scheduler.js                  # 41 unit tests, no dependencies
python3 scripts/validate_deck.py data/*.txt      # deck file linter
node --check js/app.js && node --check js/scheduler.js
```

`make test` / `make lint` wrap these locally, and both the GitHub Actions
workflow and the `Jenkinsfile` run them before building the image.

## Customizing

- **Colours** live as CSS variables at the top of `css/style.css`
  (`--cream`, `--rust`, `--forest`, `--ink`)
- **Scheduler knobs** all sit in the `CFG` object at the top of
  `js/scheduler.js`: the learning steps (`NEW_STEPS_MIN`, `LAPSE_STEPS_MIN`),
  the graduating and easy intervals, the hard/easy multipliers, the ease floor
  and ceiling, the interval cap, the day rollover, `NEW_PER_DAY` and
  `MAX_INTRADAY_REPS`. Re-run `node scripts/test_scheduler.js` after changing
  them — the tests encode the behaviour that must not regress.
- **Timer length** — `TIMER_SECONDS` in `js/app.js` (in seconds)
- **Fonts** are loaded via the Google Fonts link in `index.html`
  (Special Elite for headers, IBM Plex Serif for body, IBM Plex Mono for
  data/timer)
