const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.disable('x-powered-by');

// ================================================================
// Konfigurasi
// ================================================================
const parseList = (v) =>
  (v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  '526565725097-uhj6ubjrgtvtlc0i07beoqip2blr4i1q.apps.googleusercontent.com';

const STUDENT_DOMAIN = '@student.unika.ac.id';
const STAFF_DOMAIN = '@unika.ac.id';
const VALID_ROLES = ['student', 'staff', 'admin'];
const VALID_STATUS = ['Pending Review', 'Disetujui', 'Ditolak', 'Dipinjam', 'Dikembalikan', 'In Maintenance'];
const CLOSED = ['Ditolak', 'Dikembalikan'];
const TRANSITIONS = {
  'Pending Review': ['Disetujui', 'Ditolak'],
  Disetujui: ['Dipinjam', 'Ditolak'],
  Dipinjam: ['Dikembalikan', 'In Maintenance'],
  'In Maintenance': ['Dikembalikan'],
};

const DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PDF_BYTES = 3 * 1024 * 1024; // batas body Vercel ±4,5 MB (base64 menggembung 33%)

// Role AWAL untuk user yang pertama kali login. Setelah tercatat di tabel users,
// role dibaca dari database (bisa diubah admin lewat menu Kelola User).
const ADMIN_EMAILS = parseList(process.env.ADMIN_EMAILS).length
  ? parseList(process.env.ADMIN_EMAILS)
  : ['rafael.santoso@unika.ac.id', 'admin.perkap@unika.ac.id'];
const STAFF_EMAILS = parseList(process.env.STAFF_EMAILS).length
  ? parseList(process.env.STAFF_EMAILS)
  : ['dina.pratiwi@unika.ac.id', 'staff.perkap@unika.ac.id'];

const ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({ origin: ORIGINS.length ? ORIGINS : true }));
app.use(express.json({ limit: '5mb' }));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) console.warn('PERINGATAN: JWT_SECRET belum diisi. Login akan ditolak sampai variabel ini diatur.');

// ================================================================
// Database
// ================================================================
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
  max: 3, // aman untuk serverless
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);

async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------- tanggal (zona WIB) ----------
const stamp = (d) =>
  new Date(d || Date.now()).toLocaleString('id-ID', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Jakarta',
  });
const todayWIB = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Jakarta' }); // YYYY-MM-DD
const parseDay = (s) => new Date(`${s}T00:00:00Z`);
const addDays = (d, n) => new Date(d.getTime() + n * DAY);
const maxDays = (time) => parseInt(String(time || '').match(/\d+/)?.[0] ?? '3', 10);
const isDateStr = (s) => typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(parseDay(s).getTime());

// ---------- nomor seri ----------
function serialPrefix(title, serials) {
  const s = serials.find((x) => /^[A-Za-z]+-\d+$/.test(x));
  return s ? s.split('-')[0] : title.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'UNT';
}
function nextSerials(title, existing, count) {
  const prefix = serialPrefix(title, existing);
  const set = new Set(existing);
  let n = Math.max(0, ...existing.map((x) => parseInt(x.match(/-(\d+)$/)?.[1] ?? '0', 10)));
  const out = [];
  while (out.length < count) {
    n += 1;
    const s = `${prefix}-${String(n).padStart(3, '0')}`;
    if (!set.has(s)) {
      set.add(s);
      out.push(s);
    }
  }
  return out;
}
const splitSerials = (s) => (s ? s.split(',').filter(Boolean) : []);

async function usedSerials(c, title) {
  const b = await c.query(
    `SELECT serial FROM borrowings
     WHERE service = $1 AND serial IS NOT NULL AND status <> ALL($2::text[]) AND status <> 'In Maintenance'`,
    [title, CLOSED]
  );
  const m = await c.query(`SELECT serial FROM maintenance WHERE item = $1 AND resolved = false`, [title]);
  return new Set([...b.rows.map((r) => r.serial), ...m.rows.map((r) => r.serial)]);
}

// ---------- audit ----------
async function audit(actor, activity, module, target) {
  try {
    await pool.query(`INSERT INTO audit_log (actor, activity, module, target) VALUES ($1, $2, $3, $4)`, [
      actor,
      activity,
      module,
      String(target ?? ''),
    ]);
  } catch (err) {
    console.error('Gagal menulis audit:', err.message);
  }
}

// ---------- email (opsional: butuh paket nodemailer + variabel SMTP_*) ----------
let transporter = null;
try {
  if (process.env.SMTP_HOST) {
    // eslint-disable-next-line global-require
    const nodemailer = require('nodemailer');
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
} catch (err) {
  console.warn('Nodemailer tidak tersedia, email hanya dicatat di audit:', err.message);
}
async function sendMail({ to, subject, text }) {
  if (!transporter) return false;
  await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
  return true;
}

// ================================================================
// Inisialisasi skema
// ================================================================
const SEED = [
  ['Proyektor Epson EB-X06', 'Multimedia', 'box', 'Proyektor 3LCD untuk presentasi kelas, seminar, dan kegiatan kampus.', 5, 3, 'Maks. 3 hari', 'lavender', 'EPS'],
  ['Sound System Portable', 'Audio', 'bell', 'Paket speaker aktif, mixer, dan dua mikrofon wireless.', 4, 2, 'Maks. 2 hari', 'blue', 'SND'],
  ['Tenda Lipat 3×3 Meter', 'Logistik Acara', 'home', 'Tenda lipat tahan air untuk kegiatan luar ruang di area kampus.', 8, 6, 'Maks. 3 hari', 'gold', 'TND'],
  ['Kamera Mirrorless Sony', 'Dokumentasi', 'calendar', 'Kamera dokumentasi lengkap dengan baterai dan kartu memori.', 3, 1, 'Maks. 2 hari', 'green', 'CAM'],
  ['Meja Lipat Acara', 'Logistik Acara', 'grid', 'Meja lipat portabel untuk registrasi dan kebutuhan acara.', 12, 9, 'Maks. 3 hari', 'pink', 'MJA'],
  ['Kabel Roll 25 Meter', 'Kelistrikan', 'settings', 'Kabel ekstensi berpelindung untuk distribusi daya kegiatan.', 10, 0, 'Maks. 2 hari', 'gray', 'KBL'],
];

const ready = (async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        name TEXT,
        role TEXT,
        unit TEXT,
        active INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS services (
        id SERIAL PRIMARY KEY,
        title TEXT,
        category TEXT,
        icon TEXT,
        "desc" TEXT,
        total INTEGER,
        available INTEGER,
        time TEXT,
        tone TEXT,
        serials TEXT
      );

      CREATE TABLE IF NOT EXISTS borrowings (
        id TEXT PRIMARY KEY,
        email TEXT,
        service TEXT,
        borrowDate TEXT,
        status TEXT,
        submittedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS borrowing_files (
        id TEXT PRIMARY KEY,
        filename TEXT,
        data BYTEA
      );

      CREATE TABLE IF NOT EXISTS maintenance (
        id SERIAL PRIMARY KEY,
        serial TEXT,
        item TEXT,
        issue TEXT,
        photo TEXT,
        status TEXT DEFAULT 'In Maintenance',
        loan_id TEXT,
        resolved BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS handovers (
        id SERIAL PRIMARY KEY,
        loan_id TEXT,
        unit TEXT,
        activity TEXT,
        condition TEXT,
        photo TEXT,
        actor TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id SERIAL PRIMARY KEY,
        actor TEXT,
        activity TEXT,
        module TEXT,
        target TEXT,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);

    // Migrasi kolom baru (aman dijalankan berulang)
    await pool.query(`ALTER TABLE borrowings ADD COLUMN IF NOT EXISTS borrowDate TEXT;`);
    await pool.query(`ALTER TABLE borrowings ADD COLUMN IF NOT EXISTS purpose TEXT;`);
    await pool.query(`ALTER TABLE borrowings ADD COLUMN IF NOT EXISTS file TEXT;`);
    await pool.query(`ALTER TABLE borrowings ADD COLUMN IF NOT EXISTS serial TEXT;`);
    await pool.query(`ALTER TABLE borrowings ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS maintenance_open_serial ON maintenance (serial) WHERE resolved = false;`);
    await pool.query(`CREATE INDEX IF NOT EXISTS borrowings_email_idx ON borrowings (email);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS borrowings_status_idx ON borrowings (status);`);

    // Seed katalog bila kosong (jumlah nomor seri = total)
    const check = await pool.query(`SELECT COUNT(*) AS count FROM services`);
    if (parseInt(check.rows[0].count, 10) === 0) {
      for (const [title, category, icon, desc, total, available, time, tone, prefix] of SEED) {
        const serials = Array.from({ length: total }, (_, i) => `${prefix}-${String(i + 1).padStart(3, '0')}`);
        await pool.query(
          `INSERT INTO services (title, category, icon, "desc", total, available, time, tone, serials)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [title, category, icon, desc, total, available, time, tone, serials.join(',')]
        );
      }
    }

    // Lengkapi nomor seri yang jumlahnya kurang dari total (data lama)
    const all = await pool.query(`SELECT id, title, total, serials FROM services`);
    for (const s of all.rows) {
      const arr = splitSerials(s.serials);
      if (arr.length < s.total) {
        const merged = arr.concat(nextSerials(s.title, arr, s.total - arr.length));
        await pool.query(`UPDATE services SET serials = $1 WHERE id = $2`, [merged.join(','), s.id]);
      }
    }
  } catch (err) {
    console.error('Error inisialisasi database:', err.message);
  }
})();

app.use((req, res, next) => ready.then(() => next(), next));

// ================================================================
// Token (HS256, tanpa dependensi tambahan)
// ================================================================
const b64u = (v) => Buffer.from(v).toString('base64url');
function signToken(payload, ttlSec = 8 * 3600) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}
function verifyToken(token) {
  if (!JWT_SECRET || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest();
  let given;
  try {
    given = Buffer.from(parts[2], 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// Middleware: wajib login; role dibaca ulang dari database di setiap request
const auth = (...roles) =>
  wrap(async (req, res) => {
    const header = req.headers.authorization || '';
    const payload = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (!payload) throw new HttpError(401, 'Sesi tidak valid atau sudah berakhir. Silakan login ulang.');
    const r = await pool.query(`SELECT role, active FROM users WHERE email = $1`, [payload.email]);
    const u = r.rows[0];
    if (!u || u.active === 0) throw new HttpError(401, 'Akun tidak ditemukan atau dinonaktifkan.');
    if (roles.length && !roles.includes(u.role)) throw new HttpError(403, 'Anda tidak memiliki akses ke fitur ini.');
    req.user = { email: payload.email, role: u.role };
    return 'next';
  });

// Adaptor: jalankan middleware async lalu lanjut ke handler berikutnya
const guard = (...roles) => {
  const mw = auth(...roles);
  return (req, res, next) => mw(req, res, (err) => (err ? next(err) : next()));
};
// `auth` memanggil next(err) hanya saat gagal; saat sukses wrap() tidak memanggil next, jadi gunakan guard():
const authGuard = (...roles) => async (req, res, next) => {
  try {
    const header = req.headers.authorization || '';
    const payload = verifyToken(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (!payload) throw new HttpError(401, 'Sesi tidak valid atau sudah berakhir. Silakan login ulang.');
    const r = await pool.query(`SELECT role, active FROM users WHERE email = $1`, [payload.email]);
    const u = r.rows[0];
    if (!u || u.active === 0) throw new HttpError(401, 'Akun tidak ditemukan atau dinonaktifkan.');
    if (roles.length && !roles.includes(u.role)) throw new HttpError(403, 'Anda tidak memiliki akses ke fitur ini.');
    req.user = { email: payload.email, role: u.role };
    next();
  } catch (err) {
    next(err);
  }
};
void guard;

// ================================================================
// 1. Login Google
// ================================================================
async function verifyGoogleAccessToken(accessToken) {
  const tokenInfoRes = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
  );
  if (!tokenInfoRes.ok) throw new HttpError(401, 'Token Google tidak valid atau sudah kedaluwarsa.');
  const tokenInfo = await tokenInfoRes.json();
  if (tokenInfo.aud !== CLIENT_ID && tokenInfo.azp !== CLIENT_ID) {
    throw new HttpError(401, 'Token tidak dibuat untuk aplikasi ini.');
  }

  const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!infoRes.ok) throw new HttpError(401, 'Gagal mengambil data akun Google.');
  const info = await infoRes.json();
  if (!info.email || info.email_verified === false) throw new HttpError(401, 'Email Google tidak terverifikasi.');
  return { email: String(info.email).toLowerCase(), name: info.name };
}

app.post(
  '/api/auth/google',
  wrap(async (req, res) => {
    if (!JWT_SECRET) throw new HttpError(500, 'Server belum dikonfigurasi (JWT_SECRET kosong).');
    const { token } = req.body || {};
    if (!token) throw new HttpError(400, 'Token Google tidak ditemukan.');

    const { email, name } = await verifyGoogleAccessToken(token);
    const isStudent = email.endsWith(STUDENT_DOMAIN);
    const isStaffOrAdmin = email.endsWith(STAFF_DOMAIN);
    if (!isStudent && !isStaffOrAdmin) {
      throw new HttpError(
        403,
        'Akses ditolak! Login wajib menggunakan email resmi kampus (@student.unika.ac.id atau @unika.ac.id).'
      );
    }

    const existing = await pool.query(`SELECT role, active FROM users WHERE email = $1`, [email]);
    const row = existing.rows[0];
    if (row && row.active === 0) throw new HttpError(403, 'Akun Anda dinonaktifkan.');

    let role;
    if (row && VALID_ROLES.includes(row.role)) {
      role = row.role;
    } else {
      role = 'student';
      if (ADMIN_EMAILS.includes(email)) role = 'admin';
      else if (STAFF_EMAILS.includes(email) || !isStudent) role = 'staff';
    }

    await pool.query(
      `INSERT INTO users (email, name, role, unit) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET name = $2`,
      [email, name || 'User Unika', role, 'Unika Soegijapranata']
    );
    await audit(email, `Login (${role})`, 'Auth', email);

    res.json({ success: true, email, name: name || 'User Unika', role, token: signToken({ email, role }) });
  })
);

// ================================================================
// 2. Katalog & master alat
// ================================================================
const formatService = (r) => ({
  id: r.id,
  title: r.title,
  category: r.category,
  icon: r.icon,
  desc: r.desc,
  total: r.total,
  available: r.available,
  time: r.time,
  tone: r.tone,
  serials: splitSerials(r.serials),
});

app.get(
  '/api/services',
  authGuard(),
  wrap(async (req, res) => {
    const result = await pool.query(`SELECT * FROM services ORDER BY id`);
    res.json(result.rows.map(formatService));
  })
);

// Ubah total_stock / available_stock (admin)
app.put(
  '/api/services/:id',
  authGuard('admin'),
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { total, available } = req.body || {};
    const out = await withTx(async (c) => {
      const r = await c.query(`SELECT * FROM services WHERE id = $1 FOR UPDATE`, [id]);
      const s = r.rows[0];
      if (!s) throw new HttpError(404, 'Alat tidak ditemukan.');
      let serials = splitSerials(s.serials);
      let nextTotal = s.total;
      let nextAvailable = s.available;

      if (total !== undefined) {
        if (!Number.isInteger(total) || total < 1 || total > 500) throw new HttpError(400, 'total_stock harus 1–500.');
        const inUse = s.total - s.available;
        if (total < inUse) throw new HttpError(409, `Tidak bisa kurang dari jumlah unit yang sedang dipakai (${inUse}).`);
        if (total > serials.length) {
          serials = serials.concat(nextSerials(s.title, serials, total - serials.length));
        } else if (total < serials.length) {
          const used = await usedSerials(c, s.title);
          for (let i = serials.length - 1; i >= 0 && serials.length > total; i -= 1) {
            if (!used.has(serials[i])) serials.splice(i, 1);
          }
          if (serials.length > total) throw new HttpError(409, 'Nomor seri unit yang sedang dipakai tidak dapat dihapus.');
        }
        nextAvailable = Math.min(Math.max(nextAvailable + (total - s.total), 0), total);
        nextTotal = total;
      }
      if (available !== undefined) {
        if (!Number.isInteger(available) || available < 0 || available > nextTotal) {
          throw new HttpError(400, `available_stock harus 0–${nextTotal}.`);
        }
        nextAvailable = available;
      }

      await c.query(`UPDATE services SET total = $1, available = $2, serials = $3 WHERE id = $4`, [
        nextTotal,
        nextAvailable,
        serials.join(','),
        id,
      ]);
      return { title: s.title, from: `${s.total}/${s.available}`, to: `${nextTotal}/${nextAvailable}` };
    });
    await audit(req.user.email, `Stok ${out.title} (total/tersedia): ${out.from} → ${out.to}`, 'Inventory DB', out.title);
    res.json({ success: true });
  })
);

// Tambah ItemStock (nomor seri baru)
app.post(
  '/api/services/:id/serials',
  authGuard('admin'),
  wrap(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const serial = String((req.body || {}).serial || '').trim().toUpperCase();
    if (!/^[A-Z0-9._-]{2,30}$/.test(serial)) throw new HttpError(400, 'Format nomor seri tidak valid (huruf/angka/-/_ , 2–30 karakter).');
    const title = await withTx(async (c) => {
      const all = await c.query(`SELECT id, title, serials FROM services FOR UPDATE`);
      if (all.rows.some((r) => splitSerials(r.serials).includes(serial))) throw new HttpError(409, 'Nomor seri sudah terdaftar.');
      const s = all.rows.find((r) => r.id === id);
      if (!s) throw new HttpError(404, 'Alat tidak ditemukan.');
      const serials = [...splitSerials(s.serials), serial];
      await c.query(`UPDATE services SET serials = $1, total = total + 1, available = available + 1 WHERE id = $2`, [
        serials.join(','),
        id,
      ]);
      return s.title;
    });
    await audit(req.user.email, `ItemStock baru ditambahkan: ${serial}`, 'Inventory DB', title);
    res.json({ success: true });
  })
);

// ================================================================
// 3. Peminjaman
// ================================================================
const BORROW_COLS = `id, email, service, borrowdate AS "borrowDate", purpose, file, serial, status, submittedat AS "submittedAt"`;

app.post(
  '/api/borrow',
  authGuard(),
  wrap(async (req, res) => {
    const { service, borrowDate, purpose, file, fileData } = req.body || {};
    const email = req.user.email;

    if (typeof service !== 'string' || !service) throw new HttpError(400, 'Alat belum dipilih.');
    if (!isDateStr(borrowDate)) throw new HttpError(400, 'Tanggal peminjaman tidak valid.');
    const purposeText = typeof purpose === 'string' ? purpose.trim() : '';
    if (purposeText.length < 3 || purposeText.length > 500) throw new HttpError(400, 'Keperluan peminjaman wajib diisi (3–500 karakter).');
    const fileName = typeof file === 'string' ? file.slice(0, 200) : null;

    let fileBuf = null;
    if (fileData) {
      if (typeof fileData !== 'string') throw new HttpError(400, 'Data file tidak valid.');
      fileBuf = Buffer.from(fileData, 'base64');
      if (fileBuf.length > MAX_PDF_BYTES) throw new HttpError(413, 'Ukuran PDF melebihi 3 MB.');
      if (fileBuf.subarray(0, 4).toString('latin1') !== '%PDF') throw new HttpError(400, 'Surat permohonan harus berupa file PDF.');
    }

    const today = todayWIB();
    const day = parseDay(borrowDate);
    if (borrowDate < today) throw new HttpError(400, 'Tanggal peminjaman tidak boleh di masa lalu.');
    if (day.getTime() - parseDay(today).getTime() > 180 * DAY) throw new HttpError(400, 'Tanggal peminjaman maksimal 180 hari ke depan.');

    const result = await withTx(async (c) => {
      const svcRes = await c.query(`SELECT * FROM services WHERE title = $1 FOR UPDATE`, [service]);
      const svc = svcRes.rows[0];
      if (!svc) throw new HttpError(404, 'Alat tidak ditemukan.');
      if (svc.available <= 0) throw new HttpError(409, 'Stok alat habis.');

      // Peminjam yang masih punya unit terlambat tidak boleh mengajukan baru
      const loans = await c.query(
        `SELECT b.borrowdate, s.time FROM borrowings b
         LEFT JOIN services s ON s.title = b.service
         WHERE b.email = $1 AND b.status = 'Dipinjam'`,
        [email]
      );
      const todayDate = parseDay(today);
      const hasOverdue = loans.rows.some(
        (l) => isDateStr(l.borrowdate) && addDays(parseDay(l.borrowdate), maxDays(l.time)) < todayDate
      );
      if (hasOverdue) throw new HttpError(409, 'Anda masih memiliki peminjaman yang terlambat. Kembalikan unit terlebih dahulu.');

      // Bentrok jadwal: setiap hari pada rentang peminjaman harus masih punya sisa unit
      const days = maxDays(svc.time);
      const open = await c.query(
        `SELECT borrowdate, serial, status FROM borrowings WHERE service = $1 AND status <> ALL($2::text[])`,
        [service, CLOSED]
      );
      for (let i = 0; i < days; i += 1) {
        const d = addDays(day, i).getTime();
        const booked = open.rows.filter((r) => {
          if (!isDateStr(r.borrowdate)) return false;
          const start = parseDay(r.borrowdate).getTime();
          return d >= start && d <= start + (days - 1) * DAY;
        }).length;
        if (booked >= svc.total) throw new HttpError(409, 'Jadwal bentrok: seluruh unit sudah dipesan pada rentang tanggal tersebut.');
      }

      // Alokasi nomor seri fisik
      const used = await usedSerials(c, service);
      const serial = splitSerials(svc.serials).find((s) => !used.has(s));
      if (!serial) throw new HttpError(409, 'Tidak ada unit fisik yang tersedia (mungkin sedang diperbaiki).');

      await c.query(`UPDATE services SET available = available - 1 WHERE id = $1`, [svc.id]);

      const id = `PJM-${Date.now().toString().slice(-6)}${crypto.randomInt(10, 100)}`;
      const submittedAt = stamp();
      await c.query(
        `INSERT INTO borrowings (id, email, service, borrowDate, purpose, file, serial, status, submittedAt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending Review', $8)`,
        [id, email, service, borrowDate, purposeText, fileName, serial, submittedAt]
      );
      if (fileBuf) {
        await c.query(`INSERT INTO borrowing_files (id, filename, data) VALUES ($1, $2, $3)`, [id, fileName, fileBuf]);
      }
      return { id, submittedAt, serial };
    });

    await audit(email, `Pengajuan peminjaman ${service}`, 'Borrowing', result.id);
    res.json({ success: true, id: result.id, status: 'Pending Review', submittedAt: result.submittedAt, borrowDate, serial: result.serial });
  })
);

// Mahasiswa hanya melihat miliknya; petugas/admin melihat semua (urut lama → baru)
app.get(
  '/api/borrowings',
  authGuard(),
  wrap(async (req, res) => {
    const own = req.user.role === 'student';
    const result = await pool.query(
      `SELECT ${BORROW_COLS} FROM borrowings ${own ? 'WHERE email = $1' : ''} ORDER BY created_at ASC, id ASC`,
      own ? [req.user.email] : []
    );
    res.json(result.rows);
  })
);

// Unduh surat permohonan (pemilik atau petugas/admin)
app.get(
  '/api/borrowings/:id/file',
  authGuard(),
  wrap(async (req, res) => {
    const b = await pool.query(`SELECT email FROM borrowings WHERE id = $1`, [req.params.id]);
    if (!b.rows[0]) throw new HttpError(404, 'Peminjaman tidak ditemukan.');
    if (req.user.role === 'student' && b.rows[0].email !== req.user.email) throw new HttpError(403, 'Tidak diizinkan.');
    const f = await pool.query(`SELECT filename, data FROM borrowing_files WHERE id = $1`, [req.params.id]);
    if (!f.rows[0]) throw new HttpError(404, 'Dokumen tidak tersedia.');
    const safeName = String(f.rows[0].filename || 'surat-permohonan.pdf').replace(/[^\w.\- ]/g, '_');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${safeName}"`,
      'Cache-Control': 'private, no-store',
    });
    res.send(f.rows[0].data);
  })
);

// Ubah status (petugas/admin) — transisi divalidasi, stok dipulihkan saat unit kembali / ditolak
app.put(
  '/api/borrowings/:id/status',
  authGuard('staff', 'admin'),
  wrap(async (req, res) => {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!VALID_STATUS.includes(status)) throw new HttpError(400, 'Status tidak valid.');

    const info = await withTx(async (c) => {
      const cur = await c.query(`SELECT service, status FROM borrowings WHERE id = $1 FOR UPDATE`, [id]);
      const b = cur.rows[0];
      if (!b) throw new HttpError(404, 'Peminjaman tidak ditemukan.');
      if (!(TRANSITIONS[b.status] || []).includes(status)) {
        throw new HttpError(409, `Status tidak dapat diubah dari "${b.status}" ke "${status}".`);
      }
      await c.query(`UPDATE borrowings SET status = $1 WHERE id = $2`, [status, id]);
      if (CLOSED.includes(status) && !CLOSED.includes(b.status)) {
        await c.query(`UPDATE services SET available = LEAST(available + 1, total) WHERE title = $1`, [b.service]);
      }
      return { from: b.status };
    });
    await audit(req.user.email, `Status ${info.from} → ${status}`, 'Borrowing', id);
    res.json({ success: true, message: 'Status berhasil diperbarui' });
  })
);

// ================================================================
// 4. Follow-up email & scheduler overdue
// ================================================================
async function overdueLoans() {
  const r = await pool.query(
    `SELECT b.id, b.email, b.service, b.borrowdate, s.time
     FROM borrowings b LEFT JOIN services s ON s.title = b.service
     WHERE b.status = 'Dipinjam'`
  );
  const today = parseDay(todayWIB());
  return r.rows.filter((x) => isDateStr(x.borrowdate) && addDays(parseDay(x.borrowdate), maxDays(x.time)) < today);
}

const campusEmail = (e) => EMAIL_RE.test(e) && (e.endsWith(STUDENT_DOMAIN) || e.endsWith(STAFF_DOMAIN));

app.post(
  '/api/borrowings/:id/followup',
  authGuard('staff', 'admin'),
  wrap(async (req, res) => {
    const { to, subject, message } = req.body || {};
    const r = await pool.query(`SELECT id, email, service, status FROM borrowings WHERE id = $1`, [req.params.id]);
    const b = r.rows[0];
    if (!b) throw new HttpError(404, 'Peminjaman tidak ditemukan.');
    if (b.status !== 'Dipinjam') throw new HttpError(409, 'Follow-up hanya untuk unit yang sedang dipinjam.');
    const recipient = String(to || b.email).trim().toLowerCase();
    if (!campusEmail(recipient)) throw new HttpError(400, 'Penerima harus email kampus.');
    if (!subject || !message) throw new HttpError(400, 'Subjek dan pesan wajib diisi.');

    let sent = false;
    try {
      sent = await sendMail({ to: recipient, subject: String(subject).slice(0, 200), text: String(message).slice(0, 5000) });
    } catch (err) {
      console.error('Gagal kirim email:', err.message);
      throw new HttpError(502, 'Email gagal dikirim oleh server SMTP.');
    }
    await audit(req.user.email, sent ? 'Email follow-up overdue terkirim' : 'Follow-up overdue dicatat (SMTP belum aktif)', 'Email Scheduler', `${b.id} → ${recipient}`);
    res.json({ success: true, sent });
  })
);

// Dipanggil Vercel Cron setiap hari 08:00 WIB (lihat vercel.json). Wajib header: Authorization: Bearer <CRON_SECRET>
app.get(
  '/api/cron/overdue',
  wrap(async (req, res) => {
    if (!process.env.CRON_SECRET) throw new HttpError(503, 'CRON_SECRET belum diatur.');
    if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) throw new HttpError(401, 'Tidak diizinkan.');
    const loans = await overdueLoans();
    let sent = 0;
    for (const l of loans) {
      if (!campusEmail(l.email)) continue;
      try {
        const ok = await sendMail({
          to: l.email,
          subject: 'Pengingat: Segera Kembalikan Alat Perkap yang Dipinjam',
          text: `Yth. Peminjam,\n\nPeminjaman ${l.service} (${l.id}) telah melewati batas waktu. Mohon segera mengembalikan unit ke Gudang Perkap.\n\nTerima kasih.\nUnit Perkap UNIKA`,
        });
        if (ok) sent += 1;
      } catch (err) {
        console.error('Cron: gagal kirim ke', l.email, err.message);
      }
    }
    await audit('System Mailer', `Scheduler overdue: ${loans.length} terlambat, ${sent} email terkirim`, 'Email Scheduler', 'cron');
    res.json({ success: true, overdue: loans.length, sent });
  })
);

// ================================================================
// 5. Maintenance
// ================================================================
const fmtMaintenance = (r) => ({
  serial: r.serial,
  item: r.item,
  issue: r.issue,
  photo: r.photo || '',
  reportedAt: stamp(r.created_at),
  status: r.status === 'Inspection' ? 'Inspection' : 'In Maintenance',
  loanId: r.loan_id || undefined,
});

app.get(
  '/api/maintenance',
  authGuard('staff', 'admin'),
  wrap(async (req, res) => {
    const r = await pool.query(`SELECT * FROM maintenance WHERE resolved = false ORDER BY created_at DESC`);
    res.json(r.rows.map(fmtMaintenance));
  })
);

app.post(
  '/api/maintenance',
  authGuard('staff', 'admin'),
  wrap(async (req, res) => {
    const { serial, item, issue, photo, loanId } = req.body || {};
    if (!serial || !item || !issue) throw new HttpError(400, 'Data maintenance belum lengkap.');
    const ins = await pool.query(
      `INSERT INTO maintenance (serial, item, issue, photo, status, loan_id)
       VALUES ($1, $2, $3, $4, 'In Maintenance', $5)
       ON CONFLICT DO NOTHING RETURNING id`,
      [String(serial).slice(0, 40), String(item).slice(0, 120), String(issue).slice(0, 1000), String(photo || '').slice(0, 200), loanId || null]
    );
    if (ins.rowCount) await audit(req.user.email, 'ItemStock dikarantina: In Maintenance', 'Incident Log', serial);
    res.json({ success: true });
  })
);

app.put(
  '/api/maintenance/:serial/status',
  authGuard('staff', 'admin'),
  wrap(async (req, res) => {
    const { status } = req.body || {};
    if (!['Inspection', 'In Maintenance'].includes(status)) throw new HttpError(400, 'Status tidak valid.');
    const r = await pool.query(`UPDATE maintenance SET status = $1 WHERE serial = $2 AND resolved = false`, [status, req.params.serial]);
    if (!r.rowCount) throw new HttpError(404, 'Data maintenance tidak ditemukan.');
    await audit(req.user.email, `Maintenance → ${status}`, 'Incident Log', req.params.serial);
    res.json({ success: true });
  })
);

// Perbaikan selesai: unit kembali tersedia (peminjaman terkait ditutup & stok dipulihkan)
app.post(
  '/api/maintenance/:serial/resolve',
  authGuard('staff', 'admin'),
  wrap(async (req, res) => {
    await withTx(async (c) => {
      const r = await c.query(`SELECT * FROM maintenance WHERE serial = $1 AND resolved = false FOR UPDATE`, [req.params.serial]);
      const m = r.rows[0];
      if (!m) throw new HttpError(404, 'Data maintenance tidak ditemukan.');
      await c.query(`UPDATE maintenance SET resolved = true WHERE id = $1`, [m.id]);
      if (m.loan_id) {
        const loan = await c.query(`SELECT service, status FROM borrowings WHERE id = $1 FOR UPDATE`, [m.loan_id]);
        if (loan.rows[0] && loan.rows[0].status === 'In Maintenance') {
          await c.query(`UPDATE borrowings SET status = 'Dikembalikan' WHERE id = $1`, [m.loan_id]);
          await c.query(`UPDATE services SET available = LEAST(available + 1, total) WHERE title = $1`, [loan.rows[0].service]);
        }
      }
    });
    await audit(req.user.email, 'Perbaikan selesai, unit kembali tersedia', 'Incident Log', req.params.serial);
    res.json({ success: true });
  })
);

// ================================================================
// 6. Handover
// ================================================================
app.get(
  '/api/handovers',
  authGuard('staff', 'admin'),
  wrap(async (req, res) => {
    const r = await pool.query(`SELECT * FROM handovers ORDER BY created_at DESC LIMIT 200`);
    res.json(
      r.rows.map((x) => ({ time: stamp(x.created_at), id: x.loan_id, unit: x.unit, activity: x.activity, condition: x.condition, photo: x.photo || '' }))
    );
  })
);

app.post(
  '/api/handovers',
  authGuard('staff', 'admin'),
  wrap(async (req, res) => {
    const { id, unit, activity, condition, photo } = req.body || {};
    if (!id || !unit || !activity) throw new HttpError(400, 'Data handover belum lengkap.');
    await pool.query(
      `INSERT INTO handovers (loan_id, unit, activity, condition, photo, actor) VALUES ($1, $2, $3, $4, $5, $6)`,
      [String(id), String(unit).slice(0, 200), String(activity).slice(0, 60), String(condition || '').slice(0, 1000), String(photo || '').slice(0, 200), req.user.email]
    );
    await audit(req.user.email, `Handover: ${activity}`, 'Handover', id);
    res.json({ success: true });
  })
);

// ================================================================
// 7. Pengguna (admin)
// ================================================================
app.get(
  '/api/users',
  authGuard('admin'),
  wrap(async (req, res) => {
    const r = await pool.query(`SELECT email, name, role, unit, active FROM users ORDER BY role, email`);
    res.json(r.rows);
  })
);

app.post(
  '/api/users',
  authGuard('admin'),
  wrap(async (req, res) => {
    const { email, name, unit, role } = req.body || {};
    const mail = String(email || '').trim().toLowerCase();
    if (!campusEmail(mail)) throw new HttpError(400, 'Email harus berakhiran @student.unika.ac.id atau @unika.ac.id.');
    if (!VALID_ROLES.includes(role)) throw new HttpError(400, 'Role tidak valid.');
    const ins = await pool.query(
      `INSERT INTO users (email, name, role, unit, active) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (email) DO NOTHING RETURNING email`,
      [mail, String(name || mail.split('@')[0]).slice(0, 100), role, String(unit || '-').slice(0, 100)]
    );
    if (!ins.rowCount) throw new HttpError(409, 'Pengguna dengan email tersebut sudah ada.');
    await audit(req.user.email, `Menambah pengguna ${mail} (${role})`, 'User Management', mail);
    res.json({ success: true });
  })
);

app.put(
  '/api/users/:email',
  authGuard('admin'),
  wrap(async (req, res) => {
    const target = decodeURIComponent(req.params.email).toLowerCase();
    const { role, active, name, unit } = req.body || {};
    if (target === req.user.email && (role !== undefined || active !== undefined)) {
      throw new HttpError(409, 'Anda tidak dapat mengubah role atau status akun Anda sendiri.');
    }
    if (role !== undefined && !VALID_ROLES.includes(role)) throw new HttpError(400, 'Role tidak valid.');
    const sets = [];
    const vals = [];
    const push = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (role !== undefined) push('role', role);
    if (active !== undefined) push('active', active ? 1 : 0);
    if (name !== undefined) push('name', String(name).slice(0, 100));
    if (unit !== undefined) push('unit', String(unit).slice(0, 100));
    if (!sets.length) throw new HttpError(400, 'Tidak ada data yang diubah.');
    vals.push(target);
    const r = await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE email = $${vals.length}`, vals);
    if (!r.rowCount) throw new HttpError(404, 'Pengguna tidak ditemukan.');
    await audit(req.user.email, `Ubah pengguna: ${JSON.stringify({ role, active, name, unit })}`, 'User Management', target);
    res.json({ success: true });
  })
);

app.delete(
  '/api/users/:email',
  authGuard('admin'),
  wrap(async (req, res) => {
    const target = decodeURIComponent(req.params.email).toLowerCase();
    if (target === req.user.email) throw new HttpError(409, 'Anda tidak dapat menghapus akun Anda sendiri.');
    const r = await pool.query(`DELETE FROM users WHERE email = $1`, [target]);
    if (!r.rowCount) throw new HttpError(404, 'Pengguna tidak ditemukan.');
    await audit(req.user.email, 'Menghapus pengguna', 'User Management', target);
    res.json({ success: true });
  })
);

// ================================================================
// 8. Audit trail
// ================================================================
app.get(
  '/api/audit',
  authGuard('admin'),
  wrap(async (req, res) => {
    const r = await pool.query(`SELECT * FROM audit_log ORDER BY created_at DESC, id DESC LIMIT 300`);
    res.json(r.rows.map((x) => ({ time: stamp(x.created_at), actor: x.actor, activity: x.activity, module: x.module, target: x.target })));
  })
);

// ================================================================
// Health check & error handler
// ================================================================
app.get('/', (req, res) => res.json({ ok: true, service: 'perkap-backend' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'Data terlalu besar. Ukuran PDF maksimum 3 MB.' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ success: false, message: 'Format data tidak valid.' });
  }
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ success: false, message: status < 500 ? err.message : 'Terjadi kesalahan server.' });
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Backend lokal berjalan di port ${PORT}`);
  });
}