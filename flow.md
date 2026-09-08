# Fettle — Flow

How a request moves through the app, end to end: pages, clicks, API calls, and what happens in the database.

---

## 1. Page flow (frontend views)

`index.html` is a single-page app. All screens are `<section class="view" id="view-*">` blocks toggled by one JS function, `showView(id)` — there's no router/URL change, just show/hide.

```
view-auth ──► view-onboarding ──► view-dashboard ──┬─► view-assess ──► view-results ──► view-recommendations
 (signup/                (first-time    (home base)  │                                        │
  login)                  profile only)               │                                        ▼
                                                        ├─► view-progress                view-dashboard
                                                        ├─► view-library  (Sports / Exercise tabs, Ask bar)
                                                        ├─► view-daily    (today's challenge)
                                                        ├─► view-talent   (self-reported combine log)
                                                        ├─► view-challenges (badges)
                                                        └─► view-coach    (coach role only)
```

- The **top nav** (`#nav`, built by JS after login) links to whichever of these a given role can see.
- **Athlete** role gets: Dashboard, Assessment, Recommendations, Progress, Library, Daily Challenge, Talent Tracker, Badges.
- **Coach** role gets: Athlete discovery (`view-coach`) as its "home," reads only — no assessment/profile flow.
- `showView()` also lazily triggers the right data-refresh call (e.g. entering `view-dashboard` re-fetches `/api/me`; entering `view-coach` re-fetches `/api/coach/athletes`).

---

## 2. First-run flow (new athlete)

```
1. Landing (view-landing) → "Get started" → view-auth
2. Sign up: POST /api/auth/signup {email, password, role}
     └─ db.js: INSERT users, auto-creates an empty athletes row (getOrCreateAthlete)
     └─ server issues a session token → stored client-side, sent as Authorization: Bearer <token>
3. Onboarding (view-onboarding): name, age, gender, height, weight, sport interest, experience
     └─ PUT /api/athlete → recalculates BMI server-side → UPDATE athletes
4. Redirect to view-dashboard (empty state: "no assessments yet")
```

Login (`POST /api/auth/login`) skips straight to onboarding-if-empty or dashboard, verifying the password with `scrypt` against the stored hash+salt and minting a new session token the same way.

---

## 3. Core loop: AI assessment → score → recommendation

This is the product's main loop, and it repeats every session.

```
view-dashboard
   │  click "Run AI assessment"
   ▼
view-assess
   │  pick exercise tab (squat / push-up / lunge / vertical jump / plank / jumping jack)
   │  click "Enable camera" → getUserMedia → pose model runs client-side, 100% in-browser
   │  live skeleton overlay + rep counter + real-time feedback ("knees caving", etc.)
   │  click "Finish set & see score"
   ▼
finishSet() (client JS)
   │  runs the rule engine locally on the collected joint-angle sequence
   │  (per ARCHITECTURE.md §7–9: smoothing → angles → rep-phase state machine →
   │   weighted per-check pass rate → form/stability/rom/tempo/consistency/overall)
   │  POST /api/assessments { exercise, mode, totalReps, correctReps,
   │                          form, stability, rom, tempo, consistency, overall,
   │                          extra, mistakes }
   ▼
server.js: route('POST', '/api/assessments')
   │  INSERT INTO assessments  (raw video is never sent — only computed scores/landmarks)
   │  recomputeAchievements(athleteId, allRows) → may INSERT achievements, returns newBadges
   │  tryCompleteDailyChallenge(...) → may update athletes.coins/diamonds/xp/level
   │  → 201 { id, newBadges, challengeResult }
   ▼
view-results
   │  shows score breakdown + rep-by-rep feedback (from the response the client already has)
   │  click "See sport recommendations"
   ▼
GET /api/recommendations
   │  server: pulls all assessments for the athlete
   │  computeAttributesFromAssessments(rows) → strength/speed/agility/endurance/
   │      coordination/explosiveness, derived from specific exercise scores
   │      (e.g. squat.form+rom → strength; jump.overall → explosiveness)
   │  getRecommendations(attrs, count) → weighted match against SPORTS_DB,
   │      each sport's % plus a "why" (top 2 contributing attributes)
   ▼
view-recommendations — ranked list + "recommendation, not a guarantee" disclaimer
```

`view-progress` is a side branch off the same data: `GET /api/assessments` → client plots `overall` per session as a trend line (SVG), no separate scoring on that call.

---

## 4. Daily challenge / gamification loop

```
view-dashboard → click level chip ("Today's challenge →")
   ▼
GET /api/challenge/today
   │  getOrCreateDailyChallenge(athleteId): one row per athlete per calendar day,
   │  exercise/target picked deterministically from CHALLENGE_ROTATION by day index
   │  (so every athlete gets the same exercise on a given day)
   ▼
view-daily — shows target (e.g. "20 squats") + current wallet (coins/diamonds/xp/level)
   │  user goes to view-assess, does that exercise, finishes the set
   ▼
POST /api/assessments  (same endpoint as the core loop, above)
   │  tryCompleteDailyChallenge() checks: does this submission match today's
   │  still-incomplete challenge?
   │    - coins = 3 × correct reps + 1 × imperfect reps  (attempting is never worthless)
   │    - diamonds = 3, only if target met AND every counted rep was correct
   │    - xp = coins + diamonds×10 → level = floor(xp / 100) + 1
   │  UPDATE athletes SET coins/diamonds/xp/level; UPDATE daily_challenges completed=1
   ▼
challengeResult returned inline in the /api/assessments response
   │  client shows coin/diamond animation + level-up modal if newLevel > oldLevel
```

Only one challenge completion is recorded per athlete per day (`UNIQUE(athlete_id, challenge_date)` + the `completed` flag) — resubmitting the same exercise doesn't farm extra rewards.

Badges (`view-challenges`) are recomputed on every assessment submit (`recomputeAchievements`), checked against simple rules over the athlete's full assessment history (first assessment, 50 reps logged, 3 sessions, a 90+ form score, 3 different exercises tried).

---

## 5. Knowledge hub / Ask flow

```
view-library
   │  tabs: Sports | Exercise library — both just render sports.json / exercises.json
   │  via GET /api/sports and GET /api/exercises (static content, no auth needed)
   │
   │  "Ask about a sport/exercise" bar → POST /api/ask { question }
   ▼
server.js: route('POST', '/api/ask')
   │  try: callAnthropic(question)
   │        - only if ANTHROPIC_API_KEY is set server-side
   │        - sends the whole sports.json + exercises.json as context + the question
   │        - Claude (claude-sonnet-4-6) answers in 3–6 sentences, told not to give
   │          medical advice
   │        → { answer, source: "ai" }
   │  catch (no key / bad response / timeout):
   │        keywordAnswer(question) — scores every sport/exercise entry by keyword
   │        overlap with the question, returns the top 2
   │        → { answer, source: "knowledge-base" }
   │  (never a fabricated "AI" answer — the UI always labels which mode answered)
```

---

## 6. Fettle (self-reported combine log)

Separate from the camera pipeline — for measurements a single webcam can't reliably take (sprint splits, jump distance).

```
view-talent → pick sport tab (Football / Athletics)
   │  fill in manual fields (uses in-browser stopwatch for timed events)
   │  save
   ▼
PUT /api/talent { sport, data }
   │  upsert into talent_records (UNIQUE athlete_id+sport) — one row per sport, keyed off
   │  the athlete, storing the whole field-set as JSON
   ▼
GET /api/talent  — re-fetched on view load to populate the form with prior entries
```

This data does **not** feed the AI recommendation engine (`computeAttributesFromAssessments` only reads camera-based `assessments`, not `talent_records`).

---

## 7. Coach flow

```
Coach signs up with role="coach" → skips onboarding/assessment views entirely
   ▼
view-coach (their home view)
   │  optional sport filter dropdown
   ▼
GET /api/coach/athletes?sport=...
   │  requires user.role === 'coach' (403 otherwise)
   │  SELECT * FROM athletes WHERE coach_opt_in = 1   (consent-gated — an athlete only
   │  appears here after opting in from their own Profile screen: PUT /api/athlete/consent)
   │  for each: recompute attributes from their assessments, average `overall`
   │  filter out anyone with zero assessments (nothing to show yet)
   │  sort by overall score, descending
   ▼
Table: Athlete | Location | Sport | Speed | Strength | Agility | Overall
   (rows seeded by db.js's seedDemoData() are labeled "(sample)" in the name —
    always shown alongside real opted-in athletes so the console isn't empty
    on a fresh install, per the product's "be honest about what's real" rule)
```

---

## 8. Cross-cutting: auth & request flow

Every `/api/*` request (except signup/login/logout, ask, exercises, sports) goes through the same funnel in `server.js`:

```
request → CORS/OPTIONS short-circuit
        → static-file passthrough if not under /api/
        → route match (method + path regex)
        → if path starts with a protected prefix (/api/me, /api/athlete,
          /api/assessments, /api/recommendations, /api/achievements,
          /api/coach, /api/challenge, /api/talent):
              authenticate(req) → Bearer token → sessions table → users table
              401 if missing/invalid
        → parse JSON body for POST/PUT/DELETE
        → handler(req, res, params, body, user, query)
        → JSON response, or 500 on unhandled error
```

Data storage is a single SQLite file (`talenttrack.db`, via Node's built-in `node:sqlite`) — no separate service, migrations run automatically at startup via `tryAddColumn` for older DB files.

---

## 9. Privacy-relevant flow notes

- Pose extraction happens **client-side only**; the server only ever receives computed scores/landmarks, never raw video (matches `ARCHITECTURE.md` §12's on-device-by-default design).
- Coach visibility is opt-in per athlete (`coach_opt_in` flag) and revocable — coaches can only ever query rows where that flag is currently 1.
- `DELETE /api/assessments/:id` lets an athlete remove an individual session outright.
