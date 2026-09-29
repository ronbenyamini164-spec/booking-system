require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // חשוב מאחורי Render (כדי שזיהוי ה-IP ל-rate limit יעבוד נכון)

// ==========================================
// 🛡️ SECURITY MIDDLEWARES & CONFIGURATION
// ==========================================

// (1) Helmet — כותרות אבטחה בכל תגובה (כולל HSTS שמכריח HTTPS)
app.use(helmet({
  contentSecurityPolicy: false,          // מושבת כי הממשק משתמש ב-inline scripts + Chart.js CDN
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 15552000, includeSubDomains: true } // 180 יום — הדפדפן יזכור לגשת רק ב-HTTPS
}));

// (2) CORS — רשימת מקורות מותרים בלבד (לא "*" פתוח לכולם)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://booking-system-julq.onrender.com,http://localhost:3000')
  .split(',').map(s => s.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header("Access-Control-Allow-Origin", origin);
    res.header("Vary", "Origin");
  }
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static('public'));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "082719";

// (3) סוד לחתימת "כרטיס הכניסה" (טוקן). מומלץ מאוד להגדיר SESSION_SECRET ב-.env
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // תוקף הכניסה: 8 שעות

// (4) מפתח הצפנה לנתונים רגישים (ת"ז, 4 ספרות אשראי) — AES-256-GCM
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, 'hex')
  : crypto.scryptSync(SESSION_SECRET, 'field-encryption-salt', 32);
const IV_LENGTH = 16;

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  let enc = cipher.update(String(text), 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${enc}`;
}
function decrypt(text) {
  if (!text || !text.includes(':')) return text;
  try {
    const [ivHex, tagHex, enc] = text.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let dec = decipher.update(enc, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch (e) { return text; }
}

// (5) יצירת/אימות "כרטיס כניסה" חתום (מבנה דמוי-JWT, ללא תלות חיצונית)
function createToken() {
  const payload = { role: 'admin', exp: Date.now() + TOKEN_TTL_MS };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return false;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false; // חתימה זויפה
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return false; // פג תוקף
    return payload;
  } catch (e) { return false; }
}

// עזר קטן לקריאת קוקי בודד מתוך כותרת ה-Cookie (בלי חבילה חיצונית)
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  const found = raw.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return found ? decodeURIComponent(found.slice(name.length + 1)) : null;
}

// (6) שוער (Middleware) שחוסם כל נתיב /api/admin חוץ מהתחברות
function requireAuth(req, res, next) {
  // הטוקן נקרא מ-HttpOnly cookie (JavaScript בדפדפן לא יכול לגעת בו)
  const token = getCookie(req, 'admin_token');
  if (verifyToken(token)) return next();
  return res.status(401).json({ error: 'Unauthorized — please log in again' });
}

// (7) הגבלת קצב כללית + הגבלה מחמירה על ניסיונות התחברות (הגנה מפני ניחוש סיסמה)
const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 500, message: { error: 'Too many requests, try again later.' } });
app.use('/api/', apiLimiter);
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Please wait 15 minutes.' } });

const FIXED_SLOTS = [
  { start: '08:00', end: '09:00' }, { start: '09:15', end: '10:15' },
  { start: '10:30', end: '11:30' }, { start: '11:45', end: '12:45' },
  { start: '13:00', end: '14:00' }, { start: '14:15', end: '15:15' },
  { start: '16:15', end: '17:15' }, { start: '17:30', end: '18:30' },
  { start: '18:45', end: '19:45' }, { start: '20:00', end: '21:00' }
];

// ==========================================
// 🐘 DATABASE — כל המיגרציות אדיטיביות בלבד (לא מוחקות שום נתון)
// ==========================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS students (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        default_quota INTEGER DEFAULT 2,
        allowed_slots JSONB DEFAULT '[]',
        fixed_lessons JSONB DEFAULT '[]',
        default_time_range JSONB DEFAULT '{"start": "08:00", "end": "21:00"}'
      );
      CREATE TABLE IF NOT EXISTS appointments (
        id SERIAL PRIMARY KEY,
        day_index INTEGER NOT NULL,
        start_time VARCHAR(10) NOT NULL,
        end_time VARCHAR(10) NOT NULL,
        booked_by_name VARCHAR(100) NOT NULL,
        booked_by_phone VARCHAR(20),
        is_custom BOOLEAN DEFAULT FALSE,
        is_fixed BOOLEAN DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS weekly_student_config (
        student_name VARCHAR(100) PRIMARY KEY,
        quota_override INTEGER,
        allowed_slots_override JSONB,
        blocked_slots_override JSONB,
        allowed_custom_ranges JSONB DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS settings (key VARCHAR(50) PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS categories (id SERIAL PRIMARY KEY, type VARCHAR(50) NOT NULL, name VARCHAR(100) NOT NULL);
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY, invoice_number VARCHAR(50), student_name VARCHAR(100),
        invoice_date DATE, payment_method VARCHAR(50), amount_payed NUMERIC(10,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY, expense_date DATE, tr_name VARCHAR(200),
        category VARCHAR(100), amount NUMERIC(10,2) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS blocked_slots (
        id SERIAL PRIMARY KEY, day_index INTEGER NOT NULL, start_time VARCHAR(10) NOT NULL,
        end_time VARCHAR(10) NOT NULL, reason TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(day_index, start_time, end_time)
      );
      -- (8) יומן ביקורת: רישום כל פעולת מנהל רגישה
      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        action VARCHAR(100) NOT NULL,
        details TEXT,
        ip VARCHAR(60),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS is_custom BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS is_fixed BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS booked_by_phone VARCHAR(20);`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS allowed_slots JSONB DEFAULT '[]';`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS fixed_lessons JSONB DEFAULT '[]';`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS default_time_range JSONB DEFAULT '{"start": "08:00", "end": "21:00"}';`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS phone VARCHAR(20);`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS email VARCHAR(100);`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS course_type VARCHAR(50);`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS total_amount NUMERIC(10,2) DEFAULT 0;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS total_lessons INT DEFAULT 0;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS completed_lessons INT DEFAULT 0;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS process_duration_months INT DEFAULT 1;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS start_date DATE;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS validity_expiration_date DATE;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS is_past_student BOOLEAN DEFAULT FALSE;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS id_number_encrypted TEXT;`);
    await pool.query(`ALTER TABLE weekly_student_config ADD COLUMN IF NOT EXISTS allowed_slots_override JSONB;`);
    await pool.query(`ALTER TABLE weekly_student_config ADD COLUMN IF NOT EXISTS allowed_custom_ranges JSONB DEFAULT '[]';`);

    const defaults = [
      ["is_open", "true"], ["open_mode", "all"], ["allowed_students", "[]"],
      ["sunday_date", ""], ["default_global_blocked_slots", "[]"], ["weekly_global_blocked_slots", "[]"]
    ];
    for (const [k, v] of defaults) {
      const check = await pool.query("SELECT * FROM settings WHERE key = $1", [k]);
      if (check.rows.length === 0) await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2)", [k, v]);
    }
    console.log('🚀 Database initialized & migrated successfully (non-destructive)!');
  } catch (err) { console.error('❌ Error initializing database:', err); }
}
initDb();

// יומן ביקורת — fire-and-forget, לעולם לא מפיל בקשה
async function logAction(req, action, details) {
  try {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim();
    await pool.query('INSERT INTO audit_log (action, details, ip) VALUES ($1, $2, $3)', [action, details || null, ip]);
  } catch (e) { /* מתעלמים בשקט */ }
}

function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function calculateDatesFromSunday(sundayDateStr) {
  const daysNames = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי'];
  if (!sundayDateStr) return daysNames.map((name, index) => ({ index, name, date: '', isoDate: '' }));
  const [year, month, day] = sundayDateStr.split('-').map(Number);
  const baseSunday = new Date(year, month - 1, day);
  return daysNames.map((name, index) => {
    const d = new Date(baseSunday); d.setDate(baseSunday.getDate() + index);
    const isoDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const formattedDate = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    return { index, name, date: formattedDate, isoDate };
  });
}

// ==========================================
// 🔐 AUTH — התחברות (מוגן ב-rate limit מחמיר + השוואת סיסמה בזמן קבוע)
// ==========================================
app.post('/api/admin/login', loginLimiter, async (req, res) => {
  const provided = crypto.createHash('sha256').update(String(req.body.password || '')).digest();
  const actual = crypto.createHash('sha256').update(String(ADMIN_PASSWORD)).digest();
  const ok = provided.length === actual.length && crypto.timingSafeEqual(provided, actual);
  if (ok) {
    await logAction(req, 'LOGIN_SUCCESS', null);
    // secure=true רק ב-HTTPS (פרודקשן). ב-localhost נשאר false כדי שההתחברות המקומית תעבוד.
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.cookie('admin_token', createToken(), {
      httpOnly: true,        // לא נגיש ל-JavaScript — מגן מפני גניבת טוקן (XSS)
      secure: isSecure,      // נשלח רק ב-HTTPS בפרודקשן
      sameSite: 'strict',    // לא נשלח מאתרים אחרים
      maxAge: TOKEN_TTL_MS   // תוקף זהה לטוקן (8 שעות)
    });
    return res.json({ success: true });
  }
  await logAction(req, 'LOGIN_FAILED', null);
  return res.status(401).json({ error: 'סיסמה שגויה' });
});

// (השוער) — כל /api/admin/* מוגן, חוץ מ-/login
app.use('/api/admin', (req, res, next) => {
  if (req.path === '/login') return next();
  return requireAuth(req, res, next);
});

// בדיקת תקינות טוקן (הממשק קורא לזה כדי לדעת אם עדיין מחוברים)
app.get('/api/admin/verify', (req, res) => res.json({ success: true }));

// התנתקות — מוחק את קוקי הטוקן בשרת
app.post('/api/admin/logout', async (req, res) => {
  await logAction(req, 'LOGOUT', null);
  res.clearCookie('admin_token');
  return res.json({ success: true });
});

// ==========================================
// 📅 STUDENT BOOKING (PUBLIC) — פתוח לתלמידים, ללא צורך בטוקן
// ==========================================
app.get('/api/slots', async (req, res) => {
  try {
    const studentName = req.query.studentName ? req.query.studentName.trim() : null;
    const settingsRes = await pool.query("SELECT * FROM settings");
    const settings = {}; settingsRes.rows.forEach(s => settings[s.key] = s.value);
    const isOpen = settings.is_open === 'true';
    const openMode = settings.open_mode || 'all';
    const allowedStudentsList = JSON.parse(settings.allowed_students || '[]');
    const sundayDate = settings.sunday_date || '';
    const defaultGlobalBlocked = JSON.parse(settings.default_global_blocked_slots || '[]');
    const weeklyGlobalBlocked = JSON.parse(settings.weekly_global_blocked_slots || '[]');
    const allGlobalBlocked = Array.from(new Set([...defaultGlobalBlocked, ...weeklyGlobalBlocked]));
    let isStudentAllowedToBook = isOpen;
    if (studentName) {
      if (openMode === 'none') isStudentAllowedToBook = false;
      else if (openMode === 'specific') isStudentAllowedToBook = allowedStudentsList.includes(studentName);
    }
    const appsRes = await pool.query("SELECT * FROM appointments ORDER BY day_index, start_time");
    const days = calculateDatesFromSunday(sundayDate);
    let studentData = null;
    if (studentName) {
      const studentRes = await pool.query("SELECT * FROM students WHERE name = $1", [studentName]);
      if (studentRes.rows.length > 0) {
        const s = studentRes.rows[0];
        const configRes = await pool.query("SELECT * FROM weekly_student_config WHERE student_name = $1", [studentName]);
        const config = configRes.rows[0] || {};
        const effectiveQuota = (config.quota_override !== null && config.quota_override !== undefined) ? config.quota_override : s.default_quota;
        const currentBookings = appsRes.rows.filter(a => a.booked_by_name === studentName).length;
        studentData = {
          name: s.name, effectiveQuota, currentBookings,
          remainingQuota: Math.max(0, effectiveQuota - currentBookings),
          blockedSlots: config.blocked_slots_override || [],
          defaultTimeRange: s.default_time_range || { start: "08:00", end: "21:00" },
          allowedCustomRanges: config.allowed_custom_ranges || []
        };
      }
    }
    res.json({ isOpen, openMode, allowedStudentsList, isStudentAllowedToBook, fixedSlots: FIXED_SLOTS, sundayDate, days, appointments: appsRes.rows, defaultGlobalBlocked, weeklyGlobalBlocked, allGlobalBlocked, studentData });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/book', async (req, res) => {
  try {
    const { studentName, slots } = req.body;
    if (!studentName || !slots || !Array.isArray(slots) || slots.length === 0)
      return res.status(400).json({ error: 'נא להזין שם תלמיד ולבחור לפחות שיעור אחד' });
    const trimmedName = studentName.trim();
    const studentRes = await pool.query("SELECT * FROM students WHERE name = $1", [trimmedName]);
    if (studentRes.rows.length === 0) return res.status(404).json({ error: 'תלמיד לא נמצא במערכת' });
    const settingsRes = await pool.query("SELECT * FROM settings");
    const settings = {}; settingsRes.rows.forEach(s => settings[s.key] = s.value);
    const isOpen = settings.is_open === 'true';
    const openMode = settings.open_mode || 'all';
    const allowedStudentsList = JSON.parse(settings.allowed_students || '[]');
    let isAllowed = isOpen;
    if (openMode === 'none') isAllowed = false;
    if (openMode === 'specific') isAllowed = allowedStudentsList.includes(trimmedName);
    if (!isAllowed) return res.status(403).json({ error: 'ההרשמה סגורה עבורך כרגע' });
    const configRes = await pool.query("SELECT * FROM weekly_student_config WHERE student_name = $1", [trimmedName]);
    const config = configRes.rows[0] || {};
    const quota = (config.quota_override !== null && config.quota_override !== undefined) ? config.quota_override : studentRes.rows[0].default_quota;
    const currentBookingsRes = await pool.query("SELECT * FROM appointments WHERE booked_by_name = $1", [trimmedName]);
    if (currentBookingsRes.rows.length + slots.length > quota)
      return res.status(400).json({ error: `כבר רשומים עבורך ${currentBookingsRes.rows.length} שיעורים. מכסת השיעורים שלך לשבוע זה היא ${quota}.` });
    const allApps = (await pool.query("SELECT * FROM appointments")).rows;
    for (let slot of slots) {
      const startMins = timeToMinutes(slot.startTime), endMins = timeToMinutes(slot.endTime);
      const conflict = allApps.some(app => app.day_index === slot.dayIndex && startMins < timeToMinutes(app.end_time) && endMins > timeToMinutes(app.start_time));
      if (conflict) return res.status(400).json({ error: `המשבצת ${slot.startTime} ביום ${slot.dayName || ''} חופפת לשיעור קיים ביומן.` });
    }
    for (let slot of slots)
      await pool.query(`INSERT INTO appointments (day_index, start_time, end_time, booked_by_name, is_custom, is_fixed) VALUES ($1,$2,$3,$4,FALSE,FALSE)`, [slot.dayIndex, slot.startTime, slot.endTime, trimmedName]);
    res.json({ success: true, message: 'השיעור/ים שובצו בהצלחה!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 📅 ADMIN — CALENDAR CONTROLS (מוגן ע"י השוער)
// ==========================================
app.get('/api/admin/blocked-slots', async (req, res) => {
  try { res.json({ blockedSlots: (await pool.query('SELECT * FROM blocked_slots ORDER BY day_index, start_time')).rows }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/blocked-slots', async (req, res) => {
  try {
    const { dayIndex, startTime, endTime, reason } = req.body;
    const r = await pool.query(`INSERT INTO blocked_slots (day_index, start_time, end_time, reason) VALUES ($1,$2,$3,$4) ON CONFLICT (day_index, start_time, end_time) DO UPDATE SET reason = EXCLUDED.reason RETURNING *;`, [Number(dayIndex), startTime, endTime, reason || 'Blocked by Admin']);
    await logAction(req, 'BLOCK_SLOT', `day ${dayIndex} ${startTime}-${endTime}`);
    res.json({ success: true, slot: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/blocked-slots/delete', async (req, res) => {
  try { await pool.query('DELETE FROM blocked_slots WHERE id = $1', [req.body.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/book-direct', async (req, res) => {
  try {
    const { dayIndex, startTime, endTime, studentName } = req.body;
    if (dayIndex === undefined || !startTime || !endTime || !studentName) return res.status(400).json({ error: 'שדות חובה חסרים' });
    await pool.query(`INSERT INTO appointments (day_index, start_time, end_time, booked_by_name, is_custom, is_fixed) VALUES ($1,$2,$3,$4,TRUE,FALSE)`, [Number(dayIndex), startTime, endTime, studentName]);
    await logAction(req, 'BOOK_DIRECT', `${studentName} day ${dayIndex} ${startTime}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/history-appointments', async (req, res) => {
  try {
    const sr = await pool.query("SELECT value FROM settings WHERE key = 'sunday_date'");
    const sundayDate = sr.rows[0] ? sr.rows[0].value : '';
    let base = null;
    if (sundayDate) { const [y, m, d] = sundayDate.split('-').map(Number); base = new Date(y, m - 1, d); }
    const rows = (await pool.query("SELECT * FROM appointments ORDER BY day_index, start_time")).rows;
    const appointments = rows.map(a => {
      let appointment_date = null;
      if (base) { const dt = new Date(base); dt.setDate(base.getDate() + a.day_index); appointment_date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; }
      return { ...a, appointment_date };
    });
    res.json({ appointments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/reset-slots', async (req, res) => {
  try {
    const { sundayDate, applyFixedLessons } = req.body;
    await pool.query("DELETE FROM appointments");
    await pool.query("DELETE FROM weekly_student_config");
    await pool.query("UPDATE settings SET value = $1 WHERE key = 'weekly_global_blocked_slots'", ["[]"]);
    await pool.query("UPDATE settings SET value = $1 WHERE key = 'sunday_date'", [sundayDate || '']);
    if (applyFixedLessons) {
      for (let s of (await pool.query("SELECT * FROM students")).rows)
        for (let f of (s.fixed_lessons || []))
          await pool.query(`INSERT INTO appointments (day_index, start_time, end_time, booked_by_name, is_custom, is_fixed) VALUES ($1,$2,$3,$4,$5,TRUE)`, [f.dayIndex, f.startTime, f.endTime, s.name, f.isCustom || false]);
    }
    await logAction(req, 'RESET_WEEK', `sunday ${sundayDate}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/delete-appointment', async (req, res) => {
  try { await pool.query("DELETE FROM appointments WHERE id = $1", [req.body.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/global-blocks/save', async (req, res) => {
  try {
    const { defaultGlobalBlocked, weeklyGlobalBlocked } = req.body;
    if (defaultGlobalBlocked !== undefined) await pool.query("UPDATE settings SET value = $1 WHERE key = 'default_global_blocked_slots'", [JSON.stringify(defaultGlobalBlocked)]);
    if (weeklyGlobalBlocked !== undefined) await pool.query("UPDATE settings SET value = $1 WHERE key = 'weekly_global_blocked_slots'", [JSON.stringify(weeklyGlobalBlocked)]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/toggle-status', async (req, res) => {
  try {
    const { isOpen, openMode, allowedStudents } = req.body;
    await pool.query("UPDATE settings SET value = $1 WHERE key = 'is_open'", [isOpen ? 'true' : 'false']);
    await pool.query("UPDATE settings SET value = $1 WHERE key = 'open_mode'", [openMode || 'all']);
    await pool.query("UPDATE settings SET value = $1 WHERE key = 'allowed_students'", [JSON.stringify(allowedStudents || [])]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/export-ical', async (req, res) => {
  try {
    const sr = await pool.query("SELECT * FROM settings");
    const settings = {}; sr.rows.forEach(s => settings[s.key] = s.value);
    if (!settings.sunday_date) return res.status(400).send('טרם הוגדר תאריך ליום ראשון.');
    const apps = (await pool.query("SELECT * FROM appointments")).rows;
    const [year, month, day] = settings.sunday_date.split('-').map(Number);
    const baseSunday = new Date(year, month - 1, day);
    let ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BookingSystem//HE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
    apps.forEach(app => {
      const d = new Date(baseSunday); d.setDate(baseSunday.getDate() + app.day_index);
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), da = String(d.getDate()).padStart(2, '0');
      const [sH, sM] = app.start_time.split(':'), [eH, eM] = app.end_time.split(':');
      ics.push('BEGIN:VEVENT', `SUMMARY:שיעור - ${app.booked_by_name}`, `DTSTART:${y}${m}${da}T${sH}${sM}00`, `DTEND:${y}${m}${da}T${eH}${eM}00`, 'END:VEVENT');
    });
    ics.push('END:VCALENDAR');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="weekly_schedule.ics"');
    res.send(ics.join('\r\n'));
  } catch (err) { res.status(500).send('Error generating iCal'); }
});

// ==========================================
// 🎓 ADMIN — STUDENTS
// ==========================================
app.get('/api/admin/students-full', async (req, res) => {
  try {
    const rows = (await pool.query('SELECT * FROM students ORDER BY name ASC')).rows
      .map(s => { const { id_number_encrypted, ...rest } = s; return { ...rest, id_number: decrypt(id_number_encrypted) }; });
    res.json({ students: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/students-full/save', async (req, res) => {
  try {
    const { id, name, phone, email, course_type, default_quota, total_amount, total_lessons, process_duration_months, start_date, is_past_student, id_number } = req.body;
    if (!name) return res.status(400).json({ error: 'Student Name is required' });
    let expDate = null;
    if (process_duration_months) {
      const dm = Number(process_duration_months), vm = dm * 1.25;
      const sd = start_date ? new Date(start_date) : new Date();
      const eo = new Date(sd); eo.setMonth(eo.getMonth() + Math.floor(vm)); eo.setDate(eo.getDate() + Math.round((vm % 1) * 30));
      expDate = eo.toISOString().split('T')[0];
    }
    const encId = id_number ? encrypt(id_number) : null;
    if (id) {
      await pool.query(`UPDATE students SET name=$1, phone=$2, email=$3, course_type=$4, default_quota=$5, total_amount=$6, total_lessons=$7, process_duration_months=$8, start_date=$9, is_past_student=$10, validity_expiration_date=$11, id_number_encrypted=COALESCE($12, id_number_encrypted) WHERE id=$13`,
        [name.trim(), phone || null, email || null, course_type || null, default_quota || 2, total_amount || 0, total_lessons || 0, process_duration_months || 1, start_date || null, is_past_student === true, expDate, encId, id]);
    } else {
      await pool.query(`INSERT INTO students (name, phone, email, course_type, default_quota, total_amount, total_lessons, process_duration_months, start_date, is_past_student, validity_expiration_date, id_number_encrypted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (name) DO UPDATE SET phone=EXCLUDED.phone, email=EXCLUDED.email, course_type=EXCLUDED.course_type, default_quota=EXCLUDED.default_quota, total_amount=EXCLUDED.total_amount, total_lessons=EXCLUDED.total_lessons, process_duration_months=EXCLUDED.process_duration_months, start_date=EXCLUDED.start_date, is_past_student=EXCLUDED.is_past_student, validity_expiration_date=EXCLUDED.validity_expiration_date, id_number_encrypted=COALESCE(EXCLUDED.id_number_encrypted, students.id_number_encrypted)`,
        [name.trim(), phone || null, email || null, course_type || null, default_quota || 2, total_amount || 0, total_lessons || 0, process_duration_months || 1, start_date || null, is_past_student === true, expDate, encId]);
    }
    await logAction(req, id ? 'STUDENT_UPDATE' : 'STUDENT_CREATE', name);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/students/delete', async (req, res) => {
  try {
    const sr = await pool.query("SELECT name FROM students WHERE id = $1", [req.body.id]);
    if (sr.rows.length > 0) {
      const n = sr.rows[0].name;
      await pool.query("DELETE FROM appointments WHERE booked_by_name = $1", [n]);
      await pool.query("DELETE FROM weekly_student_config WHERE student_name = $1", [n]);
    }
    await pool.query("DELETE FROM students WHERE id = $1", [req.body.id]);
    await logAction(req, 'STUDENT_DELETE', String(req.body.id));
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/students/weekly-override', async (req, res) => {
  try {
    const { student_name, quota_override, blocked_slots_override, allowed_custom_ranges } = req.body;
    await pool.query(`INSERT INTO weekly_student_config (student_name, quota_override, blocked_slots_override, allowed_custom_ranges) VALUES ($1,$2,$3,$4) ON CONFLICT (student_name) DO UPDATE SET quota_override=EXCLUDED.quota_override, blocked_slots_override=EXCLUDED.blocked_slots_override, allowed_custom_ranges=EXCLUDED.allowed_custom_ranges`, [student_name, quota_override, JSON.stringify(blocked_slots_override || []), JSON.stringify(allowed_custom_ranges || [])]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 🏷️ CATEGORIES / 💵 INVOICES / 💸 EXPENSES
// ==========================================
app.get('/api/admin/categories', async (req, res) => {
  try { res.json({ categories: (await pool.query('SELECT * FROM categories ORDER BY id ASC')).rows }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/categories/add', async (req, res) => {
  try {
    const { type, name } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'Type and name required' });
    await pool.query('INSERT INTO categories (type, name) VALUES ($1, $2)', [type, name]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/categories/delete', async (req, res) => {
  try { await pool.query('DELETE FROM categories WHERE id = $1', [req.body.id]); res.json({ success: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/invoices', async (req, res) => {
  try { res.json({ invoices: (await pool.query('SELECT * FROM invoices ORDER BY invoice_date DESC NULLS LAST, id DESC')).rows }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/invoices/save', async (req, res) => {
  try {
    const { invoice_number, student_name, invoice_date, payment_method, amount_payed } = req.body;
    await pool.query(`INSERT INTO invoices (invoice_number, student_name, invoice_date, payment_method, amount_payed) VALUES ($1,$2,$3,$4,$5)`, [invoice_number || null, student_name || null, invoice_date || null, payment_method || null, amount_payed || 0]);
    await logAction(req, 'INVOICE_CREATE', `${student_name} ₪${amount_payed}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/admin/expenses', async (req, res) => {
  try { res.json({ expenses: (await pool.query('SELECT * FROM expenses ORDER BY expense_date DESC NULLS LAST, id DESC')).rows }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.post('/api/admin/expenses/save', async (req, res) => {
  try {
    const { expense_date, tr_name, category, amount } = req.body;
    await pool.query(`INSERT INTO expenses (expense_date, tr_name, category, amount) VALUES ($1,$2,$3,$4)`, [expense_date || null, tr_name || null, category || null, amount || 0]);
    await logAction(req, 'EXPENSE_CREATE', `${tr_name} ₪${amount}`);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// יומן הביקורת — צפייה (מוגן)
app.get('/api/admin/audit-log', async (req, res) => {
  try { res.json({ log: (await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200')).rows }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Secure Server running on port ${PORT}`));
