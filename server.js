const express = require('express');
const { Pool } = require('pg');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const FIXED_SLOTS = [
    { start: '08:00', end: '09:00' },
    { start: '09:15', end: '10:15' },
    { start: '10:30', end: '11:30' },
    { start: '11:45', end: '12:45' },
    { start: '13:00', end: '14:00' },
    { start: '14:15', end: '15:15' },
    { start: '16:15', end: '17:15' },
    { start: '17:30', end: '18:30' },
    { start: '18:45', end: '19:45' },
    { start: '20:00', end: '21:00' }
];

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
                fixed_lessons JSONB DEFAULT '[]',
                default_time_range JSONB DEFAULT '{"start": "08:00", "end": "21:00"}'
            );

            CREATE TABLE IF NOT EXISTS appointments (
                id SERIAL PRIMARY KEY,
                day_index INTEGER NOT NULL,
                start_time VARCHAR(10) NOT NULL,
                end_time VARCHAR(10) NOT NULL,
                booked_by_name VARCHAR(100) NOT NULL,
                is_custom BOOLEAN DEFAULT FALSE,
                is_fixed BOOLEAN DEFAULT FALSE
            );

            CREATE TABLE IF NOT EXISTS weekly_student_config (
                student_name VARCHAR(100) PRIMARY KEY,
                quota_override INTEGER,
                blocked_slots_override JSONB,
                allowed_custom_ranges JSONB DEFAULT '[]'
            );

            CREATE TABLE IF NOT EXISTS settings (
                key VARCHAR(50) PRIMARY KEY,
                value TEXT
            );
        `);

        await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS is_custom BOOLEAN DEFAULT FALSE;`);
        await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS is_fixed BOOLEAN DEFAULT FALSE;`);
        await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS default_time_range JSONB DEFAULT '{"start": "08:00", "end": "21:00"}';`);
        await pool.query(`ALTER TABLE weekly_student_config ADD COLUMN IF NOT EXISTS allowed_custom_ranges JSONB DEFAULT '[]';`);

        const defaults = [
            ["is_open", "true"],
            ["open_mode", "all"],
            ["allowed_students", "[]"],
            ["sunday_date", ""]
        ];

        for (const [k, v] of defaults) {
            const check = await pool.query("SELECT * FROM settings WHERE key = $1", [k]);
            if (check.rows.length === 0) {
                await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2)", [k, v]);
            }
        }
        console.log('Database initialized successfully!');
    } catch (err) {
        console.error('Error initializing database:', err);
    }
}
initDb();

function timeToMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

function calculateDatesFromSunday(sundayDateStr) {
    const daysNames = ['יום ראשון', 'יום שני', 'יום שלישי', 'יום רביעי', 'יום חמישי'];
    if (!sundayDateStr) {
        return daysNames.map((name, index) => ({ index, name, date: '' }));
    }
    const [year, month, day] = sundayDateStr.split('-').map(Number);
    const baseSunday = new Date(year, month - 1, day);

    return daysNames.map((name, index) => {
        const d = new Date(baseSunday);
        d.setDate(baseSunday.getDate() + index);
        const formattedDate = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
        return { index, name, date: formattedDate };
    });
}

app.get('/api/slots', async (req, res) => {
    try {
        const studentName = req.query.studentName ? req.query.studentName.trim() : null;

        const settingsRes = await pool.query("SELECT * FROM settings");
        const settings = {};
        settingsRes.rows.forEach(s => settings[s.key] = s.value);

        const isOpen = settings.is_open === 'true';
        const openMode = settings.open_mode || 'all';
        const allowedStudentsList = JSON.parse(settings.allowed_students || '[]');
        const sundayDate = settings.sunday_date || '';

        let isStudentAllowedToBook = isOpen;
        if (studentName) {
            if (openMode === 'none') {
                isStudentAllowedToBook = false;
            } else if (openMode === 'specific') {
                isStudentAllowedToBook = allowedStudentsList.includes(studentName);
            }
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

                const effectiveQuota = config.quota_override !== null && config.quota_override !== undefined ? config.quota_override : s.default_quota;
                const blockedSlots = config.blocked_slots_override || [];
                const allowedCustomRanges = config.allowed_custom_ranges || [];
                const defaultTimeRange = s.default_time_range || { start: "08:00", end: "21:00" };

                const currentBookings = appsRes.rows.filter(a => a.booked_by_name === studentName).length;
                const remainingQuota = Math.max(0, effectiveQuota - currentBookings);

                studentData = {
                    name: s.name,
                    effectiveQuota,
                    currentBookings,
                    remainingQuota,
                    blockedSlots,
                    defaultTimeRange,
                    allowedCustomRanges
                };
            }
        }

        res.json({
            isOpen,
            openMode,
            allowedStudentsList,
            isStudentAllowedToBook,
            fixedSlots: FIXED_SLOTS,
            sundayDate,
            days,
            appointments: appsRes.rows,
            studentData
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/book', async (req, res) => {
    try {
        const { studentName, slots } = req.body;
        if (!studentName || !slots || !Array.isArray(slots) || slots.length === 0) {
            return res.status(400).json({ error: 'נא להזין שם תלמיד ולבחור לפחות שיעור אחד' });
        }

        const trimmedName = studentName.trim();
        const studentRes = await pool.query("SELECT * FROM students WHERE name = $1", [trimmedName]);
        if (studentRes.rows.length === 0) {
            return res.status(404).json({ error: 'תלמיד לא נמצא במערכת' });
        }

        const settingsRes = await pool.query("SELECT * FROM settings");
        const settings = {};
        settingsRes.rows.forEach(s => settings[s.key] = s.value);

        const isOpen = settings.is_open === 'true';
        const openMode = settings.open_mode || 'all';
        const allowedStudentsList = JSON.parse(settings.allowed_students || '[]');

        let isAllowed = isOpen;
        if (openMode === 'none') isAllowed = false;
        if (openMode === 'specific') isAllowed = allowedStudentsList.includes(trimmedName);

        if (!isAllowed) {
            return res.status(403).json({ error: 'ההרשמה סגורה עבורך כרגע' });
        }

        const configRes = await pool.query("SELECT * FROM weekly_student_config WHERE student_name = $1", [trimmedName]);
        const config = configRes.rows[0] || {};
        const quota = config.quota_override !== null && config.quota_override !== undefined ? config.quota_override : studentRes.rows[0].default_quota;

        const currentBookingsRes = await pool.query("SELECT * FROM appointments WHERE booked_by_name = $1", [trimmedName]);
        if (currentBookingsRes.rows.length + slots.length > quota) {
            return res.status(400).json({
                error: `כבר רשומים עבורך ${currentBookingsRes.rows.length} שיעורים. מכסת השיעורים שלך לשבוע זה היא ${quota}.`
            });
        }

        const allAppsRes = await pool.query("SELECT * FROM appointments");
        const allApps = allAppsRes.rows;

        for (let slot of slots) {
            const startMins = timeToMinutes(slot.startTime);
            const endMins = timeToMinutes(slot.endTime);

            const conflict = allApps.some(app => {
                if (app.day_index !== slot.dayIndex) return false;
                const appStart = timeToMinutes(app.start_time);
                const appEnd = timeToMinutes(app.end_time);
                return (startMins < appEnd && endMins > appStart);
            });

            if (conflict) {
                return res.status(400).json({ error: `המשבצת ${slot.startTime} ביום ${slot.dayName || ''} חופפת לשיעור קיים ביומן.` });
            }
        }

        for (let slot of slots) {
            await pool.query(
                `INSERT INTO appointments (day_index, start_time, end_time, booked_by_name, is_custom, is_fixed) VALUES ($1, $2, $3, $4, FALSE, FALSE)`,
                [slot.dayIndex, slot.startTime, slot.endTime, trimmedName]
            );
        }

        res.json({ success: true, message: 'השיעור/ים שובצו בהצלחה!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/* --- API למנהל --- */

app.get('/api/admin/students', async (req, res) => {
    try {
        const studentsRes = await pool.query("SELECT * FROM students ORDER BY name ASC");
        const configsRes = await pool.query("SELECT * FROM weekly_student_config");
        const configsMap = {};
        configsRes.rows.forEach(c => configsMap[c.student_name] = c);

        const appsRes = await pool.query("SELECT * FROM appointments");

        const list = studentsRes.rows.map(s => {
            const config = configsMap[s.name] || {};
            const studentApps = appsRes.rows.filter(a => a.booked_by_name === s.name);
            return {
                ...s,
                effectiveQuota: config.quota_override !== null && config.quota_override !== undefined ? config.quota_override : s.default_quota,
                blockedSlots: config.blocked_slots_override || [],
                allowedCustomRanges: config.allowed_custom_ranges || [],
                bookedLessons: studentApps
            };
        });

        res.json({ students: list });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/students/save', async (req, res) => {
    try {
        const { id, name, default_quota, fixed_lessons, default_time_range } = req.body;
        if (!name) return res.status(400).json({ error: 'שם תלמיד הוא שדה חובה' });

        const trimmedName = name.trim();

        // 1. שמירה בטבלת התלמידים
        if (id) {
            await pool.query(
                `UPDATE students SET name=$1, default_quota=$2, fixed_lessons=$3, default_time_range=$4 WHERE id=$5`,
                [trimmedName, default_quota || 2, JSON.stringify(fixed_lessons || []), JSON.stringify(default_time_range || {start:"08:00", end:"21:00"}), id]
            );
        } else {
            await pool.query(
                `INSERT INTO students (name, default_quota, fixed_lessons, default_time_range) VALUES ($1, $2, $3, $4)`,
                [trimmedName, default_quota || 2, JSON.stringify(fixed_lessons || []), JSON.stringify(default_time_range || {start:"08:00", end:"21:00"})]
            );
        }

        // 2. עדכון/שיבוץ השיעורים הקבועים של התלמיד ביומן
        await pool.query("DELETE FROM appointments WHERE booked_by_name = $1 AND is_fixed = TRUE", [trimmedName]);
        const fixed = fixed_lessons || [];
        for (let f of fixed) {
            await pool.query(
                `INSERT INTO appointments (day_index, start_time, end_time, booked_by_name, is_custom, is_fixed) VALUES ($1, $2, $3, $4, $5, TRUE)`,
                [f.dayIndex, f.startTime, f.endTime, trimmedName, f.isCustom || false]
            );
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/students/delete', async (req, res) => {
    try {
        const { id } = req.body;
        const studentRes = await pool.query("SELECT name FROM students WHERE id = $1", [id]);
        if (studentRes.rows.length > 0) {
            const studentName = studentRes.rows[0].name;
            await pool.query("DELETE FROM appointments WHERE booked_by_name = $1", [studentName]);
            await pool.query("DELETE FROM weekly_student_config WHERE student_name = $1", [studentName]);
        }
        await pool.query("DELETE FROM students WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/students/weekly-override', async (req, res) => {
    try {
        const { student_name, quota_override, blocked_slots_override, allowed_custom_ranges } = req.body;
        
        await pool.query(`
            INSERT INTO weekly_student_config (student_name, quota_override, blocked_slots_override, allowed_custom_ranges)
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (student_name) DO UPDATE SET
                quota_override = EXCLUDED.quota_override,
                blocked_slots_override = EXCLUDED.blocked_slots_override,
                allowed_custom_ranges = EXCLUDED.allowed_custom_ranges
        `, [student_name, quota_override, JSON.stringify(blocked_slots_override || []), JSON.stringify(allowed_custom_ranges || [])]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/add-custom-slot', async (req, res) => {
    try {
        const { dayIndex, startTime, endTime, bookedByName } = req.body;
        if (dayIndex === undefined || !startTime || !endTime || !bookedByName) {
            return res.status(400).json({ error: 'שדות חובה חסרים' });
        }

        const startMins = timeToMinutes(startTime);
        const endMins = timeToMinutes(endTime);

        if (startMins >= endMins) {
            return res.status(400).json({ error: 'שעת הסיום חייבת להיות מאוחרת משעת ההתחלה' });
        }

        const allAppsRes = await pool.query("SELECT * FROM appointments WHERE day_index = $1", [dayIndex]);
        const conflict = allAppsRes.rows.some(app => {
            const appStart = timeToMinutes(app.start_time);
            const appEnd = timeToMinutes(app.end_time);
            return (startMins < appEnd && endMins > appStart);
        });

        if (conflict) {
            return res.status(400).json({ error: 'השעה שהוזנה חופפת לשיעור קיים ביומן ביום זה' });
        }

        await pool.query(
            `INSERT INTO appointments (day_index, start_time, end_time, booked_by_name, is_custom, is_fixed) VALUES ($1, $2, $3, $4, TRUE, FALSE)`,
            [dayIndex, startTime, endTime, bookedByName]
        );

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/toggle-status', async (req, res) => {
    try {
        const { isOpen, openMode, allowedStudents } = req.body;

        await pool.query("UPDATE settings SET value = $1 WHERE key = 'is_open'", [isOpen ? 'true' : 'false']);
        await pool.query("UPDATE settings SET value = $1 WHERE key = 'open_mode'", [openMode || 'all']);
        await pool.query("UPDATE settings SET value = $1 WHERE key = 'allowed_students'", [JSON.stringify(allowedStudents || [])]);

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/reset-slots', async (req, res) => {
    try {
        const { sundayDate, applyFixedLessons } = req.body;

        await pool.query("DELETE FROM appointments");
        await pool.query("DELETE FROM weekly_student_config");
        await pool.query("UPDATE settings SET value = $1 WHERE key = 'sunday_date'", [sundayDate || '']);

        if (applyFixedLessons) {
            const studentsRes = await pool.query("SELECT * FROM students");
            for (let s of studentsRes.rows) {
                const fixed = s.fixed_lessons || [];
                for (let f of fixed) {
                    await pool.query(
                        `INSERT INTO appointments (day_index, start_time, end_time, booked_by_name, is_custom, is_fixed) VALUES ($1, $2, $3, $4, $5, TRUE)`,
                        [f.dayIndex, f.startTime, f.endTime, s.name, f.isCustom || false]
                    );
                }
            }
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/delete-appointment', async (req, res) => {
    try {
        const { id } = req.body;
        await pool.query("DELETE FROM appointments WHERE id = $1", [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/export-ical', async (req, res) => {
    try {
        const settingsRes = await pool.query("SELECT * FROM settings");
        const settings = {};
        settingsRes.rows.forEach(s => settings[s.key] = s.value);
        const sundayDateStr = settings.sunday_date;

        if (!sundayDateStr) return res.status(400).send('טרם הוגדר תאריך ליום ראשון.');

        const appsRes = await pool.query("SELECT * FROM appointments");
        const [year, month, day] = sundayDateStr.split('-').map(Number);
        const baseSunday = new Date(year, month - 1, day);

        let ics = [
            'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//BookingSystem//HE', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'
        ];

        appsRes.rows.forEach(app => {
            const d = new Date(baseSunday);
            d.setDate(baseSunday.getDate() + app.day_index);
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const da = String(d.getDate()).padStart(2, '0');

            const [sH, sM] = app.start_time.split(':');
            const [eH, eM] = app.end_time.split(':');

            ics.push('BEGIN:VEVENT');
            ics.push(`SUMMARY:שיעור - ${app.booked_by_name}`);
            ics.push(`DTSTART:${y}${m}${da}T${sH}${sM}00`);
            ics.push(`DTEND:${y}${m}${da}T${eH}${eM}00`);
            ics.push('END:VEVENT');
        });

        ics.push('END:VCALENDAR');
        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="weekly_schedule.ics"');
        res.send(ics.join('\r\n'));
    } catch (err) {
        res.status(500).send('Error generating iCal');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));