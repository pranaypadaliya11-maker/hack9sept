# TalentTrack — AI Sports Talent Assessment Platform
### Full System Architecture (Smart India Hackathon)

> "Discover your athletic potential with nothing but a smartphone camera."

---

## 1. Product Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser)                       │
│  Next.js/React SPA  ─  in-browser MediaPipe Pose (WASM/WebGL) │
│  Landing · Profile · Assessment · Results · Recommendations   │
│  Progress · Library · Challenges · Coach Console               │
└───────────────┬─────────────────────────────┬─────────────────┘
                │ REST/JSON (auth'd)           │ raw video only if
                │                               │ server-side re-analysis needed
┌───────────────▼─────────────────┐  ┌─────────▼─────────────────┐
│   App Backend (Node/Next API)   │  │  ML Service (Python/FastAPI)│
│  Auth, Profiles, Scoring rules, │  │  Pose post-processing,      │
│  Recommendation engine, Progress│  │  rep-segmentation, heavier  │
│  Gamification, Coach queries    │  │  models (jump/sprint CV)    │
└───────────────┬─────────────────┘  └─────────┬───────────────────┘
                │                                │
        ┌───────▼────────┐               ┌───────▼────────┐
        │  PostgreSQL     │               │ Object Storage  │
        │  (relational)   │               │ (videos, opt-in)│
        └─────────────────┘               └─────────────────┘
```

Design principle: **pose estimation runs client-side by default** (MediaPipe Pose in WASM). Only landmark coordinates (not raw video) are sent to the backend unless the user opts in to cloud storage of the clip — this is both a privacy and a cost/bandwidth win, and it's what makes the "runs on any smartphone" claim credible.

---

## 2. User Flow

1. **Landing** → "Start Free Assessment"
2. **Sign up / profile** → name, age, gender, height, weight, sport interest, experience
3. **Choose test** → e.g. Squat Form, Vertical Jump, Sprint
4. **Record/upload** → webcam or file, with on-screen framing guide
5. **Live pose overlay** → skeleton + rep counter while recording
6. **Processing** → landmark sequence → angle/rep engine → score
7. **Results** → score breakdown, mistakes, corrective tips, video with overlay
8. **Sports recommendation** → ranked list with rationale
9. **Progress dashboard** → trend lines across sessions
10. **Knowledge hub / challenges** → optional, always available
11. **Coach view** (separate role) → discover, filter, compare athletes

---

## 3. Feature Breakdown (MVP → Stretch)

**MVP (build first):**
- Profile + BMI
- Squat analyzer (angles, depth, rep count, 2–3 form checks)
- Score breakdown card
- Sports recommendation engine (rule-based, explainable)
- Progress chart (session history)
- Landing + dashboard UI

**Stretch (architecture supports, build if time allows):**
- Push-up, jump, sprint modules (same pipeline, new rule sets)
- Gamification (badges/XP/streaks)
- Coach/scout console with filtering
- Knowledge hub content
- Server-side re-verification of scores for anti-cheat

---

## 4. UI Page Structure

```
/                        Landing
/onboarding              Profile creation
/dashboard               Overview: score, today's metrics, recent test, recommended sport
/assess/[exercise]       Record/upload + live pose overlay
/assess/[id]/results     Score breakdown, mistakes, corrected video
/recommendations         Sports compatibility list
/progress                Charts over time
/library                 Sports + exercise knowledge base
/challenges              Badges, streaks, XP
/coach                   Athlete discovery table + filters + compare
/coach/athlete/[id]      Individual athlete profile (coach view)
/profile                 Edit profile, privacy controls, delete my videos
```

---

## 5. Database Schema (PostgreSQL, simplified)

```sql
users(id, email, password_hash, role[athlete|coach], created_at)

athletes(id, user_id FK, name, age, gender, height_cm, weight_kg,
         location, preferred_sports[], experience_level, training_freq)

exercises(id, name, category, instructions, target_muscles[],
          rule_set_version)

videos(id, athlete_id FK, exercise_id FK, storage_url NULLABLE,
       consent_given BOOL, processed_locally BOOL, created_at, deleted_at)

pose_results(id, video_id FK, frame_index, landmarks JSONB, joint_angles JSONB)

assessments(id, athlete_id FK, exercise_id FK, video_id FK,
            total_reps, correct_reps, incorrect_reps,
            form_score, stability_score, rom_score, tempo_score,
            consistency_score, overall_score, mistakes JSONB, created_at)

fitness_metrics(id, athlete_id FK, strength, speed, agility,
                endurance, flexibility, balance, coordination,
                explosiveness, overall_athletic_score, computed_at)

sports(id, name, required_attributes JSONB)  -- weighting per attribute

recommendations(id, athlete_id FK, sport_id FK, match_pct, rationale JSONB, created_at)

progress_snapshots(id, athlete_id FK, metric_name, value, recorded_at)

achievements(id, athlete_id FK, badge_code, earned_at)

coaches(id, user_id FK, organization, verified BOOL)
```

Relationships: `athletes 1—N assessments`, `assessments 1—1 videos`, `athletes 1—N recommendations`, `athletes 1—N progress_snapshots`. Coaches read athlete/assessment/recommendation tables through a read-only, consent-gated view.

---

## 6. API Design

```
POST   /api/auth/signup | /api/auth/login
POST   /api/athlete                     create/update profile
GET    /api/athlete/:id

POST   /api/assessment/upload           register a video (or landmark payload)
POST   /api/assessment/analyze          run rule engine on landmarks → scores
GET    /api/assessment/:id

GET    /api/recommendations/:athleteId
GET    /api/progress/:athleteId
GET    /api/exercise                    list/detail for library
GET    /api/sports                      list/detail for library

GET    /api/coach/athletes?sport=&minScore=&sort=
GET    /api/coach/athlete/:id
POST   /api/athlete/:id/consent         grant/revoke coach visibility

DELETE /api/video/:id                   user-initiated deletion (privacy)
```

All endpoints behind auth middleware; coach endpoints additionally check `consent_given` per athlete before returning identifiable data.

---

## 7. AI / ML Architecture

**Stage 1 — Pose extraction (client-side):** MediaPipe Pose (BlazePose, WASM) runs per-frame in the browser at ~30fps, emitting 33 3D landmarks with visibility scores. TensorFlow.js/MoveNet is a fallback for low-end devices.

**Stage 2 — Signal processing:** landmark stream → smoothing (moving average / one-euro filter) → per-frame joint angles (law of cosines on 3 landmarks) → a lightweight state machine detects rep phases (e.g. squat: `standing → descending → bottom → ascending → standing`) using knee-angle thresholds and velocity sign changes.

**Stage 3 — Rule engine (interpretable, not a black box):** each exercise has a declarative rule set, e.g.:
```json
{
  "exercise": "squat",
  "checks": [
    {"id": "depth", "metric": "min_knee_angle", "pass_if": "<= 100", "weight": 0.3},
    {"id": "knee_valgus", "metric": "knee_x_offset_from_ankle", "pass_if": "abs(x) < 0.08", "weight": 0.3},
    {"id": "torso_lean", "metric": "max_torso_angle_from_vertical", "pass_if": "<= 45", "weight": 0.2},
    {"id": "tempo", "metric": "rep_duration_variance", "pass_if": "< threshold", "weight": 0.2}
  ]
}
```
This is deliberately rule-based rather than an opaque classifier for the MVP: it's explainable ("why did I lose points"), cheap to run, and easy to extend to new exercises by adding a JSON rule set instead of retraining a model. A supervised classifier (e.g. small LSTM/1D-CNN on angle sequences) is the natural v2 upgrade once labeled rep data exists, and the architecture isolates it behind the same rule-engine interface so it's swappable later.

**Stage 4 — Scoring:** weighted sum of per-rep check pass rates → category scores (form, stability, ROM, tempo, consistency) → overall score. All scores are clearly framed as **AI-estimated**, not certified.

---

## 8. Pose-Estimation Methodology

- Model: MediaPipe BlazePose (Lite/Full/Heavy tiers, chosen by device capability).
- 33 landmarks in normalized image + world coordinates, each with a visibility/confidence score.
- Frames with visibility below threshold for a required joint are flagged and excluded from angle averaging to avoid garbage-in scores.
- Camera guidance UI (framing box, "step back," "side-on view") reduces occlusion before recording even starts.

---

## 9. Exercise-Form Detection Methodology

For each exercise: define (a) the joints needed, (b) 2–4 angle/position metrics, (c) a rep-phase state machine, (d) pass/fail thresholds per metric, (e) natural-language feedback templates keyed to which check failed. New exercises are added by writing a new rule-set JSON + phase definition — no new pose model needed.

---

## 10. Sports Recommendation Algorithm

Rule-based weighted matching (explainable, no cold-start problem — works from test 1):

```
match_pct(sport) = Σ ( normalized_attribute_score × sport.weight[attribute] )
```
Each sport has a weight vector over {strength, speed, agility, endurance, flexibility, coordination, explosiveness}, sourced from general sports-science literature (e.g. sprinting weights speed+explosiveness heavily, football weights agility+endurance+speed). Athlete attribute scores are normalized 0–100 from completed tests; sports with insufficient underlying test coverage are shown as "add more tests to refine this match" rather than guessed. Output includes the top contributing attributes as the "why," and every result carries a "recommendation, not a guarantee" disclaimer. A collaborative-filtering or learned-weights model is a plausible v2 once enough athlete→outcome data exists.

---

## 11. Performance Prediction Methodology

- Only produced when a minimum data threshold is met (e.g. ≥3 sessions of a given test); otherwise the UI explicitly returns "Insufficient data for a reliable estimate."
- Predictions are expressed as **ranges**, not points (e.g. estimated 1RM range from submaximal rep performance using a standard %1RM-by-reps table), always paired with a supervision disclaimer.
- No prediction is framed as a medical or coaching guarantee anywhere in the product copy.

---

## 12. Security / Privacy Architecture

- Explicit consent screen before any camera/video processing begins; consent is per-recording, not blanket.
- Pose extraction happens on-device by default; raw video never leaves the browser unless the user opts in.
- If video is stored: pre-signed, time-limited object storage URLs; encryption at rest; per-athlete delete endpoint that hard-deletes both the object and DB row.
- Coach visibility into an athlete's data is gated by an explicit `consent_given` flag the athlete controls and can revoke.
- Minimal PII collection; no biometric identity matching — pose landmarks are used only for movement analysis, not identification.
- Documented fairness constraint: scoring and recommendation logic use only physical performance metrics — never gender, region, caste, religion, language, or appearance as inputs to score or rank athletes. This is enforced by keeping those fields entirely out of the scoring/recommendation function signatures, not just as a policy statement.

---

## 13. Folder Structure

```
talenttrack/
├─ apps/
│  ├─ web/                     # Next.js frontend
│  │  ├─ app/                  # routes per page list above
│  │  ├─ components/
│  │  ├─ lib/pose/             # MediaPipe wrapper, angle math, rep state machine
│  │  ├─ lib/rules/            # per-exercise JSON rule sets
│  │  └─ styles/
│  └─ ml-service/              # FastAPI, optional heavier CV (sprint/jump video)
├─ packages/
│  ├─ scoring-engine/          # shared TS: angle math, rule evaluation, scoring
│  ├─ recommendation-engine/   # shared TS: sport-matching algorithm
│  └─ ui/                      # shared design-system components
├─ db/
│  ├─ schema.sql
│  └─ migrations/
└─ infra/
   ├─ vercel.json
   └─ render.yaml
```

---

## 14. Development Roadmap

| Phase | Focus | Output |
|---|---|---|
| 1 (Day 1) | Profile, BMI, landing, design system | Clickable shell |
| 2 (Day 1–2) | MediaPipe integration, squat angle math, rep counter | Live skeleton overlay |
| 3 (Day 2) | Rule engine + scoring + feedback copy | Working squat score |
| 4 (Day 2–3) | Sports recommendation engine | Ranked sport list |
| 5 (Day 3) | Progress dashboard, gamification | Charts + badges |
| 6 (Day 3–4) | Coach console, consent flow | Discovery table |
| 7 (Day 4) | Knowledge hub content, polish, privacy copy | Content complete |
| 8 (Day 4–5) | Demo script rehearsal, mock/real-data labeling, bug bash | Demo-ready build |

---

## 15. SIH Presentation / Demo Strategy (3–5 min)

1. **Hook (20s):** "Millions of talented kids never get scouted because a fitness test needs a coach and equipment they don't have. All you need is this." → hold up phone.
2. **Live squat demo (60–90s):** record a squat on stage, show live skeleton + rep counter, one intentional bad rep (knees caving) to show real-time feedback firing.
3. **Results screen (30s):** score breakdown, mistake called out in plain language.
4. **Sports recommendation (30s):** show ranked sports with the "why," emphasize it's a recommendation not a verdict.
5. **Progress + gamification (20s):** trend line, a badge popping.
6. **Coach console (30s):** switch role, filter athletes by sport/score, show how a coach in a city could discover this athlete in a village.
7. **Close (20s):** restate impact — standardized, accessible, camera-only preliminary assessment; clearly labeled as AI-assisted, not a medical or professional-certification tool.

Label any pre-scripted portions of the demo clearly as "sample data" versus the live squat analysis, which should be real MediaPipe output — judges notice and reward honesty about what's real.
