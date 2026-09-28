require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
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

let memoryStore = {
    students: [],
    invoices: [],
    expenses: [],
    categories: [
        { id: 1, type: 'course_type', name: 'Beg' },
        { id: 2, type: 'course_type', name: 'Adv' },
        { id: 3, type: 'payment_method', name: 'Credit Card' },
        { id: 4, type: 'payment_method', name: 'Bank Transfer' },
        { id: 5, type: 'expense_category', name: 'Tools' },
        { id: 6, type: 'expense_category', name: 'Ads' }
    ],
    blockedSlots: [],
    appointments: [],
    settings: {
        is_open: 'true',
        open_mode: 'all',
        allowed_students: '[]',
        sunday_date: new Date().toISOString().split('T')[0]
    }
};

function calculateDatesFromSunday(sundayDateStr) {
    const daysNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
    if (!sundayDateStr) sundayDateStr = new Date().toISOString().split('T')[0];
    const [year, month, day] = sundayDateStr.split('-').map(Number);
    const baseSunday = new Date(year, month - 1, day);

    return daysNames.map((name, index) => {
        const d = new Date(baseSunday);
        d.setDate(baseSunday.getDate() + index);
        const isoDate = d.toISOString().split('T')[0];
        const formattedDate = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
        return { index, name, date: formattedDate, isoDate };
    });
}

// Settings API
app.get('/api/admin/settings', (req, res) => res.json(memoryStore.settings));
app.post('/api/admin/settings/save', (req, res) => {
    if (req.body.sunday_date) memoryStore.settings.sunday_date = req.body.sunday_date;
    res.json({ success: true });
});

// Categories API
app.get('/api/admin/categories', (req, res) => res.json({ categories: memoryStore.categories }));
app.post('/api/admin/categories/add', (req, res) => {
    const { type, name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });
    const newCat = { id: Date.now(), type, name };
    memoryStore.categories.push(newCat);
    res.json({ success: true });
});
app.post('/api/admin/categories/delete', (req, res) => {
    memoryStore.categories = memoryStore.categories.filter(c => c.id != req.body.id);
    res.json({ success: true });
});

// Students API
app.get('/api/admin/students-full', (req, res) => res.json({ students: memoryStore.students }));
app.post('/api/admin/students-full/save', (req, res) => {
    const sData = req.body;
    if (!sData || !sData.name) return res.status(400).json({ error: 'Student Name is required' });

    const durationMonths = Number(sData.process_duration_months) || 4;
    const validityMonths = durationMonths * 1.25;
    const startDateObj = sData.start_date ? new Date(sData.start_date) : new Date();
    const expObj = new Date(startDateObj);
    expObj.setMonth(expObj.getMonth() + Math.floor(validityMonths));
    const expDate = expObj.toISOString().split('T')[0];

    if (sData.id) {
        const idx = memoryStore.students.findIndex(s => s.id == sData.id);
        if (idx !== -1) memoryStore.students[idx] = { ...memoryStore.students[idx], ...sData, validity_expiration_date: expDate };
    } else {
        const newStudent = {
            id: Date.now(),
            ...sData,
            completed_lessons: 0,
            default_quota: sData.default_quota || 2,
            validity_expiration_date: expDate
        };
        memoryStore.students.push(newStudent);
    }
    res.json({ success: true });
});

// Blocked Slots API
app.get('/api/admin/blocked-slots', (req, res) => res.json({ blockedSlots: memoryStore.blockedSlots }));
app.post('/api/admin/blocked-slots', (req, res) => {
    const { dayIndex, startTime, endTime } = req.body;
    memoryStore.blockedSlots.push({
        id: Date.now(),
        day_index: Number(dayIndex),
        start_time: startTime,
        end_time: endTime
    });
    res.json({ success: true });
});

// Book Direct API
app.post('/api/admin/book-direct', (req, res) => {
    const { dayIndex, startTime, endTime, studentName } = req.body;
    const days = calculateDatesFromSunday(memoryStore.settings.sunday_date);
    const targetDate = days[dayIndex] ? days[dayIndex].isoDate : memoryStore.settings.sunday_date;

    memoryStore.appointments.push({
        id: Date.now(),
        day_index: Number(dayIndex),
        start_time: startTime,
        end_time: endTime,
        booked_by_name: studentName,
        appointment_date: targetDate
    });
    res.json({ success: true });
});

app.get('/api/slots', (req, res) => {
    const days = calculateDatesFromSunday(memoryStore.settings.sunday_date);
    res.json({ isOpen: true, fixedSlots: FIXED_SLOTS, days, appointments: memoryStore.appointments });
});

app.get('/api/admin/history-appointments', (req, res) => res.json({ appointments: memoryStore.appointments }));

// Invoices API
app.get('/api/admin/invoices', (req, res) => res.json({ invoices: memoryStore.invoices }));
app.post('/api/admin/invoices/save', (req, res) => {
    memoryStore.invoices.push({ id: Date.now(), ...req.body });
    res.json({ success: true });
});

// Expenses API
app.get('/api/admin/expenses', (req, res) => res.json({ expenses: memoryStore.expenses }));
app.post('/api/admin/expenses/save', (req, res) => {
    memoryStore.expenses.push({ id: Date.now(), ...req.body });
    res.json({ success: true });
});

// Reset Week API
app.post('/api/admin/reset-slots', (req, res) => {
    if (req.body.sundayDate) memoryStore.settings.sunday_date = req.body.sundayDate;
    memoryStore.appointments = [];
    res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running smoothly on port ${PORT}`));