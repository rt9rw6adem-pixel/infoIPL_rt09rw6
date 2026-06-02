const express = require('express');
const session = require('express-session');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ================= CONFIGURATION & MIDDLEWARES =================
app.use(session({
  secret: 'kunci-rahasia-ipl-warga-xyz',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));

app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// Data Master Konstan
const DAFTAR_BLOK = ["TD.03-1", "TD.03-2 & 3", "TD.03-4", "TE.05-1", "TE.05-2", "TE.05-3"];
const DAFTAR_TAHUN = ["2024", "2025", "2026", "2027"]; 

const AKUN_USER = { username: "warga", password: "123" };
const AKUN_ADMIN = { username: "admin", password: "rt09admin" };

// Middleware Hak Akses
function pastikanLogin(req, res, next) {
  if (req.session.isLoggedIn) return next();
  res.redirect('/login');
}

function pastikanAdmin(req, res, next) {
  if (req.session.isLoggedIn && req.session.role === 'admin') return next();
  res.status(403).send("Akses Ditolak: Khusus Admin!");
}

// Helper Nama Bulan Indonesia
function getNamaBulanIndo(angkaBulan) {
  const bulan = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  return bulan[parseInt(angkaBulan) - 1] || "";
}

// ================= FUNGSI SANITASI ANGKA (KUNCI ANTI-NaN) =================
function bersihkanKeAngkaMurni(input) {
  if (!input) return 0;
  let teks = input.toString().trim();
  
  if (teks === "" || teks === "-" || teks.toUpperCase() === "NAN") return 0;
  
  // Jika ada format koma desimal uang (contoh: 150.000,00) -> potong komanya
  if (teks.includes(',') && teks.includes('.')) {
    teks = teks.split(',')[0];
  }
  // Hapus tanda titik (.) ribuan Indonesia
  teks = teks.replace(/\./g, "");
  // Buang semua karakter selain angka dan minus
  teks = teks.replace(/[^0-9-]/g, "");
  
  return parseFloat(teks) || 0;
}

// ================= SINKRONISASI & HITUNG SALDO AUTOMATION =================
async function hitungUlangSaldoKas(sheetKas) {
  const rows = await sheetKas.getRows();
  let runningSaldo = 0;

  for (let i = 0; i < rows.length; i++) {
    rows[i].set('no', (i + 1).toString());

    const tgl = rows[i].get('tanggal');
    if (tgl && tgl.includes('-')) {
      rows[i].set('bulan', getNamaBulanIndo(tgl.split('-')[1]));
    }

    const pem = bersihkanKeAngkaMurni(rows[i].get('pemasukan'));
    const peng = bersihkanKeAngkaMurni(rows[i].get('pengeluaran'));

    runningSaldo = runningSaldo + pem - peng;
    
    rows[i].set('pemasukan', pem.toString());
    rows[i].set('pengeluaran', peng.toString());
    rows[i].set('saldo', runningSaldo.toLocaleString('id-ID'));
    
    await rows[i].save();
  }
}

// ================= INITIALIZE GOOGLE SHEETS API (FIXED FOR VERCEL) =================
// Sistem otomatis: Pakai Environment Variables jika ada (Vercel), jika tidak ada, pakai file lokal credentials.json (Laptop)
let clientEmail, privateKey;

if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
  clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  // Memaksa Vercel menerjemahkan \n menjadi baris baru asli agar Google Auth tidak crash
  privateKey = process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');
} else {
  try {
    const creds = require('./credentials.json');
    clientEmail = creds.client_email;
    privateKey = creds.private_key;
  } catch (e) {
    console.error("PERINGATAN: File credentials.json tidak ditemukan dan Env Variables kosong!");
  }
}

const serviceAccountAuth = new JWT({
  email: clientEmail,
  key: privateKey,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);

async function mulaiServer() {
  try {
    await doc.loadInfo();
    console.log(`📡 Koneksi Google Sheets Sukses: "${doc.title}"`);

    // ================= ROUTE AUTHENTICATION =================
    app.get('/login', (req, res) => res.render('login', { pesanError: null }));
    app.post('/login', (req, res) => {
      const { username, password } = req.body;
      if (username === AKUN_ADMIN.username && password === AKUN_ADMIN.password) {
        req.session.isLoggedIn = true; req.session.role = 'admin'; req.session.nama = 'Administrator RT';
        return res.redirect('/');
      } else if (username === AKUN_USER.username && password === AKUN_USER.password) {
        req.session.isLoggedIn = true; req.session.role = 'user'; req.session.nama = 'Warga RT 09';
        return res.redirect('/');
      }
      res.render('login', { pesanError: "Username atau Password salah!" });
    });
    app.get('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

    // ================= ROUTE DASHBOARD IPL WARGA =================
    app.get('/', pastikanLogin, async (req, res) => {
      try {
        const tahunDipilih = req.query.tahun || "2026"; 
        const sheet = doc.sheetsByTitle[tahunDipilih];
        if (!sheet) return res.status(404).send(`Tab tahun ${tahunDipilih} tidak ditemukan.`);
        const rows = await sheet.getRows();
        res.render('index', { warga: rows, daftarTahun: DAFTAR_TAHUN, tahunAktif: tahunDipilih, role: req.session.role, namaUser: req.session.nama });
      } catch (err) { res.status(500).send("Error: " + err.message); }
    });

    // ================= ROUTE DASHBOARD KAS RT =================
    app.get('/kas', pastikanLogin, async (req, res) => {
      try {
        const sheetKas = doc.sheetsByTitle['KAS'];
        if (!sheetKas) return res.status(404).send("Tab 'KAS' tidak ditemukan.");
        const rowsKas = await sheetKas.getRows();

        let setFilter = new Set();
        rowsKas.forEach(row => {
          const tgl = row.get('tanggal');
          if (tgl && tgl.includes('-')) setFilter.add(`${tgl.split('-')[0]}-${tgl.split('-')[1]}`);
        });

        const periodeAktif = req.query.periode || "Semua";
        
        // Hitung total penerimaan IPL warga dari sheet "2026"
        const sheetIPL = doc.sheetsByTitle["2026"];
        let totalPenerimaanIPL = 0;
        if (sheetIPL) {
          const rowsIPL = await sheetIPL.getRows();
          rowsIPL.forEach(row => {
            ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember","THR"].forEach(bln => {
              totalPenerimaanIPL += bersihkanKeAngkaMurni(row.get(bln));
            });
          });
        }

        res.render('kas', { 
          kasData: rowsKas, 
          daftarFilterPeriode: Array.from(setFilter).sort().reverse(),
          periodeAktif: periodeAktif, 
          role: req.session.role, 
          namaUser: req.session.nama,
          totalIPL: totalPenerimaanIPL, 
          getNamaBulanIndo: getNamaBulanIndo
        });
      } catch (err) { res.status(500).send("Error: " + err.message); }
    });

    // ================= KAS: TAMBAH DATA (FORM RINGKAS) =================
    app.get('/kas/tambah', pastikanLogin, pastikanAdmin, (req, res) => {
      res.render('kas_tambah', { jenis: req.query.jenis || 'pemasukan' });
    });

    app.post('/kas/simpan', pastikanLogin, pastikanAdmin, async (req, res) => {
      try {
        const sheetKas = doc.sheetsByTitle['KAS'];
        const isPem = req.body.jenis === 'pemasukan';
        const nominalInput = bersihkanKeAngkaMurni(req.body.nominal);
        
        await sheetKas.addRow({
          "no": "", 
          "tanggal": req.body.tanggal, 
          "bulan": "", 
          "keterangan": req.body.keterangan.toUpperCase(),
          "pemasukan": isPem ? nominalInput.toString() : '0',
          "pengeluaran": !isPem ? nominalInput.toString() : '0',
          "saldo": "0"
        });
        
        await hitungUlangSaldoKas(sheetKas);
        res.redirect('/kas');
      } catch (err) { res.status(500).send("Error: " + err.message); }
    });

    // ================= KAS: MANAGEMENT MUTASI DATA (EDIT & HAPUS) =================
    app.get('/kas/edit/:no', pastikanLogin, pastikanAdmin, async (req, res) => {
      try {
        const rows = await doc.sheetsByTitle['KAS'].getRows();
        const dataKas = rows.find(r => r.get('no') === req.params.no);
        if (!dataKas) return res.status(404).send("Data tidak ditemukan.");
        res.render('kas_edit', { kas: dataKas });
      } catch (err) { res.status(500).send(err.message); }
    });

    app.post('/kas/update/:no', pastikanLogin, pastikanAdmin, async (req, res) => {
      try {
        const sheetKas = doc.sheetsByTitle['KAS'];
        const rows = await sheetKas.getRows();
        const dataKas = rows.find(r => r.get('no') === req.params.no);
        
        const pemInput = bersihkanKeAngkaMurni(req.body.pemasukan);
        const pengInput = bersihkanKeAngkaMurni(req.body.pengeluaran);

        dataKas.set('tanggal', req.body.tanggal);
        dataKas.set('keterangan', req.body.keterangan.toUpperCase());
        dataKas.set('pemasukan', pemInput.toString());
        dataKas.set('pengeluaran', pengInput.toString());
        await dataKas.save();

        await hitungUlangSaldoKas(sheetKas);
        res.redirect('/kas');
      } catch (err) { res.status(500).send(err.message); }
    });

    app.get('/kas/hapus/:no', pastikanLogin, pastikanAdmin, async (req, res) => {
      try {
        const sheetKas = doc.sheetsByTitle['KAS'];
        const rows = await sheetKas.getRows();
        const target = rows.find(r => r.get('no') === req.params.no);
        if (target) { 
          await target.delete(); 
          await hitungUlangSaldoKas(sheetKas); 
        }
        res.redirect('/kas');
      } catch (err) { res.status(500).send(err.message); }
    });

    // ================= MODULE MANIPULASI DATA IPL WARGA =================
    app.get('/tambah', pastikanLogin, pastikanAdmin, (req, res) => res.render('tambah', { daftarBlok: DAFTAR_BLOK, tahunAktif: req.query.tahun || "2026" }));
    
    app.post('/simpan', pastikanLogin, pastikanAdmin, async (req, res) => {
      try {
        const sheet = doc.sheetsByTitle[req.body.tahun_target]; 
        const r = await sheet.getRows();
        await sheet.addRow({ 
          "no": (r.length + 1).toString(), "nama_kk": req.body.nama_kk.toUpperCase(), "blok_rumah": req.body.blok_rumah, 
          "Januari": req.body.januari || "", "Februari": req.body.februari || "", "Maret": req.body.maret || "", 
          "April": req.body.april || "", "Mei": req.body.mei || "", "Juni": req.body.juni || "", 
          "Juli": req.body.juli || "", "Agustus": req.body.agustus || "", "September": req.body.september || "", 
          "Oktober": req.body.oktober || "", "November": req.body.november || "", "Desember": req.body.desember || "", 
          "THR": req.body.thr || "" 
        });
        res.redirect(`/?tahun=${req.body.tahun_target}`);
      } catch (err) { res.status(500).send(err.message); }
    });

    app.get('/edit/:no', pastikanLogin, pastikanAdmin, async (req, res) => {
      try { 
        const sheet = doc.sheetsByTitle[req.query.tahun || "2026"]; 
        const r = await sheet.getRows(); 
        res.render('edit', { warga: r.find(w => w.get('no') === req.params.no), daftarBlok: DAFTAR_BLOK, tahunAktif: req.query.tahun || "2026" }); 
      } catch (err) { res.status(500).send(err.message); }
    });

    app.post('/update/:no', pastikanLogin, pastikanAdmin, async (req, res) => {
      try {
        const sheet = doc.sheetsByTitle[req.body.tahun_target]; 
        const r = await sheet.getRows(); 
        const w = r.find(row => row.get('no') === req.params.no);
        
        w.set('nama_kk', req.body.nama_kk.toUpperCase()); 
        w.set('blok_rumah', req.body.blok_rumah);
        
        ["Januari","Februari","Maret","April","Mei","Juni","Juli","Agustus","September","Oktober","November","Desember"].forEach(m => {
          w.set(m, req.body[m.toLowerCase()] || "");
        });
        w.set('THR', req.body.thr || ""); 
        
        await w.save(); 
        res.redirect(`/?tahun=${req.body.tahun_target}`);
      } catch (err) { res.status(500).send(err.message); }
    });

    app.listen(PORT, () => console.log(`👉 Server running on: http://localhost:${PORT}`));
  } catch (error) { console.error("FATAL ERROR SERVER:", error.message); }
}

mulaiServer();