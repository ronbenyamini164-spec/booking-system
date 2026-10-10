require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

// (#6) תאימות גרסאות Node: fetch גלובלי קיים רק מ-Node 18 ומעלה.
// על גרסה ישנה יותר נטען node-fetch כ-fallback; אם גם הוא לא מותקן — getUsdIlsRate ייפול בחן לשער שמור/ברירת מחדל.
if (typeof fetch === 'undefined') {
 try { global.fetch = require('node-fetch'); }
 catch (e) { console.warn('⚠️ global fetch unavailable and node-fetch not installed — USD→ILS rates will fall back to cached/default values.'); }
}

const app = express();
app.set('trust proxy', 1); // חשוב מאחורי Render (כדי שזיהוי ה-IP ל-rate limit יעבוד נכון)

// ==========================================
// 🛡️ SECURITY MIDDLEWARES & CONFIGURATION
// ==========================================

// (1) Helmet — כותרות אבטחה בכל תגובה (כולל HSTS שמכריח HTTPS)
app.use(helmet({
 contentSecurityPolicy: false, // מושבת כי הממשק משתמש ב-inline scripts + Chart.js CDN
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
 CREATE TABLE IF NOT EXISTS categories (id SERIAL PRIMARY KEY, type VARCHAR(50) NOT NULL, name VARCHAR(100) NOT NULL, color VARCHAR(20) DEFAULT '#64748b');
 ALTER TABLE categories ADD COLUMN IF NOT EXISTS color VARCHAR(20) DEFAULT '#64748b';
 ALTER TABLE categories ADD COLUMN IF NOT EXISTS text_color VARCHAR(20) DEFAULT '#ffffff';
 CREATE TABLE IF NOT EXISTS invoices (
 id SERIAL PRIMARY KEY,
 invoice_number VARCHAR(50), student_name VARCHAR(100),
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
 -- (9) תשלומים / פריסת תשלומים חודשית (עם דריסת מנהל ידנית)
 CREATE TABLE IF NOT EXISTS payments (
 id SERIAL PRIMARY KEY,
 student_name VARCHAR(100) NOT NULL,
 installment_number INTEGER NOT NULL,
 total_installments INTEGER NOT NULL,
 amount NUMERIC(10,2) DEFAULT 0,
 due_date DATE,
 status VARCHAR(20) DEFAULT 'pending',
 paid_date DATE,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 );
 -- (5) הוצאות חוזרות: שבועי/חודשי/שנתי — מוזרקות אוטומטית לטבלת expenses
 CREATE TABLE IF NOT EXISTS recurring_expenses (
 id SERIAL PRIMARY KEY,
 tr_name VARCHAR(200),
 category VARCHAR(100),
 amount NUMERIC(10,2) DEFAULT 0,
 currency VARCHAR(10) DEFAULT 'ILS',
 payment_method VARCHAR(50),
 frequency VARCHAR(10) NOT NULL,
 start_date DATE NOT NULL,
 next_run DATE NOT NULL,
 active BOOLEAN DEFAULT TRUE,
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 );
 -- (8) יומן ביקורת: רישום כל פעולת מנהל רגישה
 CREATE TABLE IF NOT EXISTS audit_log (
 id SERIAL PRIMARY KEY,
 action VARCHAR(100) NOT NULL,
 details TEXT,
 ip VARCHAR(60),
 created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 );
 CREATE TABLE IF NOT EXISTS deleted_records (
 id SERIAL PRIMARY KEY,
 entity_type VARCHAR(50) NOT NULL,
 original_id INTEGER,
 data JSONB,
 deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 );
 `);

 // (10) היסטוריית שיעורים — ארכיון קבוע של שבועות שהסתיימו (נשמר ב-Reset Week, אדיטיבי)
 await pool.query(`CREATE TABLE IF NOT EXISTS appointments_history (
 id SERIAL PRIMARY KEY,
 day_index INTEGER,
 start_time VARCHAR(10),
 end_time VARCHAR(10),
 booked_by_name VARCHAR(100),
 is_custom BOOLEAN DEFAULT FALSE,
 is_fixed BOOLEAN DEFAULT FALSE,
 appointment_date DATE,
 week_sunday DATE,
 archived_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 );`);

 await pool.query(`CREATE TABLE IF NOT EXISTS alert_prefs (alert_key TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'visible', updated_at TIMESTAMPTZ DEFAULT NOW());`);
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
 await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_refund BOOLEAN DEFAULT FALSE;`);
 await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS period_covered VARCHAR(50);`);
 await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reference_number VARCHAR(100);`);
 await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS transaction_id VARCHAR(100);`);
 await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes TEXT;`);
 await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_number INTEGER;`);
 await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method VARCHAR(50);`);
 await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS invoice_received VARCHAR(10);`);
 await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS file_link TEXT;`);
 await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS notes TEXT;`);
 await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS currency VARCHAR(3) DEFAULT 'ILS';`);
 await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS amount_original NUMERIC(12,2);`);
 await pool.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS fx_rate NUMERIC(12,6) DEFAULT 1;`);
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
 httpOnly: true, // לא נגיש ל-JavaScript — מגן מפני גניבת טוקן (XSS)
 secure: isSecure, // נשלח רק ב-HTTPS בפרודקשן
 sameSite: 'strict', // לא נשלח מאתרים אחרים
 maxAge: TOKEN_TTL_MS // תוקף זהה לטוקן (8 שעות)
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
 // כולל גם את החסימות החד-פעמיות מטבלת blocked_slots, כדי שדף התלמידים יציג אותן ויאכוף אותן
 const allGlobalBlocked = await getAllBlockedKeys();
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
 allowedCustomRanges: config.allowed_custom_ranges || [],
 // (1) סלוטים מותרים אפקטיביים: דריסת השבוע אם הוגדרה, אחרת ברירת המחדל של התלמיד
 allowedSlots: deriveAllowedSlots(s, config.allowed_slots_override)
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
 // (1) אכיפת סלוטים מותרים: דריסת השבוע אם קיימת, אחרת ברירת המחדל של התלמיד.
 // כשהרשימה ריקה — לא אוכפים (התנהגות קיימת נשמרת, אין איבוד גמישות).
 const effectiveAllowed = deriveAllowedSlots(studentRes.rows[0], config.allowed_slots_override);
 if (effectiveAllowed.length > 0) {
 for (let slot of slots) {
 const key = `${slot.startTime} - ${slot.endTime}`;
 if (!effectiveAllowed.includes(key)) return res.status(400).json({ error: `המשבצת ${slot.startTime} אינה מאושרת עבורך לשבוע זה.` });
 }
 }
 // אכיפת חסימה: תלמיד לא יכול להזמין סלוט חסום (חד-פעמי או קבוע)
 const blockedKeysStu = await getAllBlockedKeys();
 for (let slot of slots) {
 if (blockedKeysStu.includes(`${Number(slot.dayIndex)}_${slot.startTime}`))
 return res.status(400).json({ error: `המשבצת ${slot.startTime} חסומה ואינה זמינה להזמנה.` });
 }
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

// 🗑️ ארכוב כל רשומה שנמחקת לטבלת deleted_records (לא מוחק מידע סופית — נשמר ב-DB)
async function archiveDeleted(entityType, rows) {
 try {
 const list = Array.isArray(rows) ? rows : [rows];
 for (const row of list) {
 if (!row) continue;
 await pool.query('INSERT INTO deleted_records (entity_type, original_id, data) VALUES ($1, $2, $3)', [entityType, (row.id != null ? row.id : null), JSON.stringify(row)]);
 }
 } catch (e) { console.error('archiveDeleted failed:', e.message); }
}

app.post('/api/admin/blocked-slots/delete', async (req, res) => {
 try {
 const r = await pool.query('SELECT * FROM blocked_slots WHERE id = $1', [req.body.id]);
 await archiveDeleted('blocked_slots', r.rows);
 await pool.query('DELETE FROM blocked_slots WHERE id = $1', [req.body.id]);
 res.json({ success: true });
 }
 catch (err) { res.status(500).json({ error: err.message }); }
});

// 🔁 חסימה קבועה (כל שבוע עד ביטול) — נשמרת ב-settings.default_global_blocked_slots ולא מתאפסת ב-Reset Week
async function getRecurringBlocks() {
 const r = await pool.query("SELECT value FROM settings WHERE key = 'default_global_blocked_slots'");
 try { return JSON.parse((r.rows[0] && r.rows[0].value) || '[]'); } catch { return []; }
}

async function saveRecurringBlocks(list) {
 await pool.query("UPDATE settings SET value = $1 WHERE key = 'default_global_blocked_slots'", [JSON.stringify(list || [])]);
}

// כל מפתחות החסימה המאוחדים בפורמט "<dayIndex>_<startTime>": חסימה קבועה (settings) + חסימה שבועית (settings) + חסימות חד-פעמיות (טבלת blocked_slots)
async function getAllBlockedKeys() {
 const sres = await pool.query("SELECT key, value FROM settings WHERE key IN ('default_global_blocked_slots','weekly_global_blocked_slots')");
 let keys = [];
 for (const row of sres.rows) { try { const arr = JSON.parse(row.value || '[]'); if (Array.isArray(arr)) keys.push(...arr); } catch {} }
 const table = (await pool.query('SELECT day_index, start_time FROM blocked_slots')).rows.map(b => `${b.day_index}_${b.start_time}`);
 return Array.from(new Set([...keys, ...table]));
}

app.post('/api/admin/recurring-block/add', async (req, res) => {
 try {
 const { dayIndex, startTime, endTime } = req.body;
 if (dayIndex === undefined || !startTime || !endTime) return res.status(400).json({ error: 'שדות חובה חסרים' });
 const list = await getRecurringBlocks();
 const key = `${Number(dayIndex)}_${startTime}`;
 if (!list.includes(key)) list.push(key);
 await saveRecurringBlocks(list);
 await logAction(req, 'RECURRING_BLOCK_ADD', `day ${dayIndex} ${startTime}-${endTime}`);
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/recurring-block/remove', async (req, res) => {
 try {
 const { dayIndex, startTime } = req.body;
 let list = await getRecurringBlocks();
 const key = `${Number(dayIndex)}_${startTime}`;
 list = list.filter(k => k !== key);
 await saveRecurringBlocks(list);
 await logAction(req, 'RECURRING_BLOCK_REMOVE', `day ${dayIndex} ${startTime}`);
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/book-direct', async (req, res) => {
 try {
 const { dayIndex, startTime, endTime, studentName } = req.body;
 if (dayIndex === undefined || !startTime || !endTime || !studentName) return res.status(400).json({ error: 'שדות חובה חסרים' });
 const blockedKeys = await getAllBlockedKeys();
 if (blockedKeys.includes(`${Number(dayIndex)}_${startTime}`))
 return res.status(400).json({ error: 'המשבצת חסומה ואינה זמינה.' });
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
 const current = (await pool.query("SELECT * FROM appointments ORDER BY day_index, start_time")).rows.map(a => {
 let appointment_date = null;
 if (base) { const dt = new Date(base); dt.setDate(base.getDate() + a.day_index); appointment_date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; }
 return { ...a, appointment_date };
 });
 const archived = (await pool.query("SELECT * FROM appointments_history")).rows.map(a => ({
 ...a,
 appointment_date: a.appointment_date
 ? (a.appointment_date instanceof Date
 ? `${a.appointment_date.getFullYear()}-${String(a.appointment_date.getMonth() + 1).padStart(2, '0')}-${String(a.appointment_date.getDate()).padStart(2, '0')}`
 : String(a.appointment_date).slice(0, 10))
 : null
 }));
 const appointments = [...current, ...archived].sort((x, y) => {
 const dx = x.appointment_date || '', dy = y.appointment_date || '';
 if (dx !== dy) return dx < dy ? 1 : -1;
 return x.start_time < y.start_time ? -1 : x.start_time > y.start_time ? 1 : 0;
 });
 res.json({ appointments });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reset-slots', async (req, res) => {
 try {
 const { sundayDate, applyFixedLessons } = req.body;
 const prevSundayRes = await pool.query("SELECT value FROM settings WHERE key = 'sunday_date'");
 const prevSunday = prevSundayRes.rows[0] ? prevSundayRes.rows[0].value : '';
 if (prevSunday) {
 const [py, pm, pd] = prevSunday.split('-').map(Number);
 const prevBase = new Date(py, pm - 1, pd);
 const toArchive = (await pool.query("SELECT * FROM appointments")).rows;
 for (const a of toArchive) {
 const dt = new Date(prevBase); dt.setDate(prevBase.getDate() + a.day_index);
 const apptDate = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
 await pool.query(`INSERT INTO appointments_history (day_index, start_time, end_time, booked_by_name, is_custom, is_fixed, appointment_date, week_sunday) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
 [a.day_index, a.start_time, a.end_time, a.booked_by_name, a.is_custom, a.is_fixed, apptDate, prevSunday]);
 }
 }
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
 const { id, name, phone, email, course_type, default_quota, total_amount, total_lessons, completed_lessons, process_duration_months, start_date, is_past_student, validity_expiration_date, id_number, allowed_slots, fixed_lessons } = req.body;
 if (!name) return res.status(400).json({ error: 'Student Name is required' });
 let expDate = null;
 if (validity_expiration_date) {
 expDate = validity_expiration_date;
 } else if (process_duration_months) {
 const dm = Number(process_duration_months), vm = dm * 1.25;
 const sd = start_date ? new Date(start_date) : new Date();
 const eo = new Date(sd); eo.setMonth(eo.getMonth() + Math.floor(vm)); eo.setDate(eo.getDate() + Math.round((vm % 1) * 30));
 expDate = eo.toISOString().split('T')[0];
 }
 const encId = id_number ? encrypt(id_number) : null;
 if (id) {
 await pool.query(`UPDATE students SET name=$1, phone=$2, email=$3, course_type=$4, default_quota=$5, total_amount=$6, total_lessons=$7, completed_lessons=$8, process_duration_months=$9, start_date=$10, is_past_student=$11, validity_expiration_date=$12, id_number_encrypted=COALESCE($13, id_number_encrypted) WHERE id=$14`,
 [name.trim(), phone || null, email || null, course_type || null, default_quota || 2, total_amount || 0, total_lessons || 0, completed_lessons || 0, process_duration_months || 1, start_date || null, is_past_student === true, expDate, encId, id]);
 } else {
 await pool.query(`INSERT INTO students (name, phone, email, course_type, default_quota, total_amount, total_lessons, completed_lessons, process_duration_months, start_date, is_past_student, validity_expiration_date, id_number_encrypted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (name) DO UPDATE SET phone=EXCLUDED.phone, email=EXCLUDED.email, course_type=EXCLUDED.course_type, default_quota=EXCLUDED.default_quota, total_amount=EXCLUDED.total_amount, total_lessons=EXCLUDED.total_lessons, completed_lessons=EXCLUDED.completed_lessons, process_duration_months=EXCLUDED.process_duration_months, start_date=EXCLUDED.start_date, is_past_student=EXCLUDED.is_past_student, validity_expiration_date=EXCLUDED.validity_expiration_date, id_number_encrypted=COALESCE(EXCLUDED.id_number_encrypted, students.id_number_encrypted)`,
 [name.trim(), phone || null, email || null, course_type || null, default_quota || 2, total_amount || 0, total_lessons || 0, completed_lessons || 0, process_duration_months || 1, start_date || null, is_past_student === true, expDate, encId]);
 }
 if (allowed_slots !== undefined) {
 await pool.query("UPDATE students SET allowed_slots = $1 WHERE name = $2", [JSON.stringify(Array.isArray(allowed_slots) ? allowed_slots : []), name.trim()]);
 }
 if (fixed_lessons !== undefined) {
 const fl = Array.isArray(fixed_lessons) ? fixed_lessons.map(f => ({ dayIndex: Number(f.dayIndex), startTime: f.startTime, endTime: f.endTime })) : [];
 await pool.query("UPDATE students SET fixed_lessons = $1 WHERE name = $2", [JSON.stringify(fl), name.trim()]);
 }
 await logAction(req, id ? 'STUDENT_UPDATE' : 'STUDENT_CREATE', name);
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/recurring-expenses/toggle', async (req, res) => {
 try {
 await pool.query("UPDATE recurring_expenses SET active = $1 WHERE id = $2", [req.body.active === true, req.body.id]);
 await logAction(req, 'RECURRING_EXPENSE_TOGGLE', `${req.body.id} active=${req.body.active === true}`);
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/students/delete', async (req, res) => {
 try {
 const sr = await pool.query("SELECT * FROM students WHERE id = $1", [req.body.id]);
 await archiveDeleted('students', sr.rows);
 if (sr.rows.length > 0) {
 const n = sr.rows[0].name;
 const ap = await pool.query("SELECT * FROM appointments WHERE booked_by_name = $1", [n]);
 await archiveDeleted('appointments', ap.rows);
 const wc = await pool.query("SELECT * FROM weekly_student_config WHERE student_name = $1", [n]);
 await archiveDeleted('weekly_student_config', wc.rows);
 await pool.query("DELETE FROM appointments WHERE booked_by_name = $1", [n]);
 await pool.query("DELETE FROM weekly_student_config WHERE student_name = $1", [n]);
 }
 await pool.query("DELETE FROM students WHERE id = $1", [req.body.id]);
 await logAction(req, 'STUDENT_DELETE', String(req.body.id));
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🔗 איחוד שני תלמידים שהוקלדו בטעות — הפרופיל כולו ממוזג לשם הנבחר, שום מידע לא נמחק
app.post('/api/admin/students/merge', async (req, res) => {
 const client = await pool.connect();
 try {
 const { keepName, mergeName, finalName } = req.body || {};
 if (!keepName || !mergeName || keepName === mergeName) {
 return res.status(400).json({ error: 'Choose two different students.' });
 }
 const target = (finalName && String(finalName).trim()) ? String(finalName).trim() : keepName;

 // שלוף את שתי רשומות התלמיד המלאות
 const bothRows = (await client.query('SELECT * FROM students WHERE name IN ($1,$2)', [keepName, mergeName])).rows;
 const keepStu = bothRows.find(r => r.name === keepName);
 const mergeStu = bothRows.find(r => r.name === mergeName);
 if (!keepStu || !mergeStu) {
 return res.status(404).json({ error: 'One of the students was not found.' });
 }

 // ----- כללי מיזוג פרופיל (לא מאבדים כלום) -----
 const firstNonEmpty = (a, b) => {
 const empty = v => (v === null || v === undefined || v === '' || (typeof v === 'number' && v === 0));
 return !empty(a) ? a : b;
 };
 const num = v => Number(v) || 0;
 const higher = (a, b) => Math.max(num(a), num(b)); // המונים/הסכום: הגבוה מבין השניים

 // איחוד fixed_lessons (dedupe לפי יום+שעת התחלה+שעת סיום)
 const flA = Array.isArray(keepStu.fixed_lessons) ? keepStu.fixed_lessons : [];
 const flB = Array.isArray(mergeStu.fixed_lessons) ? mergeStu.fixed_lessons : [];
 const flSeen = new Set();
 const mergedFixed = [];
 for (const f of [...flA, ...flB]) {
 if (!f) continue;
 const k = `${f.dayIndex}_${f.startTime}_${f.endTime}`;
 if (flSeen.has(k)) continue;
 flSeen.add(k);
 mergedFixed.push(f);
 }

 // איחוד allowed_slots (dedupe)
 const asA = Array.isArray(keepStu.allowed_slots) ? keepStu.allowed_slots : [];
 const asB = Array.isArray(mergeStu.allowed_slots) ? mergeStu.allowed_slots : [];
 const mergedSlots = Array.from(new Set([...asA, ...asB]));

 const merged = {
 phone: firstNonEmpty(keepStu.phone, mergeStu.phone),
 email: firstNonEmpty(keepStu.email, mergeStu.email),
 course_type: firstNonEmpty(keepStu.course_type, mergeStu.course_type),
 start_date: firstNonEmpty(keepStu.start_date, mergeStu.start_date),
 validity_expiration_date: firstNonEmpty(keepStu.validity_expiration_date, mergeStu.validity_expiration_date),
 id_number_encrypted: firstNonEmpty(keepStu.id_number_encrypted, mergeStu.id_number_encrypted),
 default_time_range: firstNonEmpty(keepStu.default_time_range, mergeStu.default_time_range) || { start: "08:00", end: "21:00" },
 process_duration_months: firstNonEmpty(keepStu.process_duration_months, mergeStu.process_duration_months) || 1,
 default_quota: Math.max(num(keepStu.default_quota) || 2, num(mergeStu.default_quota) || 2),
 completed_lessons: higher(keepStu.completed_lessons, mergeStu.completed_lessons),
 total_lessons: higher(keepStu.total_lessons, mergeStu.total_lessons),
 total_amount: Math.max(Number(keepStu.total_amount) || 0, Number(mergeStu.total_amount) || 0),
 // "פעיל" מנצח: רק אם שניהם past-student התוצאה past
 is_past_student: (keepStu.is_past_student === true && mergeStu.is_past_student === true)
 };

 await client.query('BEGIN');

 // 1) העבר את כל הרשומות התלויות משני השמות אל השם הסופי
 await client.query('UPDATE invoices SET student_name = $1 WHERE student_name IN ($2,$3)', [target, keepName, mergeName]);
 await client.query('UPDATE payments SET student_name = $1 WHERE student_name IN ($2,$3)', [target, keepName, mergeName]);
 await client.query('UPDATE appointments SET booked_by_name = $1 WHERE booked_by_name IN ($2,$3)', [target, keepName, mergeName]);
 await client.query('UPDATE appointments_history SET booked_by_name = $1 WHERE booked_by_name IN ($2,$3)', [target, keepName, mergeName]);

 // 2) מיזוג weekly_student_config של שני השמות לרשומה אחת (חסימות/טווחים/סלוטים מאוחדים)
 const cfgRows = (await client.query('SELECT * FROM weekly_student_config WHERE student_name IN ($1,$2)', [keepName, mergeName])).rows;
 const cfgKeep = cfgRows.find(c => c.student_name === keepName);
 const cfgMerge = cfgRows.find(c => c.student_name === mergeName);
 if (cfgKeep || cfgMerge) {
 const unionArr = (a, b) => {
 const x = Array.isArray(a) ? a : [];
 const y = Array.isArray(b) ? b : [];
 return Array.from(new Set([...x.map(v => JSON.stringify(v)), ...y.map(v => JSON.stringify(v))])).map(s => JSON.parse(s));
 };
 const mQuota = firstNonEmpty(cfgKeep && cfgKeep.quota_override, cfgMerge && cfgMerge.quota_override);
 const mBlocked = unionArr(cfgKeep && cfgKeep.blocked_slots_override, cfgMerge && cfgMerge.blocked_slots_override);
 const mRanges = unionArr(cfgKeep && cfgKeep.allowed_custom_ranges, cfgMerge && cfgMerge.allowed_custom_ranges);
 const mAllowed = unionArr(cfgKeep && cfgKeep.allowed_slots_override, cfgMerge && cfgMerge.allowed_slots_override);
 await client.query('DELETE FROM weekly_student_config WHERE student_name IN ($1,$2)', [keepName, mergeName]);
 await client.query(
 'INSERT INTO weekly_student_config (student_name, quota_override, blocked_slots_override, allowed_custom_ranges, allowed_slots_override) VALUES ($1,$2,$3,$4,$5)',
 [target, (mQuota === '' ? null : (mQuota ?? null)), JSON.stringify(mBlocked), JSON.stringify(mRanges), mAllowed.length ? JSON.stringify(mAllowed) : null]
 );
 }

 // 3) ארכב ומחק את רשומת התלמיד הכפולה (נשמרת ב-deleted_records כגיבוי)
 await client.query(
 'INSERT INTO deleted_records (entity_type, original_id, data) VALUES ($1,$2,$3)',
 ['students_merged', (mergeStu.id != null ? mergeStu.id : null), JSON.stringify(mergeStu)]
 );
 await client.query('DELETE FROM students WHERE name = $1', [mergeName]);

 // 4) כתוב את הפרופיל הממוזג על רשומת ה"נשמר" ושנה אותה לשם הסופי
 await client.query(
 `UPDATE students SET
 name = $1,
 phone = $2,
 email = $3,
 course_type = $4,
 default_quota = $5,
 total_amount = $6,
 total_lessons = $7,
 completed_lessons = $8,
 process_duration_months = $9,
 start_date = $10,
 validity_expiration_date = $11,
 is_past_student = $12,
 id_number_encrypted = $13,
 default_time_range = $14,
 allowed_slots = $15,
 fixed_lessons = $16
 WHERE name = $17`,
 [
 target,
 merged.phone, merged.email, merged.course_type, merged.default_quota,
 merged.total_amount, merged.total_lessons, merged.completed_lessons,
 merged.process_duration_months, merged.start_date, merged.validity_expiration_date,
 merged.is_past_student, merged.id_number_encrypted,
 JSON.stringify(merged.default_time_range), JSON.stringify(mergedSlots), JSON.stringify(mergedFixed),
 keepName
 ]
 );

 await client.query('COMMIT');
 await logAction(req, 'STUDENTS_MERGE', `${mergeName} -> ${target} (kept ${keepName}) [full profile merge]`);
 res.json({ success: true });
 } catch (err) {
 await client.query('ROLLBACK').catch(() => {});
 res.status(500).json({ error: err.message });
 } finally {
 client.release();
 }
});

app.post('/api/admin/students/weekly-override', async (req, res) => {
 try {
 const { student_name } = req.body;
 if (!student_name) return res.status(400).json({ error: 'Missing student_name' });
 const existing = (await pool.query("SELECT * FROM weekly_student_config WHERE student_name = $1", [student_name])).rows[0] || {};
 const quota_override = ('quota_override' in req.body) ? req.body.quota_override : (existing.quota_override ?? null);
 const blocked = ('blocked_slots_override' in req.body) ? req.body.blocked_slots_override : (existing.blocked_slots_override || []);
 const ranges = ('allowed_custom_ranges' in req.body) ? req.body.allowed_custom_ranges : (existing.allowed_custom_ranges || []);
 const allowedSlots = ('allowed_slots_override' in req.body) ? req.body.allowed_slots_override : (existing.allowed_slots_override || null);
 await pool.query(`INSERT INTO weekly_student_config (student_name, quota_override, blocked_slots_override, allowed_custom_ranges, allowed_slots_override) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (student_name) DO UPDATE SET quota_override=EXCLUDED.quota_override, blocked_slots_override=EXCLUDED.blocked_slots_override, allowed_custom_ranges=EXCLUDED.allowed_custom_ranges, allowed_slots_override=EXCLUDED.allowed_slots_override`,
 [student_name, (quota_override === '' ? null : quota_override), JSON.stringify(blocked || []), JSON.stringify(ranges || []), (allowedSlots && allowedSlots.length) ? JSON.stringify(allowedSlots) : null]);
 await logAction(req, 'WEEKLY_OVERRIDE', student_name);
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
 const { type, name, color, text_color } = req.body;
 if (!name || !type) return res.status(400).json({ error: 'Type and name required' });
 await pool.query(
 'INSERT INTO categories (type, name, color, text_color) VALUES ($1, $2, $3, $4)',
 [type, name, color || '#64748b', text_color || '#ffffff']
 );
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

// מנקה (ל-NULL) את שדה הקטגוריה מכל הרשומות שמשתמשות בשם — הרשומות עצמן נשמרות, רק הסיווג מוסר
async function clearCategoryFromRecords(client, type, name) {
 let n = 0;
 if (type === 'course_type') {
 const r = await client.query('UPDATE students SET course_type = NULL WHERE course_type = $1', [name]); n += r.rowCount || 0;
 } else if (type === 'payment_method') {
 const r = await client.query('UPDATE invoices SET payment_method = NULL WHERE payment_method = $1', [name]); n += r.rowCount || 0;
 } else if (type === 'expense_category') {
 const r1 = await client.query('UPDATE expenses SET category = NULL WHERE category = $1', [name]); n += r1.rowCount || 0;
 const r2 = await client.query('UPDATE recurring_expenses SET category = NULL WHERE category = $1', [name]); n += r2.rowCount || 0;
 }
 return n;
}

// מחיקת קטגוריה רשומה (לפי id): מנקה את הערך מהרשומות (הן נשארות ללא קטגוריה) ואז מוחק את שורת הקטגוריה. הרשומות לעולם לא נמחקות.
app.post('/api/admin/categories/delete', async (req, res) => {
 const client = await pool.connect();
 try {
 const r = await client.query('SELECT * FROM categories WHERE id = $1', [req.body.id]);
 const cat = r.rows[0];
 await archiveDeleted('categories', r.rows);
 await client.query('BEGIN');
 if (cat) await clearCategoryFromRecords(client, cat.type, cat.name);
 await client.query('DELETE FROM categories WHERE id = $1', [req.body.id]);
 await client.query('COMMIT');
 await logAction(req, 'CATEGORY_DELETE', cat ? `${cat.type}:${cat.name}` : `id ${req.body.id}`);
 res.json({ success: true });
 }
 catch (err) { await client.query('ROLLBACK').catch(()=>{}); res.status(500).json({ error: err.message }); }
 finally { client.release(); }
});

// מחיקת ערך קטגוריה "from data" (ללא שורה בטבלת categories): מנקה את הערך מהרשומות בלבד. הרשומות לעולם לא נמחקות.
app.post('/api/admin/categories/delete-by-value', async (req, res) => {
 const client = await pool.connect();
 try {
 const { type, name } = req.body || {};
 if (!type || !name) return res.status(400).json({ error: 'type and name required' });
 await client.query('BEGIN');
 const affected = await clearCategoryFromRecords(client, type, name);
 const existing = await client.query('SELECT * FROM categories WHERE type=$1 AND name=$2', [type, name]);
 if (existing.rows.length) { await archiveDeleted('categories', existing.rows); await client.query('DELETE FROM categories WHERE type=$1 AND name=$2', [type, name]); }
 await client.query('COMMIT');
 await logAction(req, 'CATEGORY_DELETE_VALUE', `${type}:${name} cleared from ${affected} record(s)`);
 res.json({ success: true, affected });
 }
 catch (err) { await client.query('ROLLBACK').catch(()=>{}); res.status(500).json({ error: err.message }); }
 finally { client.release(); }
});

app.post('/api/admin/categories/color', async (req, res) => {
 try {
 const { id, color, text_color } = req.body;
 if (!id || (!color && !text_color)) return res.status(400).json({ error: 'id and color or text_color required' });
 await pool.query(
 'UPDATE categories SET color = COALESCE($1, color), text_color = COALESCE($2, text_color) WHERE id = $3',
 [color ?? null, text_color ?? null, id]
 );
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== המרת מטבע: שער USD→ILS יומי מ-frankfurter.app, עם cache בטבלת settings =====
async function getUsdIlsRate(dateStr) {
 const d = (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) ? dateStr : new Date().toISOString().slice(0,10);
 const key = `fx_USD_ILS_${d}`;
 const cached = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
 if (cached.rows[0] && cached.rows[0].value) return Number(cached.rows[0].value);
 const url = `https://api.frankfurter.app/${d}?from=USD&to=ILS`;
 let rate = null;
 try {
 const r = await fetch(url);
 const j = await r.json();
 rate = (j && j.rates && j.rates.ILS) ? Number(j.rates.ILS) : null;
 } catch (e) { rate = null; }
 if (!rate) {
 const last = await pool.query("SELECT value FROM settings WHERE key LIKE 'fx_USD_ILS_%' ORDER BY key DESC LIMIT 1");
 rate = last.rows[0] ? Number(last.rows[0].value) : 3.7;
 }
 await pool.query('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [key, String(rate)]);
 return rate;
}

app.get('/api/admin/fx-rate', async (req, res) => {
 try {
 const rate = await getUsdIlsRate(req.query.date || null);
 res.json({ rate, from: 'USD', to: 'ILS', date: req.query.date || new Date().toISOString().slice(0,10) });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/invoices', async (req, res) => {
 try { res.json({ invoices: (await pool.query('SELECT * FROM invoices ORDER BY invoice_date DESC NULLS LAST, id DESC')).rows }); }
 catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/invoices/save', async (req, res) => {
 try {
 const { invoice_number, student_name, invoice_date, payment_method, period_covered, reference_number, transaction_id, notes, payment_number } = req.body;
 const isRefund = (req.body.is_refund === true || req.body.is_refund === 'true');
 let amt = Math.abs(Number(req.body.amount_payed) || 0);
 if (isRefund) amt = -amt;
 const pnum = (payment_number ? Number(payment_number) : null);
 if (req.body.id) {
 await pool.query(`UPDATE invoices SET invoice_number=$1, student_name=$2, invoice_date=$3, payment_method=$4, amount_payed=$5, is_refund=$6, period_covered=$7, reference_number=$8, transaction_id=$9, notes=$10, payment_number=$11 WHERE id=$12`, [invoice_number || null, student_name || null, invoice_date || null, payment_method || null, amt, isRefund, period_covered || null, reference_number || null, transaction_id || null, notes || null, pnum, req.body.id]);
 await logAction(req, 'INVOICE_UPDATE', `${student_name} ₪${amt}`);
 } else {
 await pool.query(`INSERT INTO invoices (invoice_number, student_name, invoice_date, payment_method, amount_payed, is_refund, period_covered, reference_number, transaction_id, notes, payment_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [invoice_number || null, student_name || null, invoice_date || null, payment_method || null, amt, isRefund, period_covered || null, reference_number || null, transaction_id || null, notes || null, pnum]);
 await logAction(req, isRefund ? 'INVOICE_REFUND' : 'INVOICE_CREATE', `${student_name} ₪${amt}`);
 }
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/expenses', async (req, res) => {
 try {
 await materializeRecurringExpenses();
 res.json({ expenses: (await pool.query('SELECT * FROM expenses ORDER BY expense_date DESC NULLS LAST, id DESC')).rows });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/expenses/save', async (req, res) => {
 try {
 const { expense_date, tr_name, category, payment_method, invoice_received, file_link, notes } = req.body;
 const currency = (req.body.currency === 'USD') ? 'USD' : 'ILS';
 const amountOriginal = Number(req.body.amount) || 0;
 let fxRate = 1, amountIls = amountOriginal;
 if (currency === 'USD') {
 fxRate = await getUsdIlsRate(expense_date || null);
 amountIls = +(amountOriginal * fxRate).toFixed(2);
 }
 if (req.body.id) {
 await pool.query(
 `UPDATE expenses SET expense_date=$1, tr_name=$2, category=$3, amount=$4, payment_method=$5, invoice_received=$6, file_link=$7, notes=$8, currency=$9, amount_original=$10, fx_rate=$11 WHERE id=$12`,
 [expense_date || null, tr_name || null, category || null, amountIls, payment_method || null, invoice_received || null, file_link || null, notes || null, currency, amountOriginal, fxRate, req.body.id]
 );
 await logAction(req, 'EXPENSE_UPDATE', `${tr_name} ${currency} ${amountOriginal} (₪${amountIls})`);
 } else {
 await pool.query(
 `INSERT INTO expenses (expense_date, tr_name, category, amount, payment_method, invoice_received, file_link, notes, currency, amount_original, fx_rate)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
 [expense_date || null, tr_name || null, category || null, amountIls, payment_method || null, invoice_received || null, file_link || null, notes || null, currency, amountOriginal, fxRate]
 );
 await logAction(req, 'EXPENSE_CREATE', `${tr_name} ${currency} ${amountOriginal} (₪${amountIls})`);
 }
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/invoices/delete', async (req, res) => {
 try {
 const r = await pool.query('SELECT * FROM invoices WHERE id = $1', [req.body.id]);
 await archiveDeleted('invoices', r.rows);
 await pool.query('DELETE FROM invoices WHERE id = $1', [req.body.id]);
 await logAction(req, 'INVOICE_DELETE', r.rows[0] ? `${r.rows[0].student_name} ₪${r.rows[0].amount_payed}` : `id ${req.body.id}`);
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/expenses/delete', async (req, res) => {
 try {
 const r = await pool.query('SELECT * FROM expenses WHERE id = $1', [req.body.id]);
 await archiveDeleted('expenses', r.rows);
 await pool.query('DELETE FROM expenses WHERE id = $1', [req.body.id]);
 await logAction(req, 'EXPENSE_DELETE', r.rows[0] ? `${r.rows[0].tr_name} ₪${r.rows[0].amount}` : `id ${req.body.id}`);
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 🎓 STUDENT — סימון שיעור שבוצע (מונה התקדמות)
// ==========================================
app.post('/api/admin/students/complete-lesson', async (req, res) => {
 try {
 const { id, delta } = req.body;
 const d = Number(delta) || 1;
 await pool.query('UPDATE students SET completed_lessons = GREATEST(0, COALESCE(completed_lessons,0) + $1) WHERE id = $2', [d, id]);
 await logAction(req, 'LESSON_COMPLETE', `student ${id} delta ${d}`);
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 💳 PAYMENTS / INSTALLMENTS — פריסת תשלומים חודשית + דריסת מנהל
// ==========================================
app.get('/api/admin/payments', async (req, res) => {
 try {
 const { student_name } = req.query;
 let q, params;
 if (student_name) { q = 'SELECT * FROM payments WHERE student_name = $1 ORDER BY installment_number ASC'; params = [student_name]; }
 else { q = 'SELECT * FROM payments ORDER BY due_date ASC NULLS LAST, id ASC'; params = []; }
 res.json({ payments: (await pool.query(q, params)).rows });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/payments/generate', async (req, res) => {
 try {
 const { student_name, totalAmount, numInstallments, firstDueDate } = req.body;
 const n = Number(numInstallments);
 const total = Number(totalAmount);
 if (!student_name || !n || n < 1 || !firstDueDate) return res.status(400).json({ error: 'חסרים פרטי עסקה (תלמיד, מספר תשלומים, תאריך ראשון)' });
 await pool.query('DELETE FROM payments WHERE student_name = $1', [student_name]);
 const base = Math.floor((total / n) * 100) / 100;
 let allocated = 0;
 const [y, m, d] = firstDueDate.split('-').map(Number);
 for (let i = 0; i < n; i++) {
 const dt = new Date(y, m - 1, d);
 dt.setMonth(dt.getMonth() + i);
 const due = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
 let amt = base;
 if (i === n - 1) amt = Math.round((total - allocated) * 100) / 100;
 allocated += base;
 await pool.query('INSERT INTO payments (student_name, installment_number, total_installments, amount, due_date, status) VALUES ($1,$2,$3,$4,$5,$6)', [student_name, i + 1, n, amt, due, 'pending']);
 }
 await logAction(req, 'PAYMENTS_GENERATE', `${student_name} ${n}x total ₪${total}`);
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/payments/update', async (req, res) => {
 try {
 const { id, due_date, amount, status } = req.body;
 if (!id) return res.status(400).json({ error: 'Missing id' });
 const paidDate = status === 'paid' ? (new Date()).toISOString().split('T')[0] : null;
 const amtVal = (amount === undefined || amount === null || amount === '') ? null : Number(amount);
 await pool.query(
 `UPDATE payments SET
 due_date = COALESCE($1, due_date),
 amount = COALESCE($2, amount),
 status = COALESCE($3, status),
 paid_date = CASE WHEN $3 = 'paid' THEN COALESCE(paid_date, $4)
 WHEN $3 = 'pending' THEN NULL
 ELSE paid_date END
 WHERE id = $5`,
 [due_date || null, amtVal, status || null, paidDate, id]
 );
 await logAction(req, 'PAYMENT_UPDATE', `payment ${id} ${status || ''}`);
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/payments/delete', async (req, res) => {
 try {
 const r = await pool.query('SELECT * FROM payments WHERE id = $1', [req.body.id]);
 await archiveDeleted('payments', r.rows);
 await pool.query('DELETE FROM payments WHERE id = $1', [req.body.id]);
 await logAction(req, 'PAYMENT_DELETE', String(req.body.id));
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 🔁 הוצאות חוזרות + 🔔 לוח 7 ימים + הגדרות תלמיד
// ==========================================
function deriveAllowedSlots(student, override) {
 if (override && override.length) return override;
 if (student && student.allowed_slots && student.allowed_slots.length) return student.allowed_slots;
 return [];
}

function fmtDate(dt) { return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`; }

function advanceFreq(dt, freq) {
 const d = new Date(dt);
 if (freq === 'weekly') d.setDate(d.getDate() + 7);
 else if (freq === 'yearly') d.setFullYear(d.getFullYear() + 1);
 else d.setMonth(d.getMonth() + 1);
 return d;
}

async function materializeRecurringExpenses() {
 const today = new Date(); today.setHours(0,0,0,0);
 const recs = (await pool.query("SELECT * FROM recurring_expenses WHERE active = TRUE")).rows;
 for (const r of recs) {
 let next = new Date(r.next_run); next.setHours(0,0,0,0);
 let changed = false, guard = 0;
 while (next <= today && guard < 500) {
 guard++;
 const dateStr = fmtDate(next);
 const currency = (r.currency === 'USD') ? 'USD' : 'ILS';
 const amountOriginal = Number(r.amount) || 0;
 let fxRate = 1, amountIls = amountOriginal;
 if (currency === 'USD') { fxRate = await getUsdIlsRate(dateStr); amountIls = +(amountOriginal * fxRate).toFixed(2); }
 await pool.query(
 `INSERT INTO expenses (expense_date, tr_name, category, amount, payment_method, invoice_received, file_link, notes, currency, amount_original, fx_rate)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
 [dateStr, r.tr_name, r.category, amountIls, r.payment_method, null, null, `🔁 הוצאה חוזרת #${r.id}`, currency, amountOriginal, fxRate]
 );
 next = advanceFreq(next, r.frequency);
 changed = true;
 }
 if (changed) await pool.query("UPDATE recurring_expenses SET next_run = $1 WHERE id = $2", [fmtDate(next), r.id]);
 }
}

app.get('/api/admin/recurring-expenses', async (req, res) => {
 try {
 await materializeRecurringExpenses();
 res.json({ recurring: (await pool.query('SELECT * FROM recurring_expenses ORDER BY active DESC, next_run ASC')).rows });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/recurring-expenses/save', async (req, res) => {
 try {
 const { id, tr_name, category, amount, currency, payment_method, frequency, start_date, active } = req.body;
 const freq = ['weekly','monthly','yearly'].includes(frequency) ? frequency : 'monthly';
 const cur = (currency === 'USD') ? 'USD' : 'ILS';
 const amt = Number(amount) || 0;
 const isActive = (active === false) ? false : true;
 if (id) {
 await pool.query(
 `UPDATE recurring_expenses SET tr_name=$1, category=$2, amount=$3, currency=$4, payment_method=$5, frequency=$6, start_date=$7, active=$8 WHERE id=$9`,
 [tr_name || null, category || null, amt, cur, payment_method || null, freq, start_date || null, isActive, id]
 );
 await logAction(req, 'RECURRING_EXPENSE_UPDATE', `${tr_name} ${freq}`);
 } else {
 await pool.query(
 `INSERT INTO recurring_expenses (tr_name, category, amount, currency, payment_method, frequency, start_date, next_run, active)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)`,
 [tr_name || null, category || null, amt, cur, payment_method || null, freq, start_date || null, isActive]
 );
 await logAction(req, 'RECURRING_EXPENSE_CREATE', `${tr_name} ${freq}`);
 }
 await materializeRecurringExpenses();
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/recurring-expenses/delete', async (req, res) => {
 try {
 const r = await pool.query('SELECT * FROM recurring_expenses WHERE id = $1', [req.body.id]);
 await archiveDeleted('recurring_expenses', r.rows);
 await pool.query('DELETE FROM recurring_expenses WHERE id = $1', [req.body.id]);
 await logAction(req, 'RECURRING_EXPENSE_DELETE', String(req.body.id));
 res.json({ success: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/upcoming', async (req, res) => {
 try {
 await materializeRecurringExpenses();
 const days = Number(req.query.days) || 7;
 const today = new Date(); today.setHours(0,0,0,0);
 const horizon = new Date(today); horizon.setDate(horizon.getDate() + days);
 const items = [];
 const pays = (await pool.query(
 "SELECT * FROM payments WHERE status = 'pending' AND due_date IS NOT NULL AND due_date >= $1 AND due_date <= $2 ORDER BY due_date ASC",
 [fmtDate(today), fmtDate(horizon)]
 )).rows;
 for (const p of pays) {
 const dstr = (p.due_date instanceof Date) ? fmtDate(p.due_date) : String(p.due_date).slice(0,10);
 items.push({ type: 'payment', date: dstr, name: p.student_name, detail: `Payment ${p.installment_number}/${p.total_installments}`, amount: Number(p.amount) || 0, currency: 'ILS' });
 }
 const recs = (await pool.query("SELECT * FROM recurring_expenses WHERE active = TRUE")).rows;
 for (const r of recs) {
 let next = new Date(r.next_run); next.setHours(0,0,0,0);
 let guard = 0;
 while (next <= horizon && guard < 60) {
 guard++;
 if (next >= today) items.push({ type: 'expense', date: fmtDate(next), name: r.tr_name, detail: `Recurring expense (${r.frequency})`, amount: Number(r.amount) || 0, currency: r.currency || 'ILS' });
 next = advanceFreq(next, r.frequency);
 }
 }
 items.sort((a,b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
 const studs = (await pool.query("SELECT * FROM students WHERE is_past_student = FALSE")).rows;
 const prefRows = (await pool.query("SELECT alert_key, state FROM alert_prefs")).rows;
 const prefMap = {}; for (const pr of prefRows) prefMap[pr.alert_key] = pr.state;
 const toDay = (v) => new Date(((v instanceof Date) ? v.toISOString() : String(v)).slice(0,10) + "T00:00:00Z");
 const today0 = new Date(new Date().toISOString().slice(0,10) + "T00:00:00Z");
 const alerts = [];
 for (const s of studs) {
 const key = String(s.id);
 if (prefMap[key] === 'deleted') continue;
 const total = Number(s.total_lessons) || 0, done = Number(s.completed_lessons) || 0;
 const lessonPct = total > 0 ? Math.max(0, Math.min(100, Math.round(done / total * 100))) : 0;
 let timePct = null;
 if (s.start_date && s.validity_expiration_date) {
 const start = toDay(s.start_date);
 const exp = toDay(s.validity_expiration_date);
 const span = exp - start;
 if (span > 0 && !isNaN(span)) timePct = Math.max(0, Math.min(100, Math.round(((today0 - start) / span) * 100)));
 }
 const parts = [];
 if (lessonPct >= 90) parts.push(`Lessons ${lessonPct}%`);
 if (timePct !== null && timePct >= 90) parts.push(`Validity ${timePct}%`);
 if (parts.length) alerts.push({ key, name: s.name, detail: parts.join(' · '), lessonPct, timePct, hidden: prefMap[key] === 'hidden' });
 }
 res.json({ upcoming: items, alerts });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/alerts/state', async (req, res) => {
 try {
 const { key, state } = req.body || {};
 if (!key || !['visible','hidden','deleted'].includes(state)) return res.status(400).json({ error: 'invalid key/state' });
 if (state === 'visible') {
 await pool.query('DELETE FROM alert_prefs WHERE alert_key = $1', [String(key)]);
 } else {
 await pool.query(`INSERT INTO alert_prefs (alert_key, state, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (alert_key) DO UPDATE SET state=EXCLUDED.state, updated_at=NOW()`, [String(key), state]);
 }
 await logAction(req, 'ALERT_STATE', `${key} -> ${state}`);
 res.json({ ok: true });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/students/weekly-override', async (req, res) => {
 try {
 const r = await pool.query("SELECT * FROM weekly_student_config WHERE student_name = $1", [req.query.student_name]);
 res.json({ config: r.rows[0] || null });
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/audit-log', async (req, res) => {
 try { res.json({ log: (await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200')).rows }); }
 catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// 💾 גיבוי ושחזור מלא של כל הנתונים (מוגן ע"י השוער)
// ==========================================
const BACKUP_TABLES = ['students','appointments','appointments_history','weekly_student_config','settings','categories','invoices','expenses','blocked_slots','payments','recurring_expenses','audit_log','deleted_records','alert_prefs'];
const BACKUP_NO_ID = new Set(['settings','weekly_student_config','alert_prefs']);

app.get('/api/admin/backup', async (req, res) => {
 try {
 const dump = { version: 1, exported_at: new Date().toISOString(), tables: {} };
 for (const t of BACKUP_TABLES) dump.tables[t] = (await pool.query(`SELECT * FROM ${t}`)).rows;
 await logAction(req, 'BACKUP_EXPORT', `${BACKUP_TABLES.length} tables`);
 const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
 res.setHeader('Content-Type', 'application/json; charset=utf-8');
 res.setHeader('Content-Disposition', `attachment; filename="booking-backup-${stamp}.json"`);
 res.send(JSON.stringify(dump, null, 2));
 } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/restore', async (req, res) => {
 const client = await pool.connect();
 try {
 const { data, confirm } = req.body;
 if (confirm !== 'RESTORE' || !data || !data.tables) return res.status(400).json({ error: 'חסר confirm="RESTORE" או קובץ גיבוי תקין' });
 await client.query('BEGIN');
 for (const t of BACKUP_TABLES) {
 const rows = data.tables[t];
 if (!Array.isArray(rows)) continue;
 await client.query(`DELETE FROM ${t}`);
 for (const row of rows) {
 const cols = Object.keys(row);
 if (!cols.length) continue;
 const vals = cols.map(c => { const v = row[c]; return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v; });
 const ph = cols.map((_, i) => `$${i + 1}`).join(',');
 await client.query(`INSERT INTO ${t} (${cols.map(c => `"${c}"`).join(',')}) VALUES (${ph})`, vals);
 }
 if (!BACKUP_NO_ID.has(t)) {
 await client.query(`SELECT setval(pg_get_serial_sequence('${t}','id'), COALESCE((SELECT MAX(id) FROM ${t}), 1), true)`);
 }
 }
 await client.query('COMMIT');
 await logAction(req, 'RESTORE_IMPORT', `restored backup from ${data.exported_at || 'unknown'}`);
 res.json({ success: true });
 } catch (err) {
 await client.query('ROLLBACK').catch(() => {});
 res.status(500).json({ error: err.message });
 } finally { client.release(); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Secure Server running on port ${PORT}`));