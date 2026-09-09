// db.js — persistent storage using Node's built-in SQLite (node:sqlite).
// No external dependencies, no npm install required. Data survives server restarts
// because it's written to a real .sqlite file on disk (talenttrack.db).
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'talenttrack.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'athlete',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS athletes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE,
  name TEXT, age INTEGER, gender TEXT, height_cm REAL, weight_kg REAL,
  location TEXT, preferred_sport TEXT, experience TEXT,
  bmi REAL, coach_opt_in INTEGER DEFAULT 0,
  is_demo INTEGER DEFAULT 0,
  coins INTEGER DEFAULT 0, diamonds INTEGER DEFAULT 0, xp INTEGER DEFAULT 0, level INTEGER DEFAULT 1,
  guardian_name TEXT, guardian_contact TEXT,
  leaderboard_opt_in INTEGER DEFAULT 0, leaderboard_name TEXT,
  updated_at INTEGER
);

-- Coaches/scouts: created at signup but NOT visible to athlete discovery
-- until verified=1. This is the gate that was missing before — previously
-- any account with role='coach' could read every opted-in athlete's name
-- and location. Now that requires an explicit verification step.
CREATE TABLE IF NOT EXISTS coaches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE,
  organization TEXT,
  verified INTEGER DEFAULT 0,
  requested_at INTEGER,
  verified_at INTEGER
);

CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  athlete_id INTEGER NOT NULL,
  exercise TEXT NOT NULL,
  mode TEXT NOT NULL,
  total_reps INTEGER, correct_reps INTEGER,
  form REAL, stability REAL, rom REAL, tempo REAL, consistency REAL, overall REAL,
  extra_json TEXT,
  mistakes_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS achievements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  athlete_id INTEGER NOT NULL,
  badge_code TEXT NOT NULL,
  earned_at INTEGER NOT NULL,
  UNIQUE(athlete_id, badge_code)
);

CREATE TABLE IF NOT EXISTS daily_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  athlete_id INTEGER NOT NULL,
  challenge_date TEXT NOT NULL,
  exercise TEXT NOT NULL,
  metric TEXT NOT NULL,
  target_value INTEGER NOT NULL,
  completed_value INTEGER DEFAULT 0,
  correct_value INTEGER DEFAULT 0,
  coins_earned INTEGER DEFAULT 0,
  diamonds_earned INTEGER DEFAULT 0,
  completed INTEGER DEFAULT 0,
  UNIQUE(athlete_id, challenge_date)
);

CREATE TABLE IF NOT EXISTS talent_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  athlete_id INTEGER NOT NULL,
  sport TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(athlete_id, sport)
);
`);

/* ---------------- schema migration for pre-existing databases ----------------
   Fresh installs already get these columns from the CREATE TABLE above; this
   covers upgrading a talenttrack.db created by an earlier version of the app
   so nobody's existing data or login is lost when the code is updated. */
function tryAddColumn(table, columnDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`); } catch (e) { /* already exists */ }
}
tryAddColumn('athletes', 'coins INTEGER DEFAULT 0');
tryAddColumn('athletes', 'diamonds INTEGER DEFAULT 0');
tryAddColumn('athletes', 'xp INTEGER DEFAULT 0');
tryAddColumn('athletes', 'level INTEGER DEFAULT 1');
tryAddColumn('athletes', 'guardian_name TEXT');
tryAddColumn('athletes', 'guardian_contact TEXT');
tryAddColumn('athletes', 'leaderboard_opt_in INTEGER DEFAULT 0');
tryAddColumn('athletes', 'leaderboard_name TEXT');
tryAddColumn('sessions', 'expires_at INTEGER');

/* ---------------- seed demo/sample data for the coach console ----------------
   Clearly separated (is_demo=1) from real athlete accounts so the UI can label
   it "sample data" per the product's honesty requirement. Only runs once. */
function seedDemoData() {
  const count = db.prepare('SELECT COUNT(*) as c FROM athletes WHERE is_demo = 1').get().c;
  if (count > 0) return;
  const now = Date.now();
  const demo = [
    { name: 'Athlete A (sample)', location: 'Ranchi, JH', sport: 'Athletics', speed: 92, strength: 78, agility: 88, overall: 87 },
    { name: 'Athlete B (sample)', location: 'Guwahati, AS', sport: 'Football', speed: 89, strength: 84, agility: 93, overall: 89 },
    { name: 'Athlete C (sample)', location: 'Kochi, KL', sport: 'Basketball', speed: 80, strength: 75, agility: 85, overall: 81 },
    { name: 'Athlete D (sample)', location: 'Bhopal, MP', sport: 'Wrestling', speed: 70, strength: 91, agility: 76, overall: 83 },
    { name: 'Athlete E (sample)', location: 'Jaipur, RJ', sport: 'Badminton', speed: 86, strength: 65, agility: 90, overall: 82 },
  ];
  const insAthlete = db.prepare(`INSERT INTO athletes (user_id,name,age,gender,height_cm,weight_kg,location,preferred_sport,experience,bmi,coach_opt_in,is_demo,leaderboard_opt_in,leaderboard_name,updated_at)
    VALUES (NULL,?,?,?,?,?,?,?,?,?,1,1,1,?,?)`);
  const insAssess = db.prepare(`INSERT INTO assessments (athlete_id,exercise,mode,total_reps,correct_reps,form,stability,rom,tempo,consistency,overall,extra_json,mistakes_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insChallenge = db.prepare(`INSERT OR IGNORE INTO daily_challenges (athlete_id,challenge_date,exercise,metric,target_value,completed_value,correct_value,coins_earned,diamonds_earned,completed)
    VALUES (?,?,?,?,?,?,?,?,?,1)`);
  const dayMs = 86400000;
  demo.forEach((a, idx) => {
    const leaderboardName = a.name.replace(' (sample)', '');
    const res = insAthlete.run(a.name, 20, 'Prefer not to say', 172, 65, a.location, a.sport, 'Competitive', 21.9, leaderboardName, now);
    const athleteId = Number(res.lastInsertRowid);
    insAssess.run(athleteId, 'squat', 'demo', 10, 9, a.strength, a.agility, a.strength, a.speed, a.agility, a.overall,
      JSON.stringify({ speed: a.speed, agility: a.agility }), JSON.stringify([]), now);

    // Spread completed daily-challenge rows over the last ~35 days so both the
    // weekly and monthly leaderboards have sample activity to show on a fresh
    // install rather than being empty until real users compete.
    for (let d = 0; d < 35; d++) {
      if ((d + idx) % 2 !== 0) continue; // active roughly every other day, staggered per athlete
      const dateStr = new Date(now - d * dayMs).toISOString().slice(0, 10);
      const correct = 8 + ((d + idx * 3) % 12);
      const coins = correct * 3 + 5;
      const diamonds = (d + idx) % 4 === 0 ? 1 : 0;
      insChallenge.run(athleteId, dateStr, 'squat', 'reps', 20, correct, correct, coins, diamonds);
    }
  });
}
seedDemoData();

module.exports = db;
