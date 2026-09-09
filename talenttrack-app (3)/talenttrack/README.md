# TalentTrack — Full-Stack AI Sports Talent Assessment

A real, runnable web app: Node.js backend + SQLite database + a browser-based AI pose model
(no mocked backend, no fake "AI" — the pose detection is genuine client-side ML inference).

## What's real vs. what's a deliberate estimate

| Feature | Status |
|---|---|
| Pose detection (skeleton, joint angles) | **Real** — runs a genuine pose-estimation model (MoveNet, via the `human` library) in your browser |
| Rep counting, form checks (squat/push-up/lunge/jumping jack) | **Real** — computed live from the real joint-angle data using the rule engine in `ARCHITECTURE.md` §7–9 |
| Plank hold scoring | **Real** — continuously measures body-line straightness over time rather than counting reps |
| Vertical jump height | **Estimated** — derived from hip displacement relative to your body height; clearly labeled as a camera-based approximation, not lab-calibrated |
| Ask about a sport/exercise | **Real AI answer if `ANTHROPIC_API_KEY` is set** (see below); otherwise a transparent keyword search over the app's own knowledge base — never a fabricated "AI" answer |
| Daily challenge coins/diamonds/XP/levels | **Real** — persisted server-side, awarded once per day per athlete based on the actual assessment you submit (can't be farmed by re-submitting) |
| Track Your Talent (sprint times, jump distances, etc.) | **Self-reported** — this is a manual combine-style log with an in-browser stopwatch helper, not an automated measurement (horizontal jump distance and sprint splits aren't reliably measurable from a single 2D camera) |
| Accounts, profile, BMI, scores, badges | **Real** — stored in an actual SQLite database file (`talenttrack.db`) that persists across restarts |
| Sports recommendation % | **Real algorithm**, rule-based and explainable (see `ARCHITECTURE.md` §10) — not a guarantee of talent |
| Coach console sample athletes | **Clearly labeled "(sample)"** — seeded once so the console isn't empty on a fresh install; your real profile appears alongside them once you opt in |
| If the browser can't load the pose model | Falls back to a **labeled "Demo mode · sample data"** animated sequence rather than pretending it's live camera output |

## Enabling real AI answers in "Ask about a sport/exercise"

By default, the Ask bar in the Exercise Library searches the app's own knowledge base (`content/sports.json` and `content/exercises.json`) and returns the most relevant entries — no external calls, works offline. To get full conversational AI answers instead, set an environment variable before starting the server:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
node server.js
```

If the key is missing, invalid, or the request fails for any reason, the app automatically falls back to the knowledge-base search rather than showing an error — the response always tells you which mode answered (`Answered by AI` vs `From the TalentTrack knowledge hub`).

## Gamification: Daily Challenges

Every day, the app rotates through a fixed set of exercises (squat, push-up, lunge, jumping jack, plank) and picks that day's target — e.g. "35 jumping jacks." Complete it from the AI Assessment tab:
- **Coins**: 3 per rep performed to standard, 1 per rep that wasn't quite right — so form still matters, but attempting is never worthless.
- **Diamonds**: only awarded if you hit the full target *and* every counted rep was up to standard.
- **XP & Levels**: coins and diamonds both feed an XP total; every 100 XP is a level, with a level-up animation.

Only one challenge completion is recorded per day per athlete — repeating the same exercise won't farm extra rewards.

## Leaderboard: weekly & monthly competition

Athletes can opt in to a public leaderboard that ranks them against each other — separate from, and independent of, coach visibility:

- **Two boards**: "This week" (Monday–Sunday, resets weekly) and "This month" (calendar month, resets monthly), selectable via tabs.
- **Scoring**: ranked by XP earned from completed daily challenges within the period (`coins_earned + diamonds_earned × 10`, summed) — reuses the existing gamification system rather than inventing a second one, so playing the daily challenge *is* competing on the leaderboard.
- **Live updates**: the leaderboard view polls `GET /api/leaderboard` every 15 seconds while open, with ▲/▼ indicators showing rank movement since the last refresh. This is simple HTTP polling rather than WebSockets, matching the project's single-process Node `http` server — no new infrastructure required.
- **Privacy-first by design**, consistent with the rest of the app:
  - Off by default — athletes must explicitly opt in (`PUT /api/athlete/leaderboard`) and choose a short display name.
  - Only the display name, sport, XP and correct-rep count are ever shown — **never** real name, location, or age, even to other athletes.
  - Under-18 athletes must already have parent/guardian contact info on file (the same requirement used for coach visibility) before they can join the leaderboard — enforced server-side, not just hidden in the UI.
  - Turning off coach visibility does **not** affect leaderboard visibility and vice versa — they're independent opt-ins, since "compete with peers" and "be discoverable by a scout" are different consent decisions.
  - Display names are sanitized server-side (HTML-unsafe characters stripped, 24-character cap) before storage.
  - A fresh install seeds sample athletes with ~5 weeks of demo challenge history (clearly labeled "(sample)") so the leaderboard isn't empty before real users compete.

## Track Your Talent

A self-reported "combine" tracker separate from the camera-based AI Assessment, for stats a single webcam can't reliably measure (sprint splits, horizontal jump distance, race times). Includes a simple start/stop stopwatch for timed events. Currently covers Football (40m sprint, preferred position, juggling count) and Athletics (BMI pulled from your profile, high jump, long jump, 200m sprint, 1500m run) — extend `talent-football` / `talent-athletics` in `public/index.html` plus the matching `saveTalent()` call to add more sports.

## Design

The visual identity is built around the product's actual mechanism — motion capture — rather than generic dashboard styling:
- A camera-viewfinder hero visual with a looping line-art skeleton performing a squat, echoing the real pose overlay used during assessment.
- Circular score readouts and sharp-cornered "readout" panels (thin top accent, tabular numerals) for metrics, versus quiet rounded panels for regular content — two deliberate tiers instead of one card style everywhere.
- A dark graphite background with a faint tracking-grid texture and slow-drifting light, evoking a biomechanics lab rather than a generic SaaS dark mode.
- Every accent color maps to something real in the product: teal is the same color as the live pose-overlay lines, amber is used for scores/timing, coral flags mistakes.

## Testing performed on this build

Because this runs in your browser (webcam + WebGL), it can't be fully exercised from a sandboxed shell — but everything that *can* be automatically verified has been:
- **Backend**: every API route exercised end-to-end with real HTTP requests (signup, login, profile, all 6 assessment types, recommendations, achievements, consent, coach console, KB endpoints).
- **Frontend logic**: the rep-counting/scoring state machine for all 6 exercises was extracted and run against synthetic pose sequences in Node (no browser needed) to confirm reps count correctly, scores compute without errors, and `finishSet()` completes cleanly for every exercise — including the edge case of switching exercises mid-rep.
- **Static checks**: JS syntax validation, and a cross-check that every DOM element ID referenced by the script actually exists in the HTML (catches "cracked" pages from a mismatched rename).

What this can't verify: actual camera/webcam behavior, real-world pose accuracy, or how the layout looks on a physical device — please do a quick manual run-through before a live demo.

## Requirements

- **Node.js 22.5+** (uses the built-in `node:sqlite` module — no `npm install`, no external database server, no internet access needed to run the backend)
- A webcam (for live assessment) — camera access requires **either `localhost` or HTTPS** in the browser; that's a browser security rule, not something this app can change.

## Run it

```bash
cd talenttrack-app
node server.js
```

Then open **http://localhost:3000** in your browser (Chrome or Edge recommended for camera + WebGL support).

That's it — one command, no build step, no `npm install`. Data is written to `talenttrack.db` in the project folder and survives restarts.

## Project structure

```
talenttrack-app/
├─ server.js          Backend: routing, auth, scoring/recommendation logic
├─ db.js               SQLite schema + demo-data seeding (node:sqlite, built into Node)
├─ content/
│  ├─ sports.json      Knowledge-hub sports content
│  └─ exercises.json   Knowledge-hub exercise content
├─ public/
│  └─ index.html        Frontend: auth, dashboard, AI assessment (squat/push-up/jump), etc.
└─ talenttrack.db      Created automatically on first run
```

## Accounts

Sign up as either:
- **Athlete** — profile, AI assessments, recommendations, progress, badges.
- **Coach / Scout** — read-only discovery console filtered by sport, showing athletes who opted in plus sample data.

The same server can host both roles — try opening a second browser (or an incognito window) and signing up as a coach while your first tab is an athlete, so you can see your own profile appear in the coach console after opting in on the Profile page.

## Exercise library & AI Assessment

The **Exercise Library** (Sports & Exercise Knowledge Hub) now covers 21 exercises tagged by category — Calisthenics, Bulking, Athletic — plus 12 sports, each with rules, fitness demands, common mistakes, and tips. Filter exercises by category, or use the **Ask about a sport/exercise** bar to search it (see above).

Of those 21, six have real camera-based **AI Assessment**:

1. **Squat** — depth (knee angle), knee-valgus check, torso lean, tempo/consistency.
2. **Push-up** — elbow bend depth, hip-sag/body-line straightness, tempo/consistency.
3. **Lunge** — front-knee depth, front-knee-over-ankle tracking, torso lean.
4. **Vertical Jump** — hip-displacement-based jump-height estimate, landing softness, consistency across jumps.
5. **Plank** — continuous body-line straightness over a timed hold (not rep-based).
6. **Jumping Jack** — arm range overhead, leg spread, cadence consistency.

The other 15 (pull-up, dip, burpee, deadlift, bench press, etc.) are knowledge-base only for now — the library is honest about this, showing "Not yet covered by the AI Assessment tool" rather than implying camera analysis exists where it doesn't.

Adding AI assessment for a new exercise means: (a) add a `processX(kp)` frame handler + rep state machine in `public/index.html` following the same pattern as squat/push-up/lunge, (b) add its scoring branch in `finishSet()`, (c) fill in its `aiChecks` array in `content/exercises.json`, (d) optionally map it into `computeAttributesFromAssessments()` in `server.js` so it feeds the sports recommendation engine, (e) optionally add it to `CHALLENGE_ROTATION` in `server.js` to include it in the daily challenge rotation. No database schema changes needed — `assessments.exercise` is a free-text field.

## Security/privacy fixes applied in this build

A mentor review flagged privacy/security as the differentiator to strengthen. These gaps were found and fixed:

1. **Coach verification was defined in the schema but never enforced.** Any account could sign up with `role: "coach"` and immediately read every opted-in athlete's name and location. Now:
   - Coach signup requires an `organization` name.
   - New coach accounts start **unverified** and can only see labeled sample athletes.
   - `POST /api/admin/verify-coach` (protected by an `ADMIN_KEY`, printed to the console on startup if you don't set one) flips a coach to verified. In a real deployment this would be a manual review queue, not a self-serve toggle.
2. **No minor/guardian consent flow**, despite the product's real use case (grassroots talent discovery, plausibly including under-18 athletes). Now:
   - Athletes under 18 must have a parent/guardian name + contact on file before `coach_opt_in` can be turned on — enforced both in the UI and server-side (`PUT /api/athlete/consent`), so it can't be bypassed by calling the API directly.
   - Coaches never see a minor's exact age — only an age band ("Under 18") — and minors are visibly flagged `(minor)` in the coach console.
3. **Sessions never expired.** Tokens now carry a 30-day `expires_at` and are rejected (and cleaned up) once expired.
4. **No rate limiting on auth endpoints.** `/api/auth/login` and `/api/auth/signup` are now limited to 10 attempts per IP per 10-minute window (in-memory — fine for a hackathon demo, swap for a real limiter/WAF in production).
5. **No way to actually delete your data.** The README claimed deletion support, but only single-assessment deletion existed. `DELETE /api/me` now removes the account and every related row (assessments, achievements, daily challenges, talent records, coach record, sessions).
6. **Weak input validation.** Password minimum raised to 8 characters; age/height/weight are now range-checked server-side instead of trusted as-is.

## Known limitations (being upfront, as the product itself asks you to be)

- Jump-height estimates are **not lab-calibrated** — they scale hip displacement by your reported height, which is a reasonable approximation but not a validated measurement.
- Pose accuracy depends on camera angle, lighting and framing — the UI should eventually add on-screen framing guidance (noted in `ARCHITECTURE.md` roadmap) but isn't built in this version.
- `node:sqlite` is still an experimental Node API (stable behavior, but Node prints an experimental-feature warning on startup — this is expected and harmless).
- No password-reset flow, no HTTPS termination — fine for a hackathon demo/localhost use; add a reverse proxy (e.g. Caddy/Nginx with TLS) before deploying publicly, per `ARCHITECTURE.md` §12.
- Auth rate limiting is in-memory and per-process — resets on restart and doesn't share state across multiple server instances. Fine for a single-process hackathon deployment; use a shared store (Redis) behind a real proxy for production.
- Coach verification is a single shared `ADMIN_KEY`, not a per-admin login — adequate for a demo/judge walkthrough, not for a real moderation team.
