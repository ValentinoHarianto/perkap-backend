const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID =
  process.env.GOOGLE_CLIENT_ID ||
  '526565725097-uhj6ubjrgtvtlc0i07beoqip2blr4i1q.apps.googleusercontent.com';

const STUDENT_DOMAIN = '@student.unika.ac.id';
const STAFF_DOMAIN = '@unika.ac.id';
const VALID_ROLES = ['student', 'staff', 'admin'];
const VALID_STATUS = ['Pending Review', 'Disetujui', 'Ditolak'];

// Daftar email untuk role AWAL (hanya dipakai saat user pertama kali login).
// Setelah user tercatat di tabel "users", role dibaca dari database (Supabase).
// Bisa diisi lewat env var ADMIN_EMAILS / STAFF_EMAILS (pisahkan dengan koma).
const parseList = (v) =>
  (v || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const ADMIN_EMAILS = parseList(process.env.ADMIN_EMAILS).length
  ? parseList(process.env.ADMIN_EMAILS)
  : ['rafael.santoso@unika.ac.id', 'admin.perkap@unika.ac.id'];

const STAFF_EMAILS = parseList(process.env.STAFF_EMAILS).length
  ? parseList(process.env.STAFF_EMAILS)
  : ['dina.pratiwi@unika.ac.id', 'staff.perkap@unika.ac.id'];

// ---------- Database (Supabase / PostgreSQL) ----------
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false },
  max: 3, // aman untuk serverless
});

const initDB = async () => {
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
    `);

    await pool.query(`ALTER TABLE borrowings ADD COLUMN IF NOT EXISTS borrowDate TEXT;`);

    const check = await pool.query(`SELECT COUNT(*) AS count FROM services`);
    if (parseInt(check.rows[0].count, 10) === 0) {
      await pool.query(`
        INSERT INTO services (title, category, icon, "desc", total, available, time, tone, serials) VALUES
        ('Proyektor Epson EB-X06', 'Multimedia', 'box', 'Proyektor 3LCD untuk presentasi kelas.', 5, 3, 'Maks. 3 hari', 'lavender', 'EPS-001,EPS-002,EPS-003,EPS-004,EPS-005'),
        ('Sound System Portable', 'Audio', 'bell', 'Paket speaker aktif dan mikrofon wireless.', 4, 2, 'Maks. 2 hari', 'blue', 'SND-001,SND-002,SND-003,SND-004'),
        ('Tenda Lipat 3×3 Meter', 'Logistik Acara', 'home', 'Tenda lipat tahan air untuk luar ruang.', 8, 6, 'Maks. 3 hari', 'gold', 'TND-001,TND-002,TND-003,TND-004,TND-005,TND-006,TND-007,TND-008'),
        ('Kamera Mirrorless Sony', 'Dokumentasi', 'calendar', 'Kamera dokumentasi lengkap dengan baterai dan kartu memori.', 3, 1, 'Maks. 2 hari', 'green', 'CAM-001,CAM-002,CAM-003'),
        ('Meja Lipat Acara', 'Logistik Acara', 'grid', 'Meja lipat portabel untuk registrasi dan kebutuhan acara.', 12, 9, 'Maks. 3 hari', 'pink', 'MJA-001,MJA-002,MJA-003'),
        ('Kabel Roll 25 Meter', 'Kelistrikan', 'settings', 'Kabel ekstensi berpelindung untuk distribusi daya kegiatan.', 10, 0, 'Maks. 2 hari', 'gray', 'KBL-001,KBL-002,KBL-003')
      `);
    }
  } catch (err) {
    console.error('Error inisialisasi database:', err.message);
  }
};

initDB();

// ---------- Helper: verifikasi access token Google di server ----------
class AuthError extends Error {}

async function verifyGoogleAccessToken(accessToken) {
  // 1. Pastikan token valid DAN dibuat untuk client ID aplikasi ini
  const tokenInfoRes = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(accessToken)}`
  );
  if (!tokenInfoRes.ok) {
    throw new AuthError('Token Google tidak valid atau sudah kedaluwarsa.');
  }
  const tokenInfo = await tokenInfoRes.json();
  if (tokenInfo.aud !== CLIENT_ID && tokenInfo.azp !== CLIENT_ID) {
    throw new AuthError('Token tidak dibuat untuk aplikasi ini.');
  }

  // 2. Ambil profil pengguna langsung dari Google (bukan dari body request)
  const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!infoRes.ok) {
    throw new AuthError('Gagal mengambil data akun Google.');
  }
  const info = await infoRes.json();

  if (!info.email || info.email_verified === false) {
    throw new AuthError('Email Google tidak terverifikasi.');
  }

  return { email: String(info.email).toLowerCase(), name: info.name };
}

// ---------- 1. Login Google ----------
app.post('/api/auth/google', async (req, res) => {
  try {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ success: false, message: 'Token Google tidak ditemukan.' });
    }

    const { email, name } = await verifyGoogleAccessToken(token);

    const isStudent = email.endsWith(STUDENT_DOMAIN);
    const isStaffOrAdmin = email.endsWith(STAFF_DOMAIN);

    if (!isStudent && !isStaffOrAdmin) {
      return res.status(403).json({
        success: false,
        message: 'Akses ditolak! Login wajib menggunakan email resmi kampus (@student.unika.ac.id atau @unika.ac.id).',
      });
    }

    // Cek apakah user sudah ada di database
    const existing = await pool.query(`SELECT role, active FROM users WHERE email = $1`, [email]);
    const row = existing.rows[0];

    if (row && row.active === 0) {
      return res.status(403).json({ success: false, message: 'Akun Anda dinonaktifkan.' });
    }

    let role;
    if (row && VALID_ROLES.includes(row.role)) {
      // Role diambil dari database (bisa diubah lewat Supabase)
      role = row.role;
    } else {
      // User baru: tentukan role awal
      role = 'student';
      if (ADMIN_EMAILS.includes(email)) role = 'admin';
      else if (STAFF_EMAILS.includes(email) || !isStudent) role = 'staff';
    }

    // Role tidak ditimpa saat user sudah ada
    await pool.query(
      `INSERT INTO users (email, name, role, unit) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET name = $2`,
      [email, name || 'User Unika', role, 'Unika Soegijapranata']
    );

    res.json({
      success: true,
      email,
      name: name || 'User Unika',
      role,
      token: 'jwt-mock-token-' + Date.now(),
    });
  } catch (error) {
    console.error('Detail Error Login:', error.message);
    if (error instanceof AuthError) {
      return res.status(401).json({ success: false, message: error.message });
    }
    res.status(500).json({ success: false, message: 'Terjadi kesalahan server: ' + error.message });
  }
});

// ---------- 2. Katalog alat ----------
app.get('/api/services', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM services ORDER BY id`);
    const formatted = result.rows.map((r) => ({
      ...r,
      serials: r.serials ? r.serials.split(',') : [],
    }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 3. Ajukan peminjaman ----------
app.post('/api/borrow', async (req, res) => {
  try {
    const { email, service, borrowDate } = req.body || {};

    if (!email || !service || !borrowDate) {
      return res
        .status(400)
        .json({ success: false, message: 'Data pengajuan atau tanggal peminjaman belum lengkap.' });
    }

    // Kurangi stok lebih dulu secara atomik; gagal jika stok habis
    const stock = await pool.query(
      `UPDATE services SET available = available - 1
       WHERE title = $1 AND available > 0 RETURNING available`,
      [service]
    );
    if (stock.rowCount === 0) {
      return res.status(409).json({ success: false, message: 'Stok alat habis atau alat tidak ditemukan.' });
    }

    const id = `PJM-${Date.now().toString().slice(-6)}`;
    const submittedAt = new Date().toLocaleString('id-ID', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'Asia/Jakarta',
    });

    await pool.query(
      `INSERT INTO borrowings (id, email, service, borrowDate, status, submittedAt)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, email, service, borrowDate, 'Pending Review', submittedAt]
    );

    res.json({ success: true, id, status: 'Pending Review', submittedAt, borrowDate });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- 4. Daftar peminjaman ----------
// Postgres menurunkan nama kolom tanpa tanda kutip menjadi huruf kecil,
// jadi di-alias agar sesuai dengan yang dipakai frontend (borrowDate, submittedAt).
app.get('/api/borrowings', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, service,
              borrowdate  AS "borrowDate",
              status,
              submittedat AS "submittedAt"
       FROM borrowings
       ORDER BY submittedat DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- 5. Update status peminjaman ----------
app.put('/api/borrowings/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body || {};

    if (!VALID_STATUS.includes(status)) {
      return res.status(400).json({ success: false, message: 'Status tidak valid.' });
    }

    const current = await pool.query(`SELECT service, status FROM borrowings WHERE id = $1`, [id]);
    if (current.rowCount === 0) {
      return res.status(404).json({ success: false, message: 'Peminjaman tidak ditemukan.' });
    }

    await pool.query(`UPDATE borrowings SET status = $1 WHERE id = $2`, [status, id]);

    // Jika pengajuan ditolak, kembalikan stok
    if (status === 'Ditolak' && current.rows[0].status !== 'Ditolak') {
      await pool.query(
        `UPDATE services SET available = LEAST(available + 1, total) WHERE title = $1`,
        [current.rows[0].service]
      );
    }

    res.json({ success: true, message: 'Status berhasil diperbarui' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get('/', (req, res) => res.json({ ok: true, service: 'perkap-backend' }));

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Backend lokal berjalan di port ${PORT}`);
  });
}