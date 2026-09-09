// server.js — TalentTrack backend.
// Pure Node.js (http + node:sqlite + crypto). No npm install required.
// Run:  node server.js   then open http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ============================= helpers ============================= */
function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 5_000_000) req.destroy(); });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
function createSession(userId) {
  const token = makeToken();
  const now = Date.now();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

function authenticate(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (session.expires_at && session.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token); // expired — clean up and reject
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  return user || null;
}

/* -------- login/signup rate limiting (in-memory, per-IP sliding window) --------
   Not a substitute for a real WAF/proxy-level limiter in production, but it
   stops trivial brute-force loops against auth endpoints, which had zero
   protection before. */
const authAttempts = new Map(); // ip -> [timestamps]
const AUTH_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const AUTH_MAX_ATTEMPTS = 10;
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
function rateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const attempts = (authAttempts.get(ip) || []).filter(t => now - t < AUTH_WINDOW_MS);
  attempts.push(now);
  authAttempts.set(ip, attempts);
  return attempts.length > AUTH_MAX_ATTEMPTS;
}
// periodic cleanup so the map doesn't grow forever on a long-running server
setInterval(() => {
  const now = Date.now();
  for (const [ip, attempts] of authAttempts) {
    const kept = attempts.filter(t => now - t < AUTH_WINDOW_MS);
    if (kept.length) authAttempts.set(ip, kept); else authAttempts.delete(ip);
  }
}, AUTH_WINDOW_MS).unref();

const MINOR_AGE = 18;

/* -------- admin key for coach verification --------
   If ADMIN_KEY isn't set in the environment, generate one at startup and
   print it once so the app is still usable for a demo, but nobody can
   self-verify a coach account without it. */
const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(16).toString('hex');
if (!process.env.ADMIN_KEY) {
  console.log(`\nNo ADMIN_KEY set — generated one for this run:\n  ${ADMIN_KEY}\nUse it to verify coach accounts: POST /api/admin/verify-coach with header 'x-admin-key'.\nSet ADMIN_KEY yourself for a stable value across restarts.\n`);
}

function getOrCreateAthlete(userId) {
  let athlete = db.prepare('SELECT * FROM athletes WHERE user_id = ?').get(userId);
  if (!athlete) {
    const res = db.prepare(`INSERT INTO athletes (user_id, updated_at) VALUES (?, ?)`).run(userId, Date.now());
    athlete = db.prepare('SELECT * FROM athletes WHERE id = ?').get(Number(res.lastInsertRowid));
  }
  return athlete;
}

function bmiCategory(bmi) {
  if (bmi == null) return null;
  if (bmi < 18.5) return 'Underweight';
  if (bmi < 25) return 'Healthy range';
  if (bmi < 30) return 'Above range';
  return 'Well above range';
}

/* -------- sports recommendation engine (mirrors ARCHITECTURE.md §10) -------- */
const SPORTS_DB = [
  { name: 'Athletics (Sprints/Jumps)', w: { strength: 0.22, speed: 0.28, agility: 0.12, endurance: 0.05, coordination: 0.08, explosiveness: 0.25 } },
  { name: 'Football', w: { strength: 0.12, speed: 0.24, agility: 0.22, endurance: 0.24, coordination: 0.1, explosiveness: 0.08 } },
  { name: 'Basketball', w: { strength: 0.12, speed: 0.14, agility: 0.18, endurance: 0.14, coordination: 0.2, explosiveness: 0.22 } },
  { name: 'Badminton', w: { strength: 0.08, speed: 0.18, agility: 0.28, endurance: 0.14, coordination: 0.24, explosiveness: 0.08 } },
  { name: 'Wrestling', w: { strength: 0.34, speed: 0.08, agility: 0.14, endurance: 0.18, coordination: 0.12, explosiveness: 0.14 } },
];
const ATTR_LABELS = {
  strength: 'Strong lower/upper-body strength from your tests',
  speed: 'Good estimated speed', agility: 'Good agility',
  endurance: 'Good endurance', coordination: 'Good coordination and stability',
  explosiveness: 'Good explosive power from your jump test',
};

function computeAttributesFromAssessments(rows) {
  const attrs = { strength: null, speed: null, agility: null, endurance: null, coordination: null, explosiveness: null };
  const squat = rows.filter(r => r.exercise === 'squat').at(-1);
  const pushup = rows.filter(r => r.exercise === 'pushup').at(-1);
  const lunge = rows.filter(r => r.exercise === 'lunge').at(-1);
  const jump = rows.filter(r => r.exercise === 'jump').at(-1);
  const plank = rows.filter(r => r.exercise === 'plank').at(-1);
  const jumpingjack = rows.filter(r => r.exercise === 'jumpingjack').at(-1);

  const mergeAvg = (current, value) => current == null ? Math.round(value) : Math.round((current + value) / 2);

  if (squat) attrs.strength = mergeAvg(attrs.strength, squat.form * 0.5 + squat.rom * 0.5);
  if (pushup) attrs.strength = mergeAvg(attrs.strength, pushup.form);
  if (lunge) attrs.strength = mergeAvg(attrs.strength, lunge.form);

  if (squat) attrs.coordination = mergeAvg(attrs.coordination, squat.stability * 0.6 + squat.consistency * 0.4);
  if (lunge) attrs.coordination = mergeAvg(attrs.coordination, lunge.stability);
  if (jumpingjack) attrs.coordination = mergeAvg(attrs.coordination, jumpingjack.stability);

  if (jump) {
    attrs.explosiveness = Math.round(jump.overall);
    attrs.agility = mergeAvg(attrs.agility, (jump.stability + jump.consistency) / 2);
  }
  if (jumpingjack) attrs.agility = mergeAvg(attrs.agility, jumpingjack.form);

  if (plank) attrs.endurance = mergeAvg(attrs.endurance, plank.form);
  if (jumpingjack) attrs.endurance = mergeAvg(attrs.endurance, jumpingjack.form);

  return attrs;
}

function getRecommendations(attrs, assessmentCount) {
  if (assessmentCount === 0) return [];
  return SPORTS_DB.map(sport => {
    let scoreSum = 0, weightSum = 0, contributions = [];
    Object.entries(sport.w).forEach(([k, w]) => {
      const known = attrs[k] != null;
      const val = known ? attrs[k] : 50;
      const confidence = known ? 1 : 0.4;
      scoreSum += val * w * confidence;
      weightSum += w * confidence;
      if (known) contributions.push([k, val * w]);
    });
    contributions.sort((a, b) => b[1] - a[1]);
    const why = contributions.slice(0, 2).map(([k]) => ATTR_LABELS[k]);
    return { name: sport.name, pct: Math.min(99, Math.round(scoreSum / weightSum)), why: why.length ? why : ['Based on your profile — complete more tests to refine this.'] };
  }).sort((a, b) => b.pct - a.pct);
}

/* -------- gamification -------- */
const BADGES = [
  { id: 'first', name: 'First Assessment', cond: (rows) => rows.length >= 1 },
  { id: 'reps50', name: '50 Reps Logged', cond: (rows) => rows.reduce((a, s) => a + (s.total_reps||0), 0) >= 50 },
  { id: 'threesess', name: '3 Assessments', cond: (rows) => rows.length >= 3 },
  { id: 'goodform', name: '90+ Form Score', cond: (rows) => rows.some(s => s.form >= 90) },
  { id: 'allrounder', name: 'All-Rounder (3 exercises)', cond: (rows) => new Set(rows.map(r=>r.exercise)).size >= 3 },
];
function recomputeAchievements(athleteId, rows) {
  const earned = db.prepare('SELECT badge_code FROM achievements WHERE athlete_id = ?').all(athleteId).map(r => r.badge_code);
  const newlyEarned = [];
  BADGES.forEach(b => {
    if (b.cond(rows) && !earned.includes(b.id)) {
      db.prepare('INSERT OR IGNORE INTO achievements (athlete_id, badge_code, earned_at) VALUES (?,?,?)').run(athleteId, b.id, Date.now());
      newlyEarned.push(b.id);
    }
  });
  return newlyEarned;
}

/* -------- static knowledge base -------- */
const SPORTS_INFO = require('./content/sports.json');
const EXERCISE_INFO = require('./content/exercises.json');

/* -------- daily challenges: coins/diamonds/xp/level -------- */
const CHALLENGE_ROTATION = [
  { exercise: 'squat', metric: 'reps', target: 20 },
  { exercise: 'pushup', metric: 'reps', target: 15 },
  { exercise: 'lunge', metric: 'reps', target: 16 },
  { exercise: 'jumpingjack', metric: 'reps', target: 35 },
  { exercise: 'plank', metric: 'seconds', target: 45 },
];
function todayDateStr() { return new Date().toISOString().slice(0, 10); }
function getOrCreateDailyChallenge(athleteId) {
  const dateStr = todayDateStr();
  let row = db.prepare('SELECT * FROM daily_challenges WHERE athlete_id=? AND challenge_date=?').get(athleteId, dateStr);
  if (!row) {
    const dayIndex = Math.floor(Date.now() / 86400000);
    const tpl = CHALLENGE_ROTATION[dayIndex % CHALLENGE_ROTATION.length];
    db.prepare('INSERT INTO daily_challenges (athlete_id,challenge_date,exercise,metric,target_value) VALUES (?,?,?,?,?)')
      .run(athleteId, dateStr, tpl.exercise, tpl.metric, tpl.target);
    row = db.prepare('SELECT * FROM daily_challenges WHERE athlete_id=? AND challenge_date=?').get(athleteId, dateStr);
  }
  return row;
}
// Called from inside POST /api/assessments — awards coins/diamonds/xp if this
// assessment matches today's not-yet-completed challenge. Coins scale with
// correct reps (more coins for correct ones); diamonds only when the full
// target was hit with every rep up to standard, per the product's own rule.
function tryCompleteDailyChallenge(athlete, exercise, totalReps, correctReps, extra, form) {
  const challenge = getOrCreateDailyChallenge(athlete.id);
  if (challenge.completed || challenge.exercise !== exercise) return null;
  const achievedValue = challenge.metric === 'seconds' ? Math.round((extra && extra.holdSeconds) || 0) : (totalReps || 0);
  const achievedCorrect = challenge.metric === 'seconds'
    ? Math.round(((form || 0) / 100) * achievedValue)
    : (correctReps || 0);
  if (achievedValue <= 0) return null; // nothing meaningful attempted yet
  const metTarget = achievedValue >= challenge.target_value;
  const perfectQuality = metTarget && achievedCorrect >= challenge.target_value;
  const coinsEarned = achievedCorrect * 3 + Math.max(0, achievedValue - achievedCorrect) * 1;
  const diamondsEarned = perfectQuality ? 3 : 0;
  db.prepare('UPDATE daily_challenges SET completed_value=?, correct_value=?, coins_earned=?, diamonds_earned=?, completed=1 WHERE id=?')
    .run(achievedValue, achievedCorrect, coinsEarned, diamondsEarned, challenge.id);
  const xpGained = coinsEarned + diamondsEarned * 10;
  const newXp = (athlete.xp || 0) + xpGained;
  const newLevel = Math.floor(newXp / 100) + 1;
  const leveledUp = newLevel > (athlete.level || 1);
  db.prepare('UPDATE athletes SET coins = coins + ?, diamonds = diamonds + ?, xp = ?, level = ? WHERE id = ?')
    .run(coinsEarned, diamondsEarned, newXp, newLevel, athlete.id);
  return { exercise, metric: challenge.metric, target: challenge.target_value, achievedValue, achievedCorrect, metTarget, perfectQuality, coinsEarned, diamondsEarned, xpGained, newXp, newLevel, leveledUp };
}

/* -------- Ask about a sport/exercise: real AI if configured, otherwise a
   transparent knowledge-base search over our own content (never fake AI). -------- */
const https = require('https');
function buildKbContext() {
  const sportsTxt = SPORTS_INFO.map(s => `${s.name}: rules - ${s.rules} fitness - ${s.fitness} tips - ${s.tips} mistakes - ${s.mistakes}`).join('\n');
  const exTxt = EXERCISE_INFO.map(e => `${e.name}: muscles - ${e.muscles} technique - ${e.technique} mistakes - ${e.mistakes}`).join('\n');
  return sportsTxt + '\n' + exTxt;
}
function callAnthropic(question) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return reject(new Error('NO_API_KEY'));
    const payload = JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: 'You are a knowledgeable, safety-conscious sports and fitness coach embedded in the TalentTrack app. Answer the question clearly and practically in 3-6 sentences using the reference material where relevant. Never diagnose injuries or give medical advice; suggest a professional for pain or injury concerns.',
      messages: [{ role: 'user', content: `Reference material:\n${buildKbContext()}\n\nQuestion: ${question}` }],
    });
    const apiReq = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST', timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload) },
    }, (apiRes) => {
      let data = ''; apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.content && parsed.content[0] && parsed.content[0].text) resolve(parsed.content[0].text);
          else reject(new Error('BAD_RESPONSE'));
        } catch (e) { reject(e); }
      });
    });
    apiReq.on('timeout', () => apiReq.destroy(new Error('TIMEOUT')));
    apiReq.on('error', reject);
    apiReq.write(payload); apiReq.end();
  });
}
function callGemini(question) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return reject(new Error('NO_API_KEY'));
    const model = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
    const payload = JSON.stringify({
      systemInstruction: {
        parts: [{ text: 'You are a knowledgeable, safety-conscious sports and fitness coach embedded in the TalentTrack app. Answer the question clearly and practically in 3-6 sentences using the reference material where relevant. Never diagnose injuries or give medical advice; suggest a professional for pain or injury concerns.' }],
      },
      contents: [{ role: 'user', parts: [{ text: `Reference material:\n${buildKbContext()}\n\nQuestion: ${question}` }] }],
    });
    const apiReq = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent`,
      method: 'POST',
      timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, 'Content-Length': Buffer.byteLength(payload) },
    }, (apiRes) => {
      let data = ''; apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('');
          if (text) resolve(text);
          else reject(new Error('BAD_RESPONSE: ' + data.slice(0, 300)));
        } catch (e) { reject(e); }
      });
    });
    apiReq.on('timeout', () => apiReq.destroy(new Error('TIMEOUT')));
    apiReq.on('error', reject);
    apiReq.write(payload); apiReq.end();
  });
}
function keywordAnswer(question) {
  const words = question.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const scoreEntry = (entry, fields) => {
    const text = (entry.name + ' ' + fields.map(f => entry[f] || '').join(' ')).toLowerCase();
    return words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0);
  };
  const matches = [
    ...SPORTS_INFO.map(s => ({ type: 'sport', item: s, score: scoreEntry(s, ['rules', 'fitness', 'tips', 'mistakes', 'equipment', 'positions']) })),
    ...EXERCISE_INFO.map(e => ({ type: 'exercise', item: e, score: scoreEntry(e, ['muscles', 'technique', 'mistakes', 'beginner', 'advanced']) })),
  ].filter(m => m.score > 0).sort((a, b) => b.score - a.score).slice(0, 2);
  if (!matches.length) return null;
  return matches.map(m => m.type === 'sport'
    ? `${m.item.name}: ${m.item.rules} Key fitness needs: ${m.item.fitness}. Tip: ${m.item.tips}`
    : `${m.item.name}: ${m.item.technique} Common mistake: ${m.item.mistakes}`
  ).join('\n\n');
}

/* ============================= routes ============================= */
const routes = [];
function route(method, pattern, handler) {
  const paramNames = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { paramNames.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, paramNames, handler });
}

route('POST', '/api/auth/signup', async (req, res, params, body) => {
  if (rateLimited(req)) return send(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
  const { email, password, role, organization } = body;
  if (!email || !password || password.length < 8) return send(res, 400, { error: 'Email and a password (8+ chars) are required.' });
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return send(res, 409, { error: 'An account with that email already exists.' });
  const isCoach = role === 'coach';
  if (isCoach && !(organization || '').trim()) {
    return send(res, 400, { error: 'Coach/scout accounts must provide an organization name — it is reviewed before you can see any real athlete data.' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const r = db.prepare('INSERT INTO users (email, password_hash, salt, role, created_at) VALUES (?,?,?,?,?)')
    .run(email.toLowerCase(), hash, salt, isCoach ? 'coach' : 'athlete', Date.now());
  const userId = Number(r.lastInsertRowid);
  if (isCoach) {
    db.prepare('INSERT INTO coaches (user_id, organization, verified, requested_at) VALUES (?,?,0,?)')
      .run(userId, organization.trim(), Date.now());
  } else {
    getOrCreateAthlete(userId);
  }
  const token = createSession(userId);
  send(res, 201, { token, role: isCoach ? 'coach' : 'athlete', email: email.toLowerCase(), coachVerified: false });
});

route('POST', '/api/auth/login', async (req, res, params, body) => {
  if (rateLimited(req)) return send(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
  const { email, password } = body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase());
  if (!user) return send(res, 401, { error: 'Invalid email or password.' });
  const hash = hashPassword(password || '', user.salt);
  if (hash !== user.password_hash) return send(res, 401, { error: 'Invalid email or password.' });
  const token = createSession(user.id);
  const coach = user.role === 'coach' ? db.prepare('SELECT verified FROM coaches WHERE user_id = ?').get(user.id) : null;
  send(res, 200, { token, role: user.role, email: user.email, coachVerified: coach ? !!coach.verified : undefined });
});

route('POST', '/api/auth/logout', async (req, res, params, body, user) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  send(res, 200, { ok: true });
});

route('GET', '/api/me', async (req, res, params, body, user) => {
  if (user.role === 'coach') {
    const coach = db.prepare('SELECT organization, verified FROM coaches WHERE user_id = ?').get(user.id) || { organization: null, verified: 0 };
    return send(res, 200, { email: user.email, role: user.role, coach: { organization: coach.organization, verified: !!coach.verified } });
  }
  const athlete = getOrCreateAthlete(user.id);
  send(res, 200, { email: user.email, role: user.role, profile: { ...athlete, bmiCategory: bmiCategory(athlete.bmi) } });
});

route('PUT', '/api/athlete', async (req, res, params, body, user) => {
  const athlete = getOrCreateAthlete(user.id);
  const { name, age, gender, height_cm, weight_kg, location, preferred_sport, experience, guardian_name, guardian_contact } = body;

  // Basic sanity validation — previously age/height/weight were trusted as-is.
  const ageNum = age != null ? Number(age) : null;
  const heightNum = height_cm != null ? Number(height_cm) : null;
  const weightNum = weight_kg != null ? Number(weight_kg) : null;
  if (ageNum != null && (!Number.isFinite(ageNum) || ageNum < 5 || ageNum > 100)) {
    return send(res, 400, { error: 'Please enter a realistic age (5–100).' });
  }
  if (heightNum != null && (!Number.isFinite(heightNum) || heightNum < 80 || heightNum > 250)) {
    return send(res, 400, { error: 'Please enter a realistic height in cm.' });
  }
  if (weightNum != null && (!Number.isFinite(weightNum) || weightNum < 15 || weightNum > 300)) {
    return send(res, 400, { error: 'Please enter a realistic weight in kg.' });
  }

  const isMinor = ageNum != null && ageNum < MINOR_AGE;
  // If they're a minor and haven't provided guardian info, don't silently drop
  // any guardian info already on file; otherwise store what's provided.
  const finalGuardianName = guardian_name !== undefined ? guardian_name : athlete.guardian_name;
  const finalGuardianContact = guardian_contact !== undefined ? guardian_contact : athlete.guardian_contact;

  const bmi = (heightNum && weightNum) ? Math.round((weightNum / ((heightNum / 100) ** 2)) * 10) / 10 : athlete.bmi;
  db.prepare(`UPDATE athletes SET name=?, age=?, gender=?, height_cm=?, weight_kg=?, location=?, preferred_sport=?, experience=?, bmi=?, guardian_name=?, guardian_contact=?, updated_at=? WHERE id=?`)
    .run(name, ageNum, gender, heightNum, weightNum, location, preferred_sport, experience, bmi, finalGuardianName, finalGuardianContact, Date.now(), athlete.id);

  // If this update makes them a minor without guardian consent on file, coach
  // visibility AND leaderboard visibility are both automatically turned off
  // until guardian info is supplied — it should never be possible for a minor
  // to be scoutable, or publicly ranked in front of other users, by default.
  if (isMinor && !(finalGuardianName && finalGuardianContact)) {
    db.prepare('UPDATE athletes SET coach_opt_in = 0, leaderboard_opt_in = 0 WHERE id = ?').run(athlete.id);
  }

  const updated = db.prepare('SELECT * FROM athletes WHERE id = ?').get(athlete.id);
  send(res, 200, { profile: { ...updated, bmiCategory: bmiCategory(updated.bmi) }, isMinor });
});

route('DELETE', '/api/me', async (req, res, params, body, user) => {
  // Full account + data deletion ("right to be forgotten"). Previously the
  // only delete route removed a single assessment — there was no way for a
  // user to actually remove themselves from the product.
  const athlete = db.prepare('SELECT * FROM athletes WHERE user_id = ?').get(user.id);
  if (athlete) {
    db.prepare('DELETE FROM assessments WHERE athlete_id = ?').run(athlete.id);
    db.prepare('DELETE FROM achievements WHERE athlete_id = ?').run(athlete.id);
    db.prepare('DELETE FROM daily_challenges WHERE athlete_id = ?').run(athlete.id);
    db.prepare('DELETE FROM talent_records WHERE athlete_id = ?').run(athlete.id);
    db.prepare('DELETE FROM athletes WHERE id = ?').run(athlete.id);
  }
  db.prepare('DELETE FROM coaches WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  send(res, 200, { ok: true });
});

route('PUT', '/api/athlete/consent', async (req, res, params, body, user) => {
  const athlete = getOrCreateAthlete(user.id);
  const wantsOptIn = !!body.optIn;
  const isMinor = athlete.age != null && athlete.age < MINOR_AGE;
  if (wantsOptIn && isMinor && !(athlete.guardian_name && athlete.guardian_contact)) {
    return send(res, 400, { error: 'Coach visibility for under-18 athletes requires a parent/guardian name and contact on file first. Add these on your profile page.', requiresGuardianConsent: true });
  }
  db.prepare('UPDATE athletes SET coach_opt_in = ? WHERE id = ?').run(wantsOptIn ? 1 : 0, athlete.id);
  send(res, 200, { ok: true, coach_opt_in: wantsOptIn });
});

/* -------- leaderboard opt-in --------
   Separate, independent opt-in from coach visibility: this exposes an athlete
   to OTHER USERS (peers competing), not to coaches/scouts, so it gets its own
   flag rather than being folded into coach_opt_in. Athletes are never shown
   by their real name/location here — only a short display name they choose
   (or a generated one) — and the same under-18 guardian-consent gate used for
   coach visibility applies here too, since this is still "make me visible to
   other people I don't know" in effect. */
function sanitizeDisplayName(raw, fallbackSeed) {
  let name = (raw || '').toString().trim().replace(/[<>]/g, '').slice(0, 24);
  if (!name) name = 'Athlete' + (1000 + (fallbackSeed % 9000));
  return name;
}

route('PUT', '/api/athlete/leaderboard', async (req, res, params, body, user) => {
  const athlete = getOrCreateAthlete(user.id);
  const wantsOptIn = !!body.optIn;
  const isMinor = athlete.age != null && athlete.age < MINOR_AGE;
  if (wantsOptIn && isMinor && !(athlete.guardian_name && athlete.guardian_contact)) {
    return send(res, 400, { error: 'Joining the leaderboard as an under-18 athlete requires a parent/guardian name and contact on file first. Add these on your profile page.', requiresGuardianConsent: true });
  }
  let displayName = athlete.leaderboard_name;
  if (wantsOptIn) {
    displayName = sanitizeDisplayName(body.displayName, athlete.id);
  }
  db.prepare('UPDATE athletes SET leaderboard_opt_in = ?, leaderboard_name = ? WHERE id = ?')
    .run(wantsOptIn ? 1 : 0, displayName, athlete.id);
  send(res, 200, { ok: true, leaderboard_opt_in: wantsOptIn, leaderboard_name: displayName });
});

/* -------- leaderboard: weekly (ISO Mon–Sun) and monthly (calendar month) --------
   Ranks by XP earned from completed daily challenges within the period —
   reuses the existing coins/diamonds/xp gamification data rather than
   inventing a second scoring system, so "compete on the leaderboard" and
   "complete your daily challenge" are the same underlying activity. */
function isoWeekStartStr(d = new Date()) {
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day);
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff));
  return monday.toISOString().slice(0, 10);
}
function monthStartStr(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}
function periodStartStr(period) {
  return period === 'monthly' ? monthStartStr() : isoWeekStartStr();
}
function formatRangeLabel(period, startStr) {
  const start = new Date(startStr + 'T00:00:00Z');
  if (period === 'monthly') return start.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const end = new Date(start.getTime() + 6 * 86400000);
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  return `${start.toLocaleDateString('en-US', opts)} – ${end.toLocaleDateString('en-US', opts)}`;
}

route('GET', '/api/leaderboard', async (req, res, params, body, user, query) => {
  const period = query.period === 'monthly' ? 'monthly' : 'weekly';
  const startStr = periodStartStr(period);
  const athlete = getOrCreateAthlete(user.id);

  const rows = db.prepare(`
    SELECT a.id as athlete_id, a.leaderboard_name, a.preferred_sport, a.is_demo,
           COALESCE(SUM(dc.coins_earned + dc.diamonds_earned * 10), 0) as xp,
           COALESCE(SUM(dc.correct_value), 0) as correctReps
    FROM athletes a
    LEFT JOIN daily_challenges dc
      ON dc.athlete_id = a.id AND dc.challenge_date >= ? AND dc.completed = 1
    WHERE a.leaderboard_opt_in = 1
    GROUP BY a.id
    HAVING SUM(dc.coins_earned + dc.diamonds_earned * 10) > 0
    ORDER BY xp DESC, correctReps DESC, a.id ASC
  `).all(startStr);

  const ranked = rows.map((r, i) => ({
    rank: i + 1,
    athleteId: r.athlete_id,
    displayName: r.leaderboard_name || 'Athlete',
    sport: r.preferred_sport || null,
    xp: r.xp,
    correctReps: r.correctReps,
    isDemo: !!r.is_demo,
    isYou: r.athlete_id === athlete.id,
  }));

  const you = ranked.find(r => r.isYou) || null;

  send(res, 200, {
    period,
    rangeLabel: formatRangeLabel(period, startStr),
    optedIn: !!athlete.leaderboard_opt_in,
    you: you ? { rank: you.rank, xp: you.xp, correctReps: you.correctReps, displayName: you.displayName, outOf: ranked.length } : null,
    leaderboard: ranked.slice(0, 50),
  });
});

route('POST', '/api/assessments', async (req, res, params, body, user) => {
  const athlete = getOrCreateAthlete(user.id);
  const { exercise, mode, totalReps, correctReps, form, stability, rom, tempo, consistency, overall, extra, mistakes } = body;
  if (!exercise || overall == null) return send(res, 400, { error: 'exercise and overall score are required.' });
  const r = db.prepare(`INSERT INTO assessments
    (athlete_id, exercise, mode, total_reps, correct_reps, form, stability, rom, tempo, consistency, overall, extra_json, mistakes_json, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(athlete.id, exercise, mode || 'live', totalReps || 0, correctReps || 0, form || 0, stability || 0, rom || 0, tempo || 0, consistency || 0, overall,
      JSON.stringify(extra || {}), JSON.stringify(mistakes || []), Date.now());
  const rows = db.prepare('SELECT * FROM assessments WHERE athlete_id = ? ORDER BY created_at ASC').all(athlete.id);
  const newBadges = recomputeAchievements(athlete.id, rows);
  const challengeResult = tryCompleteDailyChallenge(athlete, exercise, totalReps, correctReps, extra, form);
  send(res, 201, { id: Number(r.lastInsertRowid), newBadges, challengeResult });
});

route('GET', '/api/assessments', async (req, res, params, body, user) => {
  const athlete = getOrCreateAthlete(user.id);
  const rows = db.prepare('SELECT * FROM assessments WHERE athlete_id = ? ORDER BY created_at ASC').all(athlete.id);
  send(res, 200, { assessments: rows });
});

route('DELETE', '/api/assessments/:id', async (req, res, params, body, user) => {
  const athlete = getOrCreateAthlete(user.id);
  db.prepare('DELETE FROM assessments WHERE id = ? AND athlete_id = ?').run(params.id, athlete.id);
  send(res, 200, { ok: true });
});

route('GET', '/api/recommendations', async (req, res, params, body, user) => {
  const athlete = getOrCreateAthlete(user.id);
  const rows = db.prepare('SELECT * FROM assessments WHERE athlete_id = ? ORDER BY created_at ASC').all(athlete.id);
  const attrs = computeAttributesFromAssessments(rows);
  send(res, 200, { recommendations: getRecommendations(attrs, rows.length), attributes: attrs, testCount: rows.length });
});

route('GET', '/api/achievements', async (req, res, params, body, user) => {
  const athlete = getOrCreateAthlete(user.id);
  const rows = db.prepare('SELECT badge_code, earned_at FROM achievements WHERE athlete_id = ?').all(athlete.id);
  send(res, 200, { earned: rows.map(r => r.badge_code), all: BADGES.map(b => ({ id: b.id, name: b.name })) });
});

route('GET', '/api/exercises', async (req, res) => send(res, 200, { exercises: EXERCISE_INFO }));
route('GET', '/api/sports', async (req, res) => send(res, 200, { sports: SPORTS_INFO }));

route('GET', '/api/challenge/today', async (req, res, params, body, user) => {
  const athlete = getOrCreateAthlete(user.id);
  const challenge = getOrCreateDailyChallenge(athlete.id);
  send(res, 200, { challenge, wallet: { coins: athlete.coins || 0, diamonds: athlete.diamonds || 0, xp: athlete.xp || 0, level: athlete.level || 1 } });
});

route('PUT', '/api/talent', async (req, res, params, body, user) => {
  const athlete = getOrCreateAthlete(user.id);
  const { sport, data } = body;
  if (!sport || !data || typeof data !== 'object') return send(res, 400, { error: 'sport and data are required.' });
  const existing = db.prepare('SELECT id FROM talent_records WHERE athlete_id=? AND sport=?').get(athlete.id, sport);
  if (existing) db.prepare('UPDATE talent_records SET data_json=?, updated_at=? WHERE id=?').run(JSON.stringify(data), Date.now(), existing.id);
  else db.prepare('INSERT INTO talent_records (athlete_id, sport, data_json, updated_at) VALUES (?,?,?,?)').run(athlete.id, sport, JSON.stringify(data), Date.now());
  send(res, 200, { ok: true });
});

route('GET', '/api/talent', async (req, res, params, body, user) => {
  const athlete = getOrCreateAthlete(user.id);
  const rows = db.prepare('SELECT sport, data_json, updated_at FROM talent_records WHERE athlete_id=?').all(athlete.id);
  send(res, 200, { records: rows.map(r => ({ sport: r.sport, data: JSON.parse(r.data_json), updatedAt: r.updated_at })) });
});

route('POST', '/api/ask', async (req, res, params, body) => {
  const question = (body.question || '').trim();
  if (!question) return send(res, 400, { error: 'Ask a question first.' });
  if (question.length > 500) return send(res, 400, { error: 'Keep the question under 500 characters.' });
  try {
    const answer = await callGemini(question);
    send(res, 200, { answer, source: 'ai', provider: 'gemini' });
    return;
  } catch (e1) {
    if (e1.message !== 'NO_API_KEY') console.warn('Gemini call failed, falling back:', e1.message);
    try {
      const answer = await callAnthropic(question);
      send(res, 200, { answer, source: 'ai', provider: 'anthropic' });
      return;
    } catch (e2) {
      const fallback = keywordAnswer(question);
      if (fallback) send(res, 200, { answer: fallback, source: 'knowledge-base' });
      else send(res, 200, { answer: "Nothing specific on that in the knowledge hub yet — try naming a sport or exercise, e.g. \"How deep should I squat?\" or \"What positions are there in football?\"", source: 'none' });
    }
  }
});

route('GET', '/api/coach/athletes', async (req, res, params, body, user, query) => {
  if (user.role !== 'coach') return send(res, 403, { error: 'Coach account required. Sign up with the coach role to access this view.' });
  const coach = db.prepare('SELECT * FROM coaches WHERE user_id = ?').get(user.id);
  const isVerified = !!(coach && coach.verified);

  // Unverified coaches only ever see the labeled sample data — this is the
  // fix for the previous behavior where any account that signed up with
  // role='coach' could immediately read every opted-in real athlete's name
  // and location with zero verification.
  let rows = isVerified
    ? db.prepare('SELECT * FROM athletes WHERE coach_opt_in = 1').all()
    : db.prepare('SELECT * FROM athletes WHERE coach_opt_in = 1 AND is_demo = 1').all();

  const withScores = rows.map(a => {
    const assess = db.prepare('SELECT * FROM assessments WHERE athlete_id = ? ORDER BY created_at DESC').all(a.id);
    const attrs = computeAttributesFromAssessments(assess.slice().reverse());
    const overall = assess[0] ? Math.round(assess.reduce((s, x) => s + x.overall, 0) / assess.length) : null;
    const isMinor = a.age != null && a.age < MINOR_AGE;
    return {
      name: a.name || 'Unnamed athlete',
      // Minors get city/state-level location as already entered, but never
      // anything more precise, and their exact age is withheld — an age
      // band is enough for a coach's purposes.
      location: a.location,
      ageBand: a.age == null ? null : (isMinor ? 'Under 18' : (a.age < 25 ? '18–24' : '25+')),
      sport: a.preferred_sport,
      speed: attrs.speed, strength: attrs.strength, agility: attrs.agility, overall,
      isDemo: !!a.is_demo, isMinor,
    };
  }).filter(a => a.overall != null);
  const sportFilter = query.sport;
  const filtered = sportFilter ? withScores.filter(a => a.sport === sportFilter) : withScores;
  filtered.sort((a, b) => (b.overall || 0) - (a.overall || 0));
  send(res, 200, { athletes: filtered, coachVerified: isVerified });
});

route('POST', '/api/admin/verify-coach', async (req, res, params, body) => {
  // Deliberately separate from the normal auth system: verifying a coach is
  // an administrative action, not something a coach can grant themselves.
  // Protected by ADMIN_KEY (see startup log) rather than a user session.
  const key = req.headers['x-admin-key'];
  if (!key || key !== ADMIN_KEY) return send(res, 403, { error: 'Invalid admin key.' });
  const { email } = body;
  if (!email) return send(res, 400, { error: 'email is required.' });
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND role = ?').get(email.toLowerCase(), 'coach');
  if (!user) return send(res, 404, { error: 'No coach account with that email.' });
  db.prepare('UPDATE coaches SET verified = 1, verified_at = ? WHERE user_id = ?').run(Date.now(), user.id);
  send(res, 200, { ok: true, email: user.email, verified: true });
});

/* ============================= server ============================= */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(PUBLIC_DIR, decodeURIComponent(filePath.split('?')[0]));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

const PROTECTED_PREFIXES = ['/api/me', '/api/athlete', '/api/assessments', '/api/recommendations', '/api/achievements', '/api/coach', '/api/challenge', '/api/talent', '/api/leaderboard'];

const server = http.createServer(async (req, res) => {
  const [pathname, qs] = req.url.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));

  if (req.method === 'OPTIONS') return send(res, 204, {});

  if (!pathname.startsWith('/api/')) return serveStatic(req, res);

  const matched = routes.find(r => r.method === req.method && r.regex.test(pathname));
  if (!matched) return send(res, 404, { error: 'Not found' });

  const needsAuth = PROTECTED_PREFIXES.some(p => pathname.startsWith(p));
  let user = null;
  if (needsAuth) {
    user = authenticate(req);
    if (!user) return send(res, 401, { error: 'Please log in.' });
  }

  const m = matched.regex.exec(pathname);
  const params = {};
  matched.paramNames.forEach((name, i) => { params[name] = m[i + 1]; });

  let body = {};
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: 'Invalid JSON body.' }); }
  }

  try {
    await matched.handler(req, res, params, body, user, query);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Server error.' });
  }
});

server.listen(PORT, () => {
  console.log(`TalentTrack server running at http://localhost:${PORT}`);
  console.log(`Data is stored in ${path.join(__dirname, 'talenttrack.db')} and persists between restarts.`);
});
