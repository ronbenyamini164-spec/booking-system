// ============================================================================
//  import_from_sheet.js  —  ייבוא חד-פעמי של נתוני קובץ השיטס ל-Neon
//  הרצה:  node import_from_sheet.js
//  בטוח להרצה חוזרת (idempotent): מסנכרן מחדש בלי לשכפל רשומות.
// ============================================================================
require('dotenv').config();
const { Pool } = require('pg');

// אותה הגדרת חיבור בדיוק כמו server.js
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ---------------------------------------------------------------------------
//  הנתונים שחולצו מהשיטס (31 תלמידים, 71 תשלומים, 46 הוצאות)
// ---------------------------------------------------------------------------
const STUDENTS = [
  {
    "name": "Lior Ben Zaken",
    "phone": "503481444",
    "course_type": "Adv",
    "total_amount": 1000.0
  },
  {
    "name": "Nitay Zarhi",
    "phone": "523232524",
    "course_type": "Adv",
    "total_amount": 4300.0
  },
  {
    "name": "Feigy Kantner",
    "phone": "586002690",
    "course_type": "Beg",
    "total_amount": 1900.0
  },
  {
    "name": "Daniel Azulay",
    "phone": "547689411",
    "course_type": "Adv",
    "total_amount": 1000.0
  },
  {
    "name": "Shaked MAtityahu",
    "phone": "546885880",
    "course_type": "adv",
    "total_amount": 4500.0
  },
  {
    "name": "Bar Carter",
    "phone": "506429747",
    "course_type": null,
    "total_amount": 6500.0
  },
  {
    "name": "Liad Ashkenazi",
    "phone": null,
    "course_type": "Beg",
    "total_amount": 3500.0
  },
  {
    "name": "Gaya Levi",
    "phone": "506662932",
    "course_type": "Beg",
    "total_amount": 1375.0
  },
  {
    "name": "Almog Levi",
    "phone": "533350779",
    "course_type": "Beg",
    "total_amount": 5000.0
  },
  {
    "name": "Hod Ben David",
    "phone": "524357000",
    "course_type": "Adv",
    "total_amount": 5000.0
  },
  {
    "name": "Or Shahar",
    "phone": "502228005",
    "course_type": "Adv",
    "total_amount": 4900.0
  },
  {
    "name": "Sahar Barblat",
    "phone": "544663788",
    "course_type": "Adv",
    "total_amount": 7700.0
  },
  {
    "name": "Elroi Ariye",
    "phone": "542253398",
    "course_type": "Beg",
    "total_amount": 4900.0
  },
  {
    "name": "Shalom Taub",
    "phone": "502156516",
    "course_type": "Beg",
    "total_amount": 4000.0
  },
  {
    "name": "Mirav Margliot",
    "phone": "505922245",
    "course_type": null,
    "total_amount": 2000.0
  },
  {
    "name": "Eitan Hugi",
    "phone": "556684170",
    "course_type": null,
    "total_amount": 4800.0
  },
  {
    "name": "Elior Makri",
    "phone": "523854471",
    "course_type": null,
    "total_amount": 4800.0
  },
  {
    "name": "Rawad Nibuani",
    "phone": "502469511",
    "course_type": null,
    "total_amount": 4800.0
  },
  {
    "name": "Reem Hagag",
    "phone": "543144552",
    "course_type": "Adv",
    "total_amount": 4000.0
  },
  {
    "name": "Yuval Vered",
    "phone": "585540128",
    "course_type": "Beg",
    "total_amount": 4000.0
  },
  {
    "name": "Sharon Vardi",
    "phone": "526866629",
    "course_type": "Adv",
    "total_amount": 2000.0
  },
  {
    "name": "Osher Arbel",
    "phone": "54-214-4456",
    "course_type": "Adv",
    "total_amount": 4800.0
  },
  {
    "name": "Liat Ofer",
    "phone": "52-591-4888",
    "course_type": "Beg",
    "total_amount": 2880.0
  },
  {
    "name": "Noam Vanunu",
    "phone": "52-571-5573",
    "course_type": "Adv",
    "total_amount": 3200.0
  },
  {
    "name": "Lavi Medina",
    "phone": "050-989-4899",
    "course_type": "Adv",
    "total_amount": 2880.0
  },
  {
    "name": "Sapir Fisher Amar",
    "phone": "052-6691055",
    "course_type": "Adv",
    "total_amount": 2880.0
  },
  {
    "name": "Esti Arzi Lerner",
    "phone": "54-243-199",
    "course_type": "Adv",
    "total_amount": 5184.0
  },
  {
    "name": "Yehuda Ben Ezra",
    "phone": "058-485-1527",
    "course_type": "Adv",
    "total_amount": 2880.0
  },
  {
    "name": "Yehonatan Shpnaier",
    "phone": "054-222-8603",
    "course_type": "Adv",
    "total_amount": 2880.0
  },
  {
    "name": "Yarden Shalom",
    "phone": "055-666-1138",
    "course_type": "Adv",
    "total_amount": 2880.0
  },
  {
    "name": "Ariel Hurin",
    "phone": "050-444-2113",
    "course_type": "Beg",
    "total_amount": 5184.0
  }
];
const INVOICES = [
  {
    "invoice_number": "98/300002",
    "student_name": "Lior Ben Zaken",
    "invoice_date": "2025-12-09",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "2260",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 500.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300003",
    "student_name": "Nitay Zarhi",
    "invoice_date": "2025-12-10",
    "period_covered": "Full",
    "payment_method": "Credit Card",
    "reference_number": "2613",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1900.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300004",
    "student_name": "Feigy Kantner",
    "invoice_date": "2025-12-10",
    "period_covered": "Full",
    "payment_method": "Bank Transfer",
    "reference_number": null,
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1900.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300001",
    "student_name": "Daniel Azulay",
    "invoice_date": "2025-12-10",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": null,
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300006",
    "student_name": "Shaked MAtityahu",
    "invoice_date": "2026-01-14",
    "period_covered": "Partial",
    "payment_method": "Credit Card",
    "reference_number": "6685",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 2250.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300007",
    "student_name": "Bar Carter",
    "invoice_date": "2026-01-25",
    "period_covered": "Full",
    "payment_method": "Credit Card",
    "reference_number": "Zero + 335",
    "transaction_id": "93554709",
    "notes": null,
    "is_refund": false,
    "amount_payed": 6500.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/30008",
    "student_name": "Liad Ashkenazi",
    "invoice_date": "2026-01-30",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "99011",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 875.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/30009",
    "student_name": "Gaya Levi",
    "invoice_date": "2026-02-25",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "#N/A",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1375.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300010",
    "student_name": "Shaked MAtityahu",
    "invoice_date": "2026-03-12",
    "period_covered": "Partial",
    "payment_method": "Credit Card",
    "reference_number": "6685",
    "transaction_id": "\"0012765\"",
    "notes": null,
    "is_refund": false,
    "amount_payed": 2250.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300012",
    "student_name": "Almog Levi",
    "invoice_date": "2026-03-16",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "166422",
    "transaction_id": "166422",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1250.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300013",
    "student_name": "Liad Ashkenazi",
    "invoice_date": "2026-03-19",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "99011",
    "transaction_id": "99011",
    "notes": null,
    "is_refund": false,
    "amount_payed": 875.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300014",
    "student_name": "Hod Ben David",
    "invoice_date": "2026-03-29",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "99012",
    "transaction_id": "9012",
    "notes": "29/3/26, 22/03/2026",
    "is_refund": false,
    "amount_payed": 1250.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300015",
    "student_name": "Or Shahar",
    "invoice_date": "2026-03-29",
    "period_covered": "Partial",
    "payment_method": "Credit Card",
    "reference_number": "6678070",
    "transaction_id": "6678070",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1225.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300016",
    "student_name": "Sahar Barblat",
    "invoice_date": "2026-03-30",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": "\"0224410\"",
    "transaction_id": "\"0224410\"",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1225.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300017",
    "student_name": "Elroi Ariye",
    "invoice_date": "2026-04-23",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "99046",
    "transaction_id": "99046",
    "notes": "23/4/26, 13/04/2026",
    "is_refund": false,
    "amount_payed": 1225.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300018",
    "student_name": "Shalom Taub",
    "invoice_date": "2026-04-27",
    "period_covered": "Partial",
    "payment_method": "Credit Card",
    "reference_number": "\"020579\"",
    "transaction_id": "\"020579\"",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300019",
    "student_name": "Almog Levi",
    "invoice_date": "2026-04-29",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "166422",
    "transaction_id": "22915",
    "notes": "29/4/26,28/04/2026,27/04/2026",
    "is_refund": false,
    "amount_payed": 1250.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300021",
    "student_name": "Mirav Margliot",
    "invoice_date": "2026-05-01",
    "period_covered": "Partial",
    "payment_method": "Credit Card",
    "reference_number": "\"044358\"",
    "transaction_id": "\"044358\"",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300023",
    "student_name": "Eitan Hugi",
    "invoice_date": "2026-05-04",
    "period_covered": "Full",
    "payment_method": "Bank Transfer",
    "reference_number": "99014",
    "transaction_id": "99014",
    "notes": "4/5/26, 03/05/2026",
    "is_refund": false,
    "amount_payed": 4800.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300024",
    "student_name": "Liad Ashkenazi",
    "invoice_date": "2026-05-07",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "99011",
    "transaction_id": "99011",
    "notes": "7/5/26,05/05/2026",
    "is_refund": false,
    "amount_payed": 875.0,
    "payment_number": 3
  },
  {
    "invoice_number": "98/300025",
    "student_name": "Elior Makri",
    "invoice_date": "2026-05-11",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": "1078-3935-25369",
    "transaction_id": "1078-3935-25369",
    "notes": null,
    "is_refund": false,
    "amount_payed": 2400.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300026",
    "student_name": "Sahar Barblat",
    "invoice_date": "2026-05-11",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": "\"0224410\"",
    "transaction_id": "1078-3938-08530",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1225.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300027",
    "student_name": "Hod Ben David",
    "invoice_date": "2026-05-13",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "99012",
    "transaction_id": "99012",
    "notes": "13/5/26,12/05/2026",
    "is_refund": false,
    "amount_payed": 1250.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300028",
    "student_name": "Rawad Nibuani",
    "invoice_date": "2026-05-18",
    "period_covered": "Full",
    "payment_method": "Bank Transfer",
    "reference_number": "7752",
    "transaction_id": "127752",
    "notes": null,
    "is_refund": false,
    "amount_payed": 4800.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300005",
    "student_name": "Lior Ben Zaken",
    "invoice_date": "2026-01-05",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "5326",
    "transaction_id": "31455326",
    "notes": null,
    "is_refund": false,
    "amount_payed": 500.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300029",
    "student_name": "Reem Hagag",
    "invoice_date": "2026-05-18",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "9951",
    "transaction_id": "\"009951\"",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300030",
    "student_name": "Or Shahar",
    "invoice_date": "2026-05-19",
    "period_covered": "Partial",
    "payment_method": "Credit Card",
    "reference_number": "\"0430488\"",
    "transaction_id": "\"0430488\"",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1225.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300031",
    "student_name": "Yuval Vered",
    "invoice_date": "2026-05-25",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "8517",
    "transaction_id": "198517",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300032",
    "student_name": "Sharon Vardi",
    "invoice_date": "2026-05-26",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "4654",
    "transaction_id": "460784654",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300033",
    "student_name": "Almog Levi",
    "invoice_date": "2026-05-31",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "\"0010\"",
    "transaction_id": "26052919322797700010",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1250.0,
    "payment_number": 3
  },
  {
    "invoice_number": "98/300034",
    "student_name": "Mirav Margliot",
    "invoice_date": "2026-06-03",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": "\"047381\"",
    "transaction_id": "\"047381\"",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300035",
    "student_name": "Elroi Ariye",
    "invoice_date": "2026-06-04",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "\"06941881\"",
    "transaction_id": "1881",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1225.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300036",
    "student_name": "Liad Ashkenazi",
    "invoice_date": "2026-06-07",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": "1078-4732-19211",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 875.0,
    "payment_number": 4
  },
  {
    "invoice_number": "98/300037",
    "student_name": "Hod Ben David",
    "invoice_date": "2026-06-08",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "99012",
    "transaction_id": "9012",
    "notes": null,
    "is_refund": false,
    "amount_payed": 2500.0,
    "payment_number": 3
  },
  {
    "invoice_number": "98/300039",
    "student_name": "Osher Arbel",
    "invoice_date": "2026-06-11",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "721026",
    "transaction_id": "1026",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1800.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300040",
    "student_name": "Sahar Barblat",
    "invoice_date": "2026-06-11",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": "1078-4888-16439",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1225.0,
    "payment_number": 3
  },
  {
    "invoice_number": "98/300041",
    "student_name": "Liat Ofer",
    "invoice_date": "2026-06-14",
    "period_covered": "Partial",
    "payment_method": "Credit Card",
    "reference_number": "5358368",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1440.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300042",
    "student_name": "Or Shahar",
    "invoice_date": "2026-06-20",
    "period_covered": "Partial",
    "payment_method": "Credit Card",
    "reference_number": "6468181",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1225.0,
    "payment_number": 3
  },
  {
    "invoice_number": "98/300043",
    "student_name": "Reem Hagag",
    "invoice_date": "2026-06-25",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "1366",
    "transaction_id": "\"021366\"",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300044",
    "student_name": "Yuval Vered",
    "invoice_date": "2026-06-25",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "7151",
    "transaction_id": "97151",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300045",
    "student_name": "Noam Vanunu",
    "invoice_date": "2026-06-30",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "2925",
    "transaction_id": "467432925",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1600.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300046",
    "student_name": "Shalom Taub",
    "invoice_date": "2026-07-02",
    "period_covered": "Partial",
    "payment_method": "Credit Card",
    "reference_number": null,
    "transaction_id": "\"073559\"",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300047",
    "student_name": "Almog Levi",
    "invoice_date": "2026-07-03",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "3877",
    "transaction_id": "73877",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1250.0,
    "payment_number": 4
  },
  {
    "invoice_number": "98/300048",
    "student_name": "Lavi Medina",
    "invoice_date": "2026-07-05",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": "1078-5602-58589",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1440.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300049",
    "student_name": "Sapir Fisher Amar",
    "invoice_date": "2026-07-10",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": "1078-5644-68339",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1400.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300050",
    "student_name": "Nitay Zarhi",
    "invoice_date": "2026-07-11",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "7537",
    "transaction_id": "469867537",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/800002",
    "student_name": "Hod Ben David",
    "invoice_date": "2026-07-12",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": null,
    "transaction_id": null,
    "notes": null,
    "is_refund": true,
    "amount_payed": -1500.0,
    "payment_number": 4
  },
  {
    "invoice_number": "98/300051",
    "student_name": "Elroi Ariye",
    "invoice_date": "2026-07-13",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "\"001260712\"",
    "transaction_id": "\"0712\"",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1225.0,
    "payment_number": 3
  },
  {
    "invoice_number": "98/300052",
    "student_name": "Sharon Vardi",
    "invoice_date": "2026-07-13",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "470324043",
    "transaction_id": "4043",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300053",
    "student_name": "Sapir Fisher Amar",
    "invoice_date": "2026-07-15",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": "1078-5893-23183",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1480.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300054",
    "student_name": "Liat Ofer",
    "invoice_date": "2026-07-15",
    "period_covered": "Partial",
    "payment_method": "Credit Card",
    "reference_number": null,
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1440.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300055",
    "student_name": "Osher Arbel",
    "invoice_date": "2026-07-16",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "1394",
    "transaction_id": "\"041394\"",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300056",
    "student_name": "Esti Arzi Lerner",
    "invoice_date": "2026-07-27",
    "period_covered": "Partial",
    "payment_method": "Credit Card",
    "reference_number": null,
    "transaction_id": "\"0022285\"",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1296.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300057",
    "student_name": "Reem Hagag",
    "invoice_date": "2026-07-28",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "7739",
    "transaction_id": "\"027739\"",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 3
  },
  {
    "invoice_number": "98/300058",
    "student_name": "Yuval Vered",
    "invoice_date": "2026-07-28",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "7110",
    "transaction_id": "97110",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 3
  },
  {
    "invoice_number": "98/300059",
    "student_name": "Noam Vanunu",
    "invoice_date": "2026-08-02",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "3476",
    "transaction_id": "473733476",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1600.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300060",
    "student_name": "Lavi Medina",
    "invoice_date": "2026-08-09",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": "1078-6640-03317",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1440.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300061",
    "student_name": "Sahar Barblat",
    "invoice_date": "2026-08-13",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": "1078-6777-07479",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1225.0,
    "payment_number": 4
  },
  {
    "invoice_number": "98/300062",
    "student_name": "Or Shahar",
    "invoice_date": "2026-08-16",
    "period_covered": "Partial",
    "payment_method": "Credit Card",
    "reference_number": "\"0807727\"",
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1225.0,
    "payment_number": 4
  },
  {
    "invoice_number": "98/300063",
    "student_name": "Osher Arbel",
    "invoice_date": "2026-08-21",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "7437",
    "transaction_id": "827437",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 3
  },
  {
    "invoice_number": "98/300064",
    "student_name": "Yehuda Ben Ezra",
    "invoice_date": "2026-08-24",
    "period_covered": "Full",
    "payment_method": "Bank Transfer",
    "reference_number": "\"0001\"",
    "transaction_id": "1850000000000000001",
    "notes": null,
    "is_refund": false,
    "amount_payed": 2880.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300064",
    "student_name": "Yehonatan Shpnaier",
    "invoice_date": "2026-08-24",
    "period_covered": "Full",
    "payment_method": "Bank Transfer",
    "reference_number": "\"0001\"",
    "transaction_id": "1850000000000000001",
    "notes": null,
    "is_refund": false,
    "amount_payed": 2880.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300065",
    "student_name": "Yarden Shalom",
    "invoice_date": "2026-08-26",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": null,
    "transaction_id": "1000-7871-66940 + 1000-7871-67144",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 1
  },
  {
    "invoice_number": "98/300066",
    "student_name": "Reem Hagag",
    "invoice_date": "2026-08-28",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "\"0005\"",
    "transaction_id": "4000000000000750005",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 4
  },
  {
    "invoice_number": "98/300067",
    "student_name": "Yuval Vered",
    "invoice_date": "2026-08-31",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "6828",
    "transaction_id": "136828",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 4
  },
  {
    "invoice_number": null,
    "student_name": "Esti Arzi Lerner",
    "invoice_date": "2026-08-27",
    "period_covered": "Partial",
    "payment_method": "Credit Card",
    "reference_number": null,
    "transaction_id": null,
    "notes": null,
    "is_refund": false,
    "amount_payed": 1296.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300068",
    "student_name": "Elior Makri",
    "invoice_date": "2026-09-12",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": null,
    "transaction_id": "1078-7575-12336",
    "notes": null,
    "is_refund": false,
    "amount_payed": 2400.0,
    "payment_number": 2
  },
  {
    "invoice_number": "98/300069",
    "student_name": "Sahar Barblat",
    "invoice_date": "2026-09-12",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": null,
    "transaction_id": "1078-7593-51795",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1400.0,
    "payment_number": 5
  },
  {
    "invoice_number": "98/300070",
    "student_name": "Shalom Taub",
    "invoice_date": "2026-09-21",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": null,
    "transaction_id": "1078-7785-24801",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1000.0,
    "payment_number": 3
  },
  {
    "invoice_number": "98/300071",
    "student_name": "Elroi Ariye",
    "invoice_date": "2026-09-27",
    "period_covered": "Partial",
    "payment_method": "Bit",
    "reference_number": null,
    "transaction_id": "1078-8119-29129",
    "notes": null,
    "is_refund": false,
    "amount_payed": 1225.0,
    "payment_number": 4
  },
  {
    "invoice_number": "98/300072",
    "student_name": "Ariel Hurin",
    "invoice_date": "2026-09-27",
    "period_covered": "Partial",
    "payment_method": "Bank Transfer",
    "reference_number": "9680",
    "transaction_id": "\"029680\"",
    "notes": null,
    "is_refund": false,
    "amount_payed": 2592.0,
    "payment_number": 1
  }
];
const EXPENSES = [
  {
    "expense_date": "2026-01-31",
    "tr_name": "Meta Ads - All Invoices",
    "category": "Ads",
    "amount": 1219.54,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/f/c/bcf1f0de99afc5f7/IgDy2LVoIEe7S5RakuicGKeeAXlkHfAysy97mPSXTsH26rc?e=bceTWK",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-01-05",
    "tr_name": "Zoom Subscription (Yearly)",
    "category": "Tools",
    "amount": 467.11,
    "payment_method": "Card (8432)",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQD1g48oRPglQoORh92BYzINAftwa1IcOceqwyoZi7Sv178?e=913Esm",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-01-02",
    "tr_name": "Isracard עמלות",
    "category": "Other",
    "amount": 21.31,
    "payment_method": null,
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQBriTOUEwkhRZTouKfywnLOAfIMOrvIjaIpIAekc1XTSsw?e=cNiT60",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-01-30",
    "tr_name": "CapCut Subscription (Yearly)",
    "category": "Tools",
    "amount": 499.99,
    "payment_method": "Card (7148)",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQDv5AbG4TR5T5ooj71J_byrAQSoIl6NSbv6Zn_aj3noaWk?e=E0QNxO",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-01-04",
    "tr_name": "OpenAI Subscription (Monthly)",
    "category": "Tools",
    "amount": 58.39,
    "payment_method": "Card (8432)",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQAVcK41gORGS7rF011Ha8A-AY9GgNMHD0ViGl7dKX_bjOk?e=FUo59a",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-01-28",
    "tr_name": "Aviv Sales Coach",
    "category": "Other",
    "amount": 5015.43,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/i/c/bcf1f0de99afc5f7/IQBwgMAGa9dkRJzD3gTrsSQAAShxlewJfDxyn0VPj6C3rsY",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-02-16",
    "tr_name": "Office Rent (Monthly)",
    "category": "Rent",
    "amount": 1770.0,
    "payment_method": "Bank Transfer",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQDMGTVSXeKsSYaU5jBDLXTbAdHVSidSKZGK8mPn2P9Rqx4?e=1BQWIO",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-02-28",
    "tr_name": "Isracard עמלות",
    "category": "Other",
    "amount": 118.89,
    "payment_method": null,
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQBlBBIWL7oSRrDP1HgJ0gtjAX5gR9idY_40nKkUqeg1M8I?e=LOxmfA",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-02-28",
    "tr_name": "Isracard עמלות",
    "category": "Other",
    "amount": 25.23,
    "payment_method": null,
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQARQjcE3l34TpVupQfUYytDAWa5bj8AH3RCLoTwscvVjhg?e=YmYUs8",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-02-28",
    "tr_name": "Meta Ads - All Invoices",
    "category": "Ads",
    "amount": 2230.59,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/f/c/bcf1f0de99afc5f7/IgCYINzQAPIrT5iqW-pAnEyaAdLrJ6Wh9-vGgMX78oTwtDY?e=4QFeaE",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-02-23",
    "tr_name": "Office Rent (3 Months)",
    "category": "Rent",
    "amount": 5310.0,
    "payment_method": "Check",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQDX-IYWpfPAQIAOxdBSCVavActes0Ki7ayXscbDQLqVN8k?e=GTaLiu",
    "notes": "3 Months Rent / Sent to Paperless"
  },
  {
    "expense_date": "2026-02-04",
    "tr_name": "OpenAI Subscription (Monthly)",
    "category": "Tools",
    "amount": 58.39,
    "payment_method": "Card (8432)",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQAAGZ3A1mE1TY-GGn8nlv91AesMBxclu1ClzQwWq7fhc-E?e=JS9S7b",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-03-31",
    "tr_name": "Meta Ads - All Invoices",
    "category": "Ads",
    "amount": 2294.0,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/f/c/bcf1f0de99afc5f7/IgAoIIoDT1s_RZdMS71DLMPgAYVzbf6c69J3M6B2iy-2KiI?e=BBQfV7",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-03-17",
    "tr_name": "Office Rent (Monthly)",
    "category": "Rent",
    "amount": 1770.0,
    "payment_method": "Bank Transfer",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/f/c/bcf1f0de99afc5f7/IgC35cORKlTKRLmG7VLUp8rwAe2lnKUVfRtRkNlB3Cxopfo?e=9tdfHU",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-03-04",
    "tr_name": "OpenAI Subscription (Monthly)",
    "category": "Tools",
    "amount": 58.39,
    "payment_method": "Card (8432)",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQCyErptNH9MQ693z9G2Uz7iASw7E_PBS1DY50pkq3UihGk?e=uldtBz",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-04-30",
    "tr_name": "Meta Ads - All Invoices",
    "category": "Ads",
    "amount": 1488.31,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/f/c/bcf1f0de99afc5f7/IgCm0WzXNK7mSJwmWnxMKkufAWYLtn_nGz5qvOL-miQzHIE?e=aPgNTl",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-04-20",
    "tr_name": "Office Rent (Monthly)",
    "category": "Rent",
    "amount": 1770.0,
    "payment_method": "Bank Transfer",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/f/c/bcf1f0de99afc5f7/IgBXOHc6SnaJRZN7Ln18YwweAQUW6em8k_q-VSlun7x6SZs?e=U3ef7f",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-04-01",
    "tr_name": "Isracard עמלות",
    "category": "Other",
    "amount": 52.71,
    "payment_method": null,
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/f/c/bcf1f0de99afc5f7/IgCqlzBLWFNsSZRaVkHsWG0QAXYV9QCiMcgHOdPhR7TI-A8?e=qjOHuc",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-04-04",
    "tr_name": "OpenAI Subscription (Monthly)",
    "category": "Tools",
    "amount": 58.39,
    "payment_method": "Card (8432)",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQCad2tRDce7SaMCm7xnJhceAdAlJWw-oZWjkiYmOzP-2yc?e=iDIivw",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-05-05",
    "tr_name": "OpenAI Subscription (Monthly)",
    "category": "Tools",
    "amount": 58.39,
    "payment_method": "Card (8432)",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQCBuFvuWIykQITM75aMpt69AaCJ3ba3KdraAstSsb5G75g?e=EEK26e",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-05-17",
    "tr_name": "Office Rent (Monthly)",
    "category": "Rent",
    "amount": 1770.0,
    "payment_method": "Bank Transfer",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQCTRGt16dluS5jTjuvNmTOHAdxe9ZiMYSg4jRz-F4_Fq20?e=zel2Vj",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-05-20",
    "tr_name": "Whisper Transcription Lifetime Subscription",
    "category": "Tools",
    "amount": 161.9,
    "payment_method": "Card (7148)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/i/c/bcf1f0de99afc5f7/IQD6HrnvHdC4S4Pp9uA4zAh9ARUePTSGxh9YPMm8yClJgtY?e=dUml2E",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-05-31",
    "tr_name": "Meta Ads - All Invoices",
    "category": "Ads",
    "amount": 2646.52,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/f/c/bcf1f0de99afc5f7/IgCF93gD4XBMQ6_p9GcB59-oAUZZg2eO8Kdf_2IezbRlfAs?e=M9Wet8",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-05-03",
    "tr_name": "Isracard עמלות",
    "category": "Other",
    "amount": 11.21,
    "payment_method": null,
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQA72QALNEEtQI5kGrRRPc4pATF7oID7BuTbm4KnZgmZUvw?e=YVGBpF",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-06-07",
    "tr_name": "Claude Pro Subscription",
    "category": "Tools",
    "amount": 581.6,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQDWEwvVDWq7SaFSeB2eT2-nAblx1BcStvWRUAqcz84EI7s?e=1jvnUG",
    "notes": "Sent to Paperless / Yearly Payment"
  },
  {
    "expense_date": "2026-06-12",
    "tr_name": "Claude Credits",
    "category": "Tools",
    "amount": 14.63,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQD1WR1mSV7dSL03mocD7wJtAZMGcUliHDJpYX4p7yVM2cg?e=glffJd",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-06-12",
    "tr_name": "Accountant",
    "category": "Other",
    "amount": 177.0,
    "payment_method": "Card (8432)",
    "recurring": "Yes",
    "invoice_received": "No",
    "file_link": null,
    "notes": null
  },
  {
    "expense_date": "2026-06-16",
    "tr_name": "Office Rent (Monthly)",
    "category": "Rent",
    "amount": 1770.0,
    "payment_method": "Bank Transfer",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQAhPUYKYVn0TZx8j5_G1ui-Ac91HgTdPRzmibDFgBuIeIo?e=VeYhHs",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-06-24",
    "tr_name": "Claude Credits",
    "category": "Tools",
    "amount": 134.41,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQAvpBAL0mU6SrcwTJD9Mj8RAdIw9oXBnPyOKejp6Cb53nw?e=Vi3KWE",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-06-20",
    "tr_name": "Car Gas",
    "category": "Other",
    "amount": 127.9,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/i/c/bcf1f0de99afc5f7/IQByS5azEAGaRZvNS1t1njdoAbc_wXUfkDHhMmkUVMHUaaU?e=AMhgFO",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-06-27",
    "tr_name": "Meta Ads - All Invoices",
    "category": "Ads",
    "amount": 1184.23,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/f/c/bcf1f0de99afc5f7/IgCLabtB4U--RLbvuMwq3HG0AYZDo-dFCZi8uaN9CSHqGI0?e=jRU7jQ",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-06-13",
    "tr_name": "Claude Credits",
    "category": "Tools",
    "amount": 14.99,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQDwZlRWXQMQSJBz707m7aPGAfdC7ZaciM3xS_UZHPZekBE?e=Yg2i1V",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-06-02",
    "tr_name": "Isracard עמלות",
    "category": "Other",
    "amount": 24.95,
    "payment_method": null,
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQDsOSTqtO4ySpMypzqYBAeIAfHTpfwGi2dzV6lhqomjb-8?e=1FewJ2",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-07-09",
    "tr_name": "Claude Credits",
    "category": "Tools",
    "amount": 135.25,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQCoFk67qniGQLnCMkTqKZrBATmh5g8TytyfbzcC84s9NOs?e=GqCKNy",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-07-12",
    "tr_name": "Accountant",
    "category": "Other",
    "amount": 177.0,
    "payment_method": "Card (8432)",
    "recurring": "Yes",
    "invoice_received": "No",
    "file_link": null,
    "notes": null
  },
  {
    "expense_date": "2026-07-20",
    "tr_name": "Office Rent (Monthly)",
    "category": "Rent",
    "amount": 1770.0,
    "payment_method": "Bank Transfer",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQBbwuny2ArjRZmmqDRvQrXuAcLcr4GviM5P_lEIQO_bXa4?e=246tcn",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-07-20",
    "tr_name": "Claude Credits",
    "category": "Tools",
    "amount": 137.08,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQAm9Bxar-GyRrsnQVpbCswEAQiEqBb_C2kPPihL64I0qmw?e=wiBErT",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-07-30",
    "tr_name": "Claude Credits",
    "category": "Tools",
    "amount": 137.28,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQC-ZcyRZVk3Qql-AeI7yv8MARPQMEIJqXdU8uCxBjJRlU4?e=WVqtDo",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-07-30",
    "tr_name": "Car Gas",
    "category": "Other",
    "amount": 209.28,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQCPzh1wC_fZRIRyScgKzGkiATbgvP-ZMK29rCOlK8VfqbE?e=hUq7bA",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-08-01",
    "tr_name": "Claude Credits",
    "category": "Tools",
    "amount": 137.83,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQAwVouuvbTiT4pUXPPYTjo_ATzSQ5fifaSLxuhfJ5_NMq8?e=FuhoBH",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-08-10",
    "tr_name": "Memory SSD",
    "category": "Other",
    "amount": 594.0,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/i/c/bcf1f0de99afc5f7/IQC4OuB343PqS5nmd33HRzJcAW9Jzh7-CVQbgMyF_NIXOGg?e=CQkbtv",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-08-12",
    "tr_name": "Accountant",
    "category": "Other",
    "amount": 177.0,
    "payment_method": "Card (8432)",
    "recurring": "Yes",
    "invoice_received": "No",
    "file_link": null,
    "notes": null
  },
  {
    "expense_date": "2026-09-06",
    "tr_name": "Claude Max Subscription",
    "category": "Tools",
    "amount": 98.84,
    "payment_method": "Card (8432)",
    "recurring": "No",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQDCJVah6KCjQZ3_ayCKpiG9AVYiWeaTKe_8RlaLVoB77j8?e=7ZQwC3",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-09-06",
    "tr_name": "Office Rent (Monthly)",
    "category": "Rent",
    "amount": 1770.0,
    "payment_method": "Bank Transfer",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQDYvWRHqEx4QaIL4vXUtsNKAVS2EzawSlvV3IJuJdT9194?e=4PSWYK",
    "notes": "Sent to Paperless"
  },
  {
    "expense_date": "2026-09-12",
    "tr_name": "Accountant",
    "category": "Other",
    "amount": 177.0,
    "payment_method": "Card (8432)",
    "recurring": "Yes",
    "invoice_received": "No",
    "file_link": null,
    "notes": null
  },
  {
    "expense_date": "2026-09-22",
    "tr_name": "Office Rent (Monthly)",
    "category": "Rent",
    "amount": 1770.0,
    "payment_method": "Bank Transfer",
    "recurring": "Yes",
    "invoice_received": "Yes",
    "file_link": "https://1drv.ms/b/c/bcf1f0de99afc5f7/IQABqPO8oGVpRK5h9rEBXz_vAbgeMDn_BJlindH2ZaXUUL8?e=DIz6St",
    "notes": "Sent to Paperless"
  }
];

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ---- 1) הרחבת סכימה: עמודות חדשות (לא מוחק שום דבר קיים) ----------------
    await client.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS period_covered  VARCHAR(50);`);
    await client.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS reference_number VARCHAR(100);`);
    await client.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS transaction_id   VARCHAR(100);`);
    await client.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS notes            TEXT;`);
    await client.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_refund        BOOLEAN DEFAULT FALSE;`);
    await client.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_number   INTEGER;`);

    await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method   VARCHAR(50);`);
    await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS recurring        VARCHAR(10);`);
    await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS invoice_received VARCHAR(10);`);
    await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS file_link        TEXT;`);
    await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS notes            TEXT;`);

    // ---- 2) תלמידים: upsert לפי שם (מעדכן קיימים, מוסיף חדשים, לא משכפל) -----
    //     שדות התזמון (default_quota, allowed_slots וכו') נשמרים כמו שהם.
    for (const s of STUDENTS) {
      await client.query(
        `INSERT INTO students (name, phone, course_type, total_amount)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (name) DO UPDATE SET
           phone        = COALESCE(EXCLUDED.phone, students.phone),
           course_type  = COALESCE(EXCLUDED.course_type, students.course_type),
           total_amount = EXCLUDED.total_amount`,
        [s.name, s.phone, s.course_type, s.total_amount]
      );
    }

    // ---- 3) חשבוniות: מנקה קודם את החשבוניות של התלמידים המיובאים ואז מכניס --
    //     (כדי שהרצה חוזרת לא תשכפל). לא נוגע בחשבוניות של תלמידים אחרים.
    const names = STUDENTS.map(s => s.name);
    await client.query(`DELETE FROM invoices WHERE student_name = ANY($1)`, [names]);
    for (const i of INVOICES) {
      await client.query(
        `INSERT INTO invoices
           (invoice_number, student_name, invoice_date, period_covered, payment_method,
            reference_number, transaction_id, notes, is_refund, amount_payed, payment_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [i.invoice_number, i.student_name, i.invoice_date, i.period_covered, i.payment_method,
         i.reference_number, i.transaction_id, i.notes, i.is_refund, i.amount_payed, i.payment_number]
      );
    }

    // ---- 4) הוצאות: dedup לפי (תאריך + שם + סכום) ואז הכנסה -----------------
    for (const e of EXPENSES) {
      await client.query(
        `DELETE FROM expenses
          WHERE expense_date IS NOT DISTINCT FROM $1
            AND tr_name      IS NOT DISTINCT FROM $2
            AND amount = $3`,
        [e.expense_date, e.tr_name, e.amount]
      );
    }
    for (const e of EXPENSES) {
      await client.query(
        `INSERT INTO expenses
           (expense_date, tr_name, category, amount, payment_method, recurring, invoice_received, file_link, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [e.expense_date, e.tr_name, e.category, e.amount, e.payment_method, e.recurring, e.invoice_received, e.file_link, e.notes]
      );
    }

    await client.query('COMMIT');

    // ---- סיכום ----
    const st = (await client.query('SELECT COUNT(*) FROM students')).rows[0].count;
    const iv = (await client.query('SELECT COUNT(*) FROM invoices')).rows[0].count;
    const ex = (await client.query('SELECT COUNT(*) FROM expenses')).rows[0].count;
    const paid = (await client.query('SELECT COALESCE(SUM(amount_payed),0) s FROM invoices')).rows[0].s;
    const exp  = (await client.query('SELECT COALESCE(SUM(amount),0) s FROM expenses')).rows[0].s;
    console.log('\n✅ הייבוא הושלם בהצלחה!');
    console.log(`   תלמידים במסד:   ${st}`);
    console.log(`   חשבוניות במסד:  ${iv}   (סה"כ שולם: ₪${Number(paid).toLocaleString()})`);
    console.log(`   הוצאות במסד:    ${ex}   (סה"כ הוצאות: ₪${Number(exp).toLocaleString()})`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ הייבוא נכשל — לא בוצע שום שינוי (rollback). שגיאה:\n', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();