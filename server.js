const express = require('express');
const { Pool } = require('pg');
const app = express();

app.use(express.json());
app.use(express.static('public'));

const LESSON_DURATION = 60; // משך שיעור בשעות (60 דקות)

// התחברות לבסיס הנתונים בענן
const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
    connectionString: connectionString,
    ssl: connectionString ? { rejectUnauthorized: false } : false
});

// יצירת טבלאות במידה ואינן קיימות
async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS appointments (
                id SERIAL PRIMARY KEY,
                day_index INTEGER,
                start_time VARCHAR(10),
                end_time VARCHAR(10),
                booked_by_name VARCHAR(100),
                booked_by_phone VARCHAR(50)
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key VARCHAR(50) PRIMARY KEY,
                value VARCHAR(100)
            )
        `);

        await pool.query("INSERT INTO settings (key, value) VALUES ('is_open', 'true') ON CONFLICT (key) DO NOTHING");
        await pool.query("INSERT INTO settings (key, value) VALUES ('buffer_time', '15') ON CONFLICT (key) DO NOTHING");
        await pool.query("INSERT INTO settings (key, value) VALUES ('sunday_date', '') ON CONFLICT (key) DO NOTHING");
        
        console.log('Connected successfully to Cloud PostgreSQL!');
    } catch (err) {
        console.error('Error initializing database:', err.message);
    }
}

initDb();

function timeToMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

function minutesToTime(mins) {
    const h = String(Math.floor(mins / 60)).padStart(2, '0');
    const m = String(mins % 60).padStart(2, '0');
    return `${h}:${m}`;
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

// API: קבלת הנתונים
app.get('/api/slots', async (req, res) => {
    try {
        const settingsRes = await pool.query("SELECT * FROM settings");
        const settings = {};
        settingsRes.rows.forEach(s => settings[s.key] = s.value);

        const isOpen = settings.is_open === 'true';
        const bufferTime = parseInt(settings.buffer_time || '15');
        const sundayDate = settings.sunday_date || '';

        const appsRes = await pool.query("SELECT * FROM appointments ORDER BY id ASC");
        const days = calculateDatesFromSunday(sundayDate);

        res.json({ 
            isOpen, 
            bufferTime, 
            sundayDate,
            lessonDuration: LESSON_DURATION,
            totalSlotTime: LESSON_DURATION + bufferTime,
            days, 
            appointments: appsRes.rows 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: הרשמה לתלמידים
app.post('/api/book', async (req, res) => {
    try {
        const openSetting = await pool.query("SELECT value FROM settings WHERE key = 'is_open'");
        if (openSetting.rows.length > 0 && openSetting.rows[0].value === 'false') {
            return res.status(403).json({ error: 'האתר סגור להרשמה כרגע. ניתן לצפות בלוח בלבד.' });
        }

        const bufferSetting = await pool.query("SELECT value FROM settings WHERE key = 'buffer_time'");
        const bufferTime = parseInt(bufferSetting.rows.length > 0 ? bufferSetting.rows[0].value : '15');
        const totalSlotTime = LESSON_DURATION + bufferTime;

        const { slots, name, phone } = req.body;

        if (!name || !phone || !slots || !Array.isArray(slots) || slots.length === 0) {
            return res.status(400).json({ error: 'נא למלא את כל השדות ולבחור לפחות שיעור אחד' });
        }

        const cleanPhone = phone.trim().replace(/[-\s]/g, '');

        const userApps = await pool.query("SELECT * FROM appointments WHERE REPLACE(REPLACE(booked_by_phone, '-', ''), ' ', '') = $1", [cleanPhone]);

        if (userApps.rows.length + slots.length > 2) {
            return res.status(400).json({ 
                error: `כבר רשומים עבורך ${userApps.rows.length} שיעורים. המכסה המרבית היא 2 שיעורים בשבוע.` 
            });
        }

        const allApps = await pool.query("SELECT * FROM appointments");

        for (let slot of slots) {
            const startMins = timeToMinutes(slot.startTime);
            const endMins = startMins + totalSlotTime;

            const hasConflict = allApps.rows.some(app => {
                if (app.day_index !== slot.dayIndex) return false;
                const appStart = timeToMinutes(app.start_time);
                const appEnd = timeToMinutes(app.end_time);
                return (startMins < appEnd && endMins > appStart);
            });

            if (hasConflict) {
                return res.status(400).json({ error: `השעה ${slot.startTime} חופפת לשיעור קיים ביומן.` });
            }
        }

        for (let slot of slots) {
            const startMins = timeToMinutes(slot.startTime);
            const endTime = minutesToTime(startMins + totalSlotTime);
            await pool.query(
                `INSERT INTO appointments (day_index, start_time, end_time, booked_by_name, booked_by_phone) VALUES ($1, $2, $3, $4, $5)`,
                [slot.dayIndex, slot.startTime, endTime, name, phone]
            );
        }

        res.json({ success: true, message: `השיבוץ בוצע בהצלחה!` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API למנהל: שינוי זמן ההפסקה
app.post('/api/admin/update-buffer', async (req, res) => {
    try {
        const { bufferTime } = req.body;
        await pool.query("UPDATE settings SET value = $1 WHERE key = 'buffer_time'", [String(bufferTime)]);
        res.json({ success: true, bufferTime });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API למנהל: שינוי מצב פתוח/סגור
app.post('/api/admin/toggle-status', async (req, res) => {
    try {
        const { isOpen } = req.body;
        const value = isOpen ? 'true' : 'false';
        await pool.query("UPDATE settings SET value = $1 WHERE key = 'is_open'", [value]);
        res.json({ success: true, isOpen });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API למנהל: איפוס מלא
app.post('/api/admin/reset-slots', async (req, res) => {
    try {
        const { sundayDate } = req.body;
        await pool.query("DELETE FROM appointments");
        await pool.query("UPDATE settings SET value = $1 WHERE key = 'sunday_date'", [sundayDate || '']);
        res.json({ success: true, message: 'היומן אופס בהצלחה והתאריך עודכן!' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API למנהל: מחיקת תור בודד
app.post('/api/admin/delete-appointment', async (req, res) => {
    try {
        const { id } = req.body;
        await pool.query("DELETE FROM appointments WHERE id = $1", [id]);
        res.json({ success: true, message: 'השיעור נמחק' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API למנהל: ייצוא קובץ iCal
app.get('/api/admin/export-ical', async (req, res) => {
    try {
        const settingsRes = await pool.query("SELECT * FROM settings");
        const settings = {};
        settingsRes.rows.forEach(s => settings[s.key] = s.value);
        const sundayDateStr = settings.sunday_date;

        if (!sundayDateStr) {
            return res.status(400).send('טרם הוגדר תאריך ליום ראשון.');
        }

        const appsRes = await pool.query("SELECT * FROM appointments");
        const apps = appsRes.rows;

        const [year, month, day] = sundayDateStr.split('-').map(Number);
        const baseSunday = new Date(year, month - 1, day);

        let icsContent = [
            'BEGIN:VCALENDAR',
            'VERSION:2.0',
            'PRODID:-//Booking System//Weekly Schedule//HE',
            'CALSCALE:GREGORIAN',
            'METHOD:PUBLISH'
        ];

        apps.forEach(app => {
            const appDate = new Date(baseSunday);
            appDate.setDate(baseSunday.getDate() + app.day_index);

            const y = appDate.getFullYear();
            const m = String(appDate.getMonth() + 1).padStart(2, '0');
            const d = String(appDate.getDate()).padStart(2, '0');

            const [startH, startMin] = app.start_time.split(':');
            const [endH, endMin] = app.end_time.split(':');

            const dtStart = `${y}${m}${d}T${startH}${startMin}00`;
            const dtEnd = `${y}${m}${d}T${endH}${endMin}00`;

            icsContent.push('BEGIN:VEVENT');
            icsContent.push(`SUMMARY:שיעור - ${app.booked_by_name}`);
            icsContent.push(`DESCRIPTION:תלמיד: ${app.booked_by_name}\\nטלפון: ${app.booked_by_phone}`);
            icsContent.push(`DTSTART:${dtStart}`);
            icsContent.push(`DTEND:${dtEnd}`);
            icsContent.push('END:VEVENT');
        });

        icsContent.push('END:VCALENDAR');

        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="weekly_schedule.ics"');
        res.send(icsContent.join('\r\n'));
    } catch (err) {
        res.status(500).send('שגיאה ביצירת הקובץ');
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});