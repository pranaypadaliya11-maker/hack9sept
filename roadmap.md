# TalentTrack — Project Roadmap

This roadmap tracks how we're building **TalentTrack** (AI sports talent assessment web app) from scratch as a team. Update the checkboxes as work lands on `main` so anyone opening this file can see exactly what's done, what's in progress, and what's next — no separate status meeting required.

> **How to use this file**: when you finish a task, check it off in the same PR that ships the work, and link the PR/issue number next to it. Keep it in the repo root so it renders on the GitHub homepage.

---

## 0. Snapshot

| | |
|---|---|
| **Stack** | Node.js (built-in `node:sqlite`) backend, vanilla JS/HTML frontend, in-browser pose model (MoveNet via `human` library) |
| **Status** | 🟡 Phase 1 — Setup |
| **Target demo** | _fill in your deadline here_ |
| **Team size** | _fill in_ |

---

## 1. GitHub Setup & Team Workflow

Before writing feature code, get the collaboration scaffolding in place — this is what makes "showing what we've done" possible.

- [ ] Create the repo (`talenttrack-app`), add all teammates as collaborators
- [ ] Add `.gitignore` (node_modules, `talenttrack.db`, `.env`)
- [ ] Protect `main`: require PRs + at least 1 review before merging
- [ ] Create a GitHub Project board with columns: `Backlog → In Progress → In Review → Done`
- [ ] Turn every task in Sections 2–9 below into a GitHub Issue, assigned to an owner
- [ ] Agree on branch naming (`feature/<name>`, `fix/<name>`) and commit style (e.g. Conventional Commits: `feat:`, `fix:`, `docs:`)
- [ ] Set up a `CONTRIBUTING.md` with the branch/PR rules so new contributors don't have to ask
- [ ] Pick a weekly sync slot + async update channel (Discord/Slack)

**Definition of done for this phase**: every teammate has pushed at least one commit to a branch and opened one PR, so everyone's Git flow is verified working.

---

## 2. Foundation: Backend & Database

- [ ] Scaffold `server.js` — routing skeleton, no logic yet
- [ ] Design SQLite schema in `db.js` (users, profiles, assessments, achievements, talent-log)
- [ ] Seed script for demo/coach-console sample athletes (clearly labeled "(sample)")
- [ ] Auth: signup/login for **Athlete** and **Coach/Scout** roles
- [ ] Profile endpoints (create/update profile, BMI calc)
- [ ] Basic end-to-end smoke test: signup → login → fetch profile, via real HTTP requests

**Definition of done**: `node server.js` boots, a fresh signup persists to `talenttrack.db`, and data survives a server restart.

---

## 3. Foundation: Frontend Shell

- [ ] `public/index.html` skeleton — auth screens, dashboard shell, nav between tabs
- [ ] Wire frontend auth forms to backend endpoints
- [ ] Establish the visual identity early (see Section 8) so every feature built after this reuses the same components instead of re-styling later
- [ ] Confirm camera permission flow works on `localhost` (note: camera requires `localhost` or HTTPS — browser rule, not ours)

**Definition of done**: a teammate can clone the repo, run one command, sign up, and see the dashboard shell in a browser.

---

## 4. Core Feature: AI Pose Assessment

The heart of the product — build and verify one exercise fully before copying the pattern to the rest.

- [ ] Integrate the `human` library pose model in-browser (MoveNet)
- [ ] **Squat** — knee angle depth, knee-valgus check, torso lean, tempo (build this first as the reference pattern)
- [ ] **Push-up** — elbow bend depth, hip-sag/body-line straightness, tempo
- [ ] **Lunge** — front-knee depth, knee-over-ankle tracking, torso lean
- [ ] **Jumping Jack** — arm range overhead, leg spread, cadence
- [ ] **Plank** — continuous body-line straightness over a timed hold (not rep-based)
- [ ] **Vertical Jump** — hip-displacement jump-height estimate (label clearly as an estimate, not lab-calibrated)
- [ ] `finishSet()` scoring branch for each exercise above
- [ ] Fallback: labeled "Demo mode · sample data" animation if the pose model fails to load
- [ ] Node-based test harness: run each exercise's rep/scoring state machine against synthetic pose sequences (no browser needed)

**Definition of done**: all 6 exercises count reps/score correctly against synthetic test data, and manually in-browser with a webcam.

---

## 5. Core Feature: Knowledge Hub & Ask Bar

- [ ] `content/sports.json` — 12 sports with rules, fitness demands, common mistakes, tips
- [ ] `content/exercises.json` — 21 exercises tagged by category (Calisthenics, Bulking, Athletic)
- [ ] Filter UI by category in the Exercise Library
- [ ] Keyword-search fallback for the "Ask about a sport/exercise" bar (works offline, no API key)
- [ ] Optional: wire `ANTHROPIC_API_KEY` path for real conversational answers, with graceful fallback to keyword search on any failure
- [ ] UI clearly labels which mode answered (`Answered by AI` vs `From the knowledge hub`)

**Definition of done**: Ask bar returns a relevant result with zero external calls; if a key is set, it upgrades transparently.

---

## 6. Gamification: Daily Challenges

- [ ] `CHALLENGE_ROTATION` — daily rotating target exercise + rep goal
- [ ] Coin logic: 3 per correct-form rep, 1 per rep that wasn't quite right
- [ ] Diamond logic: only if full target hit **and** every counted rep was to standard
- [ ] XP/Level system: 100 XP per level + level-up animation
- [ ] Server-side guard: one challenge completion recorded per day per athlete (no farming via re-submits)

**Definition of done**: completing a challenge twice in one day only awards rewards once, verified with a scripted test.

---

## 7. Feature: Track Your Talent (Self-Reported)

- [ ] `talent-football` form (40m sprint, position, juggling count)
- [ ] `talent-athletics` form (BMI from profile, high jump, long jump, 200m sprint, 1500m run)
- [ ] In-browser stopwatch helper for timed events
- [ ] `saveTalent()` persistence + display on profile

**Definition of done**: a submitted talent log persists and appears back on the athlete's profile after refresh.

---

## 8. Feature: Recommendations & Coach Console

- [ ] `computeAttributesFromAssessments()` — map assessment data into athlete attributes
- [ ] Rule-based, explainable sports recommendation % (document the rules in `ARCHITECTURE.md`)
- [ ] Coach/Scout read-only console, filterable by sport
- [ ] Athlete opt-in toggle (Profile page) to appear in the coach console
- [ ] Verify: two browser sessions (athlete + coach) show the opted-in athlete alongside sample data

**Definition of done**: opting in as an athlete in one tab makes that profile visible in the coach console in another tab/session.

---

## 9. Design Pass

- [ ] Camera-viewfinder hero visual with looping line-art skeleton
- [ ] Two-tier panel system: sharp "readout" panels (scores/metrics) vs. quiet rounded panels (regular content)
- [ ] Dark graphite theme + tracking-grid texture
- [ ] Consistent accent-color mapping (teal = pose overlay, amber = scores/timing, coral = mistakes)
- [ ] Pass over mobile/responsive layout (README notes on-screen framing guidance is a known gap — decide if it's in scope)

**Definition of done**: every screen uses the shared panel/color system — no one-off styling left over from early scaffolding.

---

## 10. Testing & Hardening

- [ ] Backend: every API route exercised end-to-end with real HTTP requests
- [ ] Frontend logic: rep-counting/scoring state machines tested in Node against synthetic pose sequences
- [ ] Static checks: JS syntax validation + DOM-ID cross-check (script references vs. actual HTML elements)
- [ ] Manual pass: real webcam run-through of all 6 assessments (this can't be automated — assign a human)
- [ ] Cross-browser check (Chrome/Edge primary, per README)

**Definition of done**: CI (or a documented manual checklist) passes before every merge to `main`.

---

## 11. Demo & Wrap-Up

- [ ] Update `README.md` "what's real vs. estimated" table to reflect final state
- [ ] Record a short demo video / prepare live demo script
- [ ] Document known limitations (no password reset, no HTTPS termination, experimental `node:sqlite` warning is expected)
- [ ] Tag a release (`v1.0`) once demo-ready
- [ ] Retro: what worked in our GitHub workflow, what to change next time

---

## Contribution Guidelines (quick reference)

1. Pick an unassigned issue from the Project board, assign yourself.
2. Branch off `main`: `git checkout -b feature/short-name`.
3. Commit small, working increments (`feat: add squat depth check`).
4. Open a PR early (draft is fine) so others can see progress before it's "done."
5. Check off the matching box in this `ROADMAP.md` in the same PR.
6. Get one review, resolve comments, merge.
7. Delete the branch after merge.

---

## Progress Log

Add a line here each time a phase completes — this becomes your changelog for standups and the final writeup.

| Date | Phase completed | Notes |
|---|---|---|
| | | |
