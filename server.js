const express = require('express');
const cors = require('cors');
const { OAuth2Client } = require('google-auth-library');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "526565725097-uhj6ubjrgtvtlc0i07beoqip2blr4i1q.apps.googleusercontent.com";
const client = new OAuth2Client(CLIENT_ID);

// Konfigurasi Pool PostgreSQL menggunakan file .env Anda
const pool = new Pool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false } // Diperlukan agar aman terhubung ke Supabase secara online
});

// Inisialisasi Tabel Database PostgreSQL secara otomatis
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

    // Pastikan kolom borrowDate ada pada tabel borrowings
    await pool.query(`
      ALTER TABLE borrowings ADD COLUMN IF NOT EXISTS borrowDate TEXT;
    `);

    // Seed Data Awal jika tabel services kosong
    const check = await pool.query(`SELECT COUNT(*) as count FROM services`);
    if (parseInt(check.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO services (title, category, icon, "desc", total, available, time, tone, serials) VALUES
        ('Proyektor Epson EB-X06', 'Multimedia', 'box', 'Proyektor 3LCD untuk presentasi kelas.', 5, 3, 'Maks. 3 hari', 'lavender', 'EPS-001,EPS-002,EPS-003,EPS-004,EPS-005'),
        ('Sound System Portable', 'Audio', 'bell', 'Paket speaker aktif dan mikrofon wireless.', 4, 2, 'Maks. 2 hari', 'blue', 'SND-001,SND-002,SND-003,SND-004'),
        ('Tenda Lipat 3×3 Meter', 'Logistik Acara', 'home', 'Tenda lipat tahan air untuk luar ruang.', 8, 6, 'Maks. 3 hari', 'gold', 'TND-001,TND-002,TND-003,TND-004,TND-005,TND-006,TND-007,TND-008')
      `);
    }
  } catch (err) {
    console.error('Error inisialisasi database:', err.message);
  }
};

// Jalankan inisialisasi tabel saat server pertama kali ditarik
initDB();

// 1. Endpoint Google Auth (Validasi Domain Kampus)
app.post('/api/auth/google', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, message: "Token Google tidak ditemukan." });
    }

    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: CLIENT_ID,
    });
    
    const payload = ticket.getPayload();
    const email = payload.email;
    const name = payload.name;

    const isStudent = email.endsWith('@student.unika.ac.id');
    const isStaffOrAdmin = email === '@unika.ac.id' || (email.endsWith('@unika.ac.id') && !isStudent);

    if (!isStudent && !isStaffOrAdmin) {
      return res.status(403).json({ 
        success: false, 
        message: "Akses ditolak! Login wajib menggunakan email resmi kampus (@student.unika.ac.id)." 
      });
    }

    let role = "student";
    const adminEmails = ["rafael.santoso@unika.ac.id", "admin.perkap@unika.ac.id"];
    const staffEmails = ["dina.pratiwi@unika.ac.id", "staff.perkap@unika.ac.id"];

    if (adminEmails.includes(email)) {
      role = "admin";
    } else if (staffEmails.includes(email) || !isStudent) {
      role = "staff";
    }

    await pool.query(`
      INSERT INTO users (email, name, role, unit) VALUES ($1, $2, $3, $4)
      ON CONFLICT (email) DO UPDATE SET name = $2, role = $3
    `, [email, name, role, "Unika Soegijapranata"]);

    res.json({
      success: true,
      email,
      name,
      role,
      token: "jwt-mock-token-" + Date.now()
    });
  } catch (error) {
    console.error("Detail Error Verifikasi Google:", error.message);
    res.status(401).json({ success: false, message: "Token Google tidak valid: " + error.message });
  }
});

// 2. Endpoint Katalog Alat
app.get('/api/services', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM services`);
    const formatted = result.rows.map(r => ({ ...r, serials: r.serials ? r.serials.split(',') : [] }));
    res.json(formatted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Endpoint Ajukan Peminjaman
app.post('/api/borrow', async (req, res) => {
  try {
    const { email, service, borrowDate } = req.body;
    
    if (!email || !service || !borrowDate) {
      return res.status(400).json({ success: false, message: "Data pengajuan atau tanggal peminjaman belum lengkap." });
    }

    const id = `PJM-${Date.now().toString().slice(-6)}`;
    const submittedAt = new Date().toLocaleString("id-ID", { dateStyle: "short", timeStyle: "short" });

    await pool.query(
      `INSERT INTO borrowings (id, email, service, borrowDate, status, submittedAt) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, email, service, borrowDate, "Pending Review", submittedAt]
    );
    
    await pool.query(`UPDATE services SET available = available - 1 WHERE title = $1 AND available > 0`, [service]);

    res.json({ success: true, id, status: "Pending Review", submittedAt, borrowDate });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Endpoint Ambil Daftar Peminjaman
app.get('/api/borrowings', async (req, res) => {
  try {
    const result = await pool.query(`SELECT * FROM borrowings`);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Endpoint Update Status Peminjaman (Oleh Staff)
app.put('/api/borrowings/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    await pool.query(`UPDATE borrowings SET status = $1 WHERE id = $2`, [status, id]);
    res.json({ success: true, message: "Status berhasil diperbarui" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- PENGATURAN UNTUK VERCEL & LOKAL ---
// Mengekspor app agar bisa dibaca oleh serverless functions Vercel
export default app;

// Tetap menyala menggunakan app.listen jika dijalankan secara lokal di komputer
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Backend lokal berjalan di port ${PORT}`);
  });
}