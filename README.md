# Machine Data Tracker

Shift incharges photograph checkweigher displays (Ishida or Yamato) → the phone reads the
numbers itself, on-device, with zero internet needed → once signal returns, Groq (free) quietly
double-checks the same photo and flags anything it disagrees with → management downloads Excel
(photo thumbnail in every row) or PDF (photo + data per reading) anytime.

## What's included

- `schema.sql` — database structure (users, machines, readings)
- `src/index.js` — the backend (Cloudflare Worker): login, Groq cloud verification, Excel
  export (photo embedded per row), PDF export (photo + data per reading), admin API
- `public/index.html` — the app shift incharges use on their phone — on-device OCR
  (Tesseract.js) + offline queue + background cloud cross-check
- `public/sw.js` — service worker that caches the app and the OCR engine so it keeps working
  with zero signal after the first successful load
- `public/dashboard.html` — the report management opens on a laptop
- `public/admin.html` — add/deactivate machines and users without touching a terminal
- `wrangler.toml` — Cloudflare configuration

## How the AI side works (read this first)

Photo reading goes through a chain of readers, each one a fallback for the last:

1. **Groq (cloud AI)** — the primary reader, tried first whenever the phone has signal. A real
   vision model that understands the screen layout, not just raw text. Free tier, no credit card.
2. **Cloudflare Workers AI (cloud AI)** — tried automatically if Groq is rate-limited or fails.
   This runs on the same Cloudflare account you're already deployed on — no separate signup, no
   separate API key, just the `[ai]` binding in `wrangler.toml`. A second, independent free
   budget, so Groq's limits don't block you.
3. **Gemini (cloud AI)** — tried if both of the above fail. A third independent free tier.
4. **On-device OCR (Tesseract.js)** — the true last resort, used only if there's no internet
   connection at all, or all three cloud providers failed. Runs right in the phone's browser
   with zero internet, using hand-written rules to map labels to fields. Meaningfully less
   accurate than any of the cloud options — a reading that fell back to this is flagged "Local
   only" on the dashboard and gets automatically re-checked by the cloud chain the next time
   there's signal (or via "Verify Pending").

Each cloud provider is optional — if you only set up Groq, that's all that runs (with on-device
OCR as its offline fallback, same as before). Adding Workers AI and Gemini just gives you more
resilience for free. Nothing is ever blocked waiting on any of this, and every reading — cloud
or local — goes through the incharge's review screen before saving.

## One-time setup

**1. Install dependencies**
```
npm install
```

**2. Create the database**
```
npx wrangler d1 create machine-data-db
```
Copy the `database_id` it prints into `wrangler.toml` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`).

**3. Create the photo storage bucket**
```
npx wrangler r2 bucket create machine-data-photos
```

**4. Load the database structure**
```
npm run db:init
```
This seeds one admin login (**Sidhartha / PIN 1234**) and a placeholder list of 21 machines
(15 Ishida, 6 Yamato). Use `/admin.html` after deploying to set up your real machines and users
(see step 7) — no need to hand-edit `schema.sql`.

**5. Set up your AI providers and secrets**

Groq (required — this is the primary reader):
```
npx wrangler secret put GROQ_API_KEY
```
(get a free key, no credit card, at console.groq.com)

Cloudflare Workers AI (optional but recommended — zero setup, same account):
nothing to do here except make sure `[ai]` / `binding = "AI"` is in `wrangler.toml` (already
included) — it activates automatically once you deploy, no key needed.

Gemini (optional, third fallback):
```
npx wrangler secret put GEMINI_API_KEY
```
(get a free key at aistudio.google.com/apikey)

Session signing (required):
```
npx wrangler secret put SESSION_SECRET
```
(any long random string, e.g. generate one with `openssl rand -hex 32`)


**6. Deploy**
```
npm run deploy
```
Wrangler will print your live URL, e.g. `https://machine-data-tracker.yourname.workers.dev`

**7. Set up your real machines and shift incharges**

Open `<your-url>/admin.html`, log in as the seeded admin (Sidhartha / 1234), then:
- Add each of your 21 machines with its real number, line, and brand (Ishida/Yamato)
- Deactivate the placeholder machines you don't need
- Add your real shift incharges with their own PINs
- Change the admin PIN (edit the user, set a new PIN)

## Daily use

- **Shift incharges**: open the main URL on their phone, log in, pick shift + machine (photo
  count adjusts automatically), take photo(s), the app reads the numbers on-device in a couple
  of seconds, review/edit, submit. If there's no signal, "Saved on Phone" appears and it uploads
  automatically once back in range — nothing is lost either way.
- **Management**: open `<your-url>/dashboard.html`. The **Verified** column shows whether Groq
  has cross-checked each reading yet ("Local only" = not yet checked, usually because it was
  captured offline; "Verified" = matches; "Mismatch" = worth a glance). Click **Verify Pending**
  to manually trigger a batch cloud re-check of anything not yet verified. **Download Excel**
  gives a summary sheet with a photo thumbnail in every row plus per-brand detail sheets;
  **Download PDF** gives one clean block per reading — photo next to the data — good for
  printing or emailing.
- **Admin**: `<your-url>/admin.html` — add or deactivate a machine or shift incharge anytime,
  no terminal needed.

## Cost

Cloudflare Workers/D1/R2 free tier comfortably covers 21 machines × 3 shifts/day. Groq's free
tier (no credit card) covers roughly 1,000 requests/day — your actual load (~63 photos/day, plus
the same again for cloud verification, so ~126/day) sits comfortably inside that. If you ever
outgrow it, Groq's paid tier is inexpensive; there's no other cost in this system.

## Notes on accuracy

Two different accuracy profiles to keep in mind:
- **On-device OCR** is good but not as sharp as a vision model — screen glare, an odd camera
  angle, or a firmware update that changes label wording can throw off the regex matching in
  `OCR_PATTERNS` inside `public/index.html`. If you notice a specific field consistently
  misreading, that's the place to adjust the pattern.
- **Groq cloud check** is more reliable and is what ultimately flags problems for you — treat a
  "Mismatch" on the dashboard as a cue to open the photo and check by eye, not as an error in
  itself (either reader could be the one that's wrong).

Every submission that the incharge manually corrected is also flagged (`was_corrected` /
"Manually Corrected" KPI), independent of the cloud check — together these two signals tell you
where the process needs attention (a specific machine's lighting, a specific screen layout,
etc.).

If Groq changes its vision model lineup again (it has a few times this year), update
`GROQ_VISION_MODEL` as a secret rather than editing code — check
https://console.groq.com/docs/vision for the current model name.
