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
│   └── app.js               ← all app logic (scheduler, timer, storage)
├── data/
│   └── gate-me-2026-deck.txt  ← sample deck, ready to import
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
- Clearing browser data/cache will wipe the deck, so consider keeping a copy
  of `data/gate-me-2026-deck.txt` (or export your own) somewhere safe

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

Pairs can be separated by `---` or just a blank line.

## The scheduling algorithm

A simplified SM-2 (the algorithm behind Anki):
- Each card tracks an ease factor (starts at 2.5), a repetition count, and
  an interval in days
- Grading **Again** resets the repetition count and schedules the card back
  in 10 minutes
- Grading **Hard / Good / Easy** grows the interval, using the ease factor
  as a multiplier — Easy grows fastest, Hard slowest
- The four rating buttons preview the interval they'll produce before you
  tap them

## Customizing

- **Colors** live as CSS variables at the top of `css/style.css`
  (`--cream`, `--rust`, `--forest`, `--ink`)
- **Timer length** — change `session.timeLeft = 120` in `js/app.js` (two
  places: the reset in `loadCard()` and the initial value in the `session`
  object) to adjust the per-question time limit, in seconds
- **Fonts** are loaded via the Google Fonts link in `index.html`
  (Special Elite for headers, IBM Plex Serif for body, IBM Plex Mono for
  data/timer)
