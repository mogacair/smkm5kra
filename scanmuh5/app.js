/* ==========================================================================
   ScanMuh5 - SMK Muhammadiyah 5 Karanganyar
   Offline-First PWA (IndexedDB + ZIP/Excel + QR + KTP PDF + WA + GAS Sync)
   ========================================================================== */

const DB_NAME = "ScanMuh5_DB";
const DB_VERSION = 1;
let db = null;
let html5QrScanner = null;
let isCameraRunning = false;
let lastScannedCode = "";
let lastScannedTime = 0;

// ==================== 1. INISIALISASI INDEXEDDB ====================
function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      if (!database.objectStoreNames.contains("students")) {
        database.createObjectStore("students", { keyPath: "nisn" });
      }
      if (!database.objectStoreNames.contains("activities")) {
        database.createObjectStore("activities", { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains("logs")) {
        const logStore = database.createObjectStore("logs", {
          keyPath: "id",
          autoIncrement: true,
        });
        logStore.createIndex("nisn", "nisn", { unique: false });
        logStore.createIndex("tanggal", "tanggal", { unique: false });
      }
    };

    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

function dbGetAll(storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(storeName, data) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).put(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function seedDefaultActivities() {
  const existing = await dbGetAll("activities");
  if (existing.length === 0) {
    const defaults = [
      { id: "act_kedatangan", nama: "Kedatangan", mulai: "06:30", selesai: "07:15" },
      { id: "act_duha", nama: "Sholat Duha", mulai: "09:15", selesai: "09:45" },
      { id: "act_pulang", nama: "Pulang", mulai: "15:00", selesai: "16:30" },
    ];
    for (const act of defaults) {
      await dbPut("activities", act);
    }
  }
}

// ==================== 2. UTILITAS UMUM & AUDIO ====================
function getTodayISO() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getNowTime() {
  const now = new Date();
  return now.toTimeString().slice(0, 8);
}

function formatDateID(isoDate) {
  if (!isoDate) return "-";
  const [y, m, d] = isoDate.split("-");
  return `${d}/${m}/${y}`;
}

function playBeep(type = "success") {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    if (type === "success") {
      osc.frequency.value = 880;
      gain.gain.value = 0.2;
      osc.start();
      osc.stop(ctx.currentTime + 0.14);
    } else if (type === "duplicate") {
      osc.frequency.value = 520;
      gain.gain.value = 0.2;
      osc.start();
      osc.stop(ctx.currentTime + 0.25);
    } else {
      osc.frequency.value = 240;
      gain.gain.value = 0.25;
      osc.start();
      osc.stop(ctx.currentTime + 0.35);
    }
  } catch (_) {}
}

function compressImageBlob(blob, maxW = 300, maxH = 400, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      canvas.width = maxW;
      canvas.height = maxH;
      const ctx = canvas.getContext("2d");

      // Center crop agar rasio pas 3:4
      const srcRatio = img.width / img.height;
      const dstRatio = maxW / maxH;
      let sx = 0, sy = 0, sw = img.width, sh = img.height;
      if (srcRatio > dstRatio) {
        sw = img.height * dstRatio;
        sx = (img.width - sw) / 2;
      } else {
        sh = img.width / dstRatio;
        sy = (img.height - sh) / 2;
      }

      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, maxW, maxH);
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, maxW, maxH);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Gagal memproses gambar"));
    };
    img.src = url;
  });
}

function generateQRDataURL(text, size = 256) {
  return new Promise((resolve) => {
    const holder = document.createElement("div");
    holder.style.position = "fixed";
    holder.style.left = "-9999px";
    document.body.appendChild(holder);

    new QRCode(holder, {
      text: String(text),
      width: size,
      height: size,
      colorDark: "#000000",
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M,
    });

    setTimeout(() => {
      const canvas = holder.querySelector("canvas");
      const img = holder.querySelector("img");
      let dataUrl = "";
      if (canvas) {
        dataUrl = canvas.toDataURL("image/png");
      } else if (img && img.src) {
        dataUrl = img.src;
      }
      document.body.removeChild(holder);
      resolve(dataUrl);
    }, 30);
  });
}

// ==================== 3. NAVIGASI TAB SPA ====================
function initNavigation() {
  const navButtons = document.querySelectorAll(".nav-item");
  const sections = document.querySelectorAll(".tab-section");

  navButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = btn.dataset.tab;

      // Matikan kamera jika pindah dari tab scan agar hemat baterai
      if (target !== "scan" && isCameraRunning) {
        await stopScanner();
      }

      navButtons.forEach((b) => b.classList.remove("active"));
      sections.forEach((s) => s.classList.remove("active"));

      btn.classList.add("active");
      document.getElementById(`tab-${target}`).classList.add("active");

      if (target === "scan") await refreshScanTab();
      if (target === "siswa") await renderSiswaList();
      if (target === "kegiatan") await renderKegiatanList();
      if (target === "kartu") await renderKartuTab();
      if (target === "laporan") await initLaporanTab();
    });
  });

  // Status Online / Offline
  const badge = document.getElementById("offline-badge");
  const updateNetStatus = () => {
    if (navigator.onLine) {
      badge.textContent = "Online";
      badge.className = "status-pill online";
    } else {
      badge.textContent = "Offline";
      badge.className = "status-pill offline";
    }
  };
  window.addEventListener("online", updateNetStatus);
  window.addEventListener("offline", updateNetStatus);
  updateNetStatus();
}

// ==================== 4. FITUR SCAN BARCODE & KEGIATAN ====================
async function refreshScanTab() {
  const activities = await dbGetAll("activities");
  const select = document.getElementById("scan-activity-select");
  const currentVal = select.value;

  select.innerHTML = activities
    .map((a) => `<option value="${a.id}">${a.nama}</option>`)
    .join("");

  if (currentVal && activities.some((a) => a.id === currentVal)) {
    select.value = currentVal;
  }
  updateActivityInfo();
  await renderTodayScans();
}

async function updateActivityInfo() {
  const id = document.getElementById("scan-activity-select").value;
  const act = await dbGet("activities", id);
  const infoEl = document.getElementById("scan-activity-info");
  if (act && (act.mulai || act.selesai)) {
    infoEl.textContent = `Jadwal: ${act.mulai || "--:--"} s.d. ${act.selesai || "--:--"}`;
  } else {
    infoEl.textContent = "Jadwal fleksibel (tanpa batas jam)";
  }
}

async function startScanner() {
  const btn = document.getElementById("btn-toggle-camera");
  if (!html5QrScanner) {
    html5QrScanner = new Html5Qrcode("qr-reader");
  }

  try {
    await html5QrScanner.start(
      { facingMode: "environment" },
      { fps: 12, qrbox: { width: 230, height: 230 } },
      async (decodedText) => {
        const now = Date.now();
        if (decodedText === lastScannedCode && now - lastScannedTime < 2500) {
          return;
        }
        lastScannedCode = decodedText;
        lastScannedTime = now;
        await processScanNISN(decodedText.trim());
      },
      () => {}
    );
    isCameraRunning = true;
    btn.textContent = "Matikan Kamera";
    btn.classList.replace("btn-primary", "btn-danger");
  } catch (err) {
    alert("Kamera tidak dapat diakses. Pastikan izin kamera diaktifkan.\nDetail: " + err);
  }
}

async function stopScanner() {
  const btn = document.getElementById("btn-toggle-camera");
  if (html5QrScanner && isCameraRunning) {
    try {
      await html5QrScanner.stop();
    } catch (_) {}
  }
  isCameraRunning = false;
  btn.textContent = "Aktifkan Kamera Scan";
  btn.classList.replace("btn-danger", "btn-primary");
}

async function processScanNISN(nisn) {
  const feedbackEl = document.getElementById("scan-feedback");
  const activityId = document.getElementById("scan-activity-select").value;
  const activity = await dbGet("activities", activityId);

  if (!activity) {
    alert("Pilih kegiatan terlebih dahulu!");
    return;
  }

  const student = await dbGet("students", nisn);
  if (!student) {
    playBeep("error");
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    feedbackEl.className = "scan-feedback error";
    feedbackEl.innerHTML = `
      <div>
        <div>❌ NISN Tidak Terdaftar: <strong>${nisn}</strong></div>
        <small>Pastikan kartu milik siswa SMK Muhammadiyah 5 Karanganyar.</small>
      </div>
    `;
    return;
  }

  const today = getTodayISO();
  const allLogs = await dbGetAll("logs");
  const alreadyScanned = allLogs.find(
    (l) => l.nisn === nisn && l.activity_id === activityId && l.tanggal === today
  );

  if (alreadyScanned) {
    playBeep("duplicate");
    if (navigator.vibrate) navigator.vibrate(150);
    feedbackEl.className = "scan-feedback duplicate";
    feedbackEl.innerHTML = `
      ${student.foto ? `<img src="${student.foto}" alt="Foto" />` : ""}
      <div>
        <div>⚠️ SUDAH TERCATAT (${activity.nama})</div>
        <div><strong>${student.nama}</strong> (${student.kelas || "-"})</div>
        <small>Sudah scan pukul ${alreadyScanned.waktu}</small>
      </div>
    `;
    return;
  }

  const waktu = getNowTime();
  await dbPut("logs", {
    nisn: student.nisn,
    nama_siswa: student.nama,
    kelas: student.kelas || "-",
    activity_id: activity.id,
    activity_nama: activity.nama,
    tanggal: today,
    waktu: waktu,
    status: "Hadir",
  });

  playBeep("success");
  if (navigator.vibrate) navigator.vibrate(80);

  feedbackEl.className = "scan-feedback success";
  feedbackEl.innerHTML = `
    ${student.foto ? `<img src="${student.foto}" alt="Foto" />` : ""}
    <div>
      <div>✅ BERHASIL - ${activity.nama.toUpperCase()}</div>
      <div><strong>${student.nama}</strong> (${student.kelas || "-"})</div>
      <small>NISN: ${student.nisn} • Pukul ${waktu}</small>
    </div>
  `;

  await renderTodayScans();
}

async function renderTodayScans() {
  const today = getTodayISO();
  const logs = await dbGetAll("logs");
  const todayLogs = logs.filter((l) => l.tanggal === today).reverse();

  document.getElementById("today-scan-count").textContent = `Hari ini: ${todayLogs.length}`;
  const container = document.getElementById("recent-scans-list");

  if (todayLogs.length === 0) {
    container.innerHTML = `<p class="empty-state">Belum ada aktivitas scan hari ini.</p>`;
    return;
  }

  container.innerHTML = todayLogs
    .slice(0, 15)
    .map(
      (item) => `
      <div class="item-card">
        <div class="student-meta">
          <h4>${item.nama_siswa} <small>(${item.kelas})</small></h4>
          <p><strong>${item.activity_nama}</strong> • Pukul ${item.waktu}</p>
        </div>
        <span class="badge-info">${item.nisn}</span>
      </div>
    `
    )
    .join("");
}

// ==================== 5. MANAJEMEN DATA SISWA, EXCEL & ZIP ====================
async function renderSiswaList() {
  const students = await dbGetAll("students");
  students.sort((a, b) => a.nama.localeCompare(b.nama));

  document.getElementById("total-siswa-badge").textContent = `${students.length} Siswa`;

  // Populate dropdown filter kelas
  const kelasSet = [...new Set(students.map((s) => s.kelas).filter(Boolean))].sort();
  const filterSelect = document.getElementById("filter-kelas-siswa");
  const prevKelas = filterSelect.value;
  filterSelect.innerHTML =
    `<option value="">Semua Kelas</option>` +
    kelasSet.map((k) => `<option value="${k}">${k}</option>`).join("");
  if (kelasSet.includes(prevKelas)) filterSelect.value = prevKelas;

  const query = document.getElementById("search-siswa").value.toLowerCase().trim();
  const selectedKelas = filterSelect.value;

  const filtered = students.filter((s) => {
    const matchText =
      s.nama.toLowerCase().includes(query) || String(s.nisn).toLowerCase().includes(query);
    const matchKelas = !selectedKelas || s.kelas === selectedKelas;
    return matchText && matchKelas;
  });

  const listEl = document.getElementById("siswa-list");
  if (filtered.length === 0) {
    listEl.innerHTML = `<p class="empty-state">Tidak ada data siswa yang cocok.</p>`;
    return;
  }

  listEl.innerHTML = filtered
    .map(
      (s) => `
      <div class="item-card">
        <div class="student-row">
          ${
            s.foto
              ? `<img src="${s.foto}" class="student-avatar" alt="${s.nama}" />`
              : `<div class="student-avatar">NO FOTO</div>`
          }
          <div class="student-meta">
            <h4>${s.nama}</h4>
            <p>NISN: <strong>${s.nisn}</strong> • ${s.kelas || "Tanpa Kelas"}</p>
            <p>${s.ttl}</p>
          </div>
        </div>
        <div class="item-actions">
          <button class="btn btn-outline btn-sm" onclick="editSiswa('${s.nisn}')">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="hapusSiswa('${s.nisn}')">Hapus</button>
        </div>
      </div>
    `
    )
    .join("");
}

function downloadExcelTemplate() {
  const sampleData = [
    {
      NISN: "0081234567",
      Nama: "Ahmad Fauzi",
      Kelas: "XI TKJ 1",
      TTL: "Karanganyar, 12 Mei 2008",
      Alamat: "Jl. Lawu No. 45, Karanganyar",
      No_WA_Ortu: "081234567890",
    },
    {
      NISN: "0087654321",
      Nama: "Siti Rahmawati",
      Kelas: "XI TKJ 1",
      TTL: "Surakarta, 20 September 2008",
      Alamat: "Tasikmadu, Karanganyar",
      No_WA_Ortu: "085612345678",
    },
  ];
  const ws = XLSX.utils.json_to_sheet(sampleData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Data_Siswa");
  XLSX.writeFile(wb, "Template_Data_Siswa_ScanMuh5.xlsx");
}

async function handleImportExcel(file) {
  if (!file) return;
  const buffer = await file.arrayBuffer();
  const wb = XLSX.read(buffer, { type: "array" });
  const sheetName = wb.SheetNames[0];
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: "" });

  if (rows.length === 0) {
    alert("File Excel kosong!");
    return;
  }

  let imported = 0;
  for (const row of rows) {
    // Mendukung variasi kapitalisasi header kolom
    const nisn = String(row.NISN || row.nisn || "").trim();
    const nama = String(row.Nama || row.NAMA || row.nama || "").trim();
    if (!nisn || !nama) continue;

    const existing = await dbGet("students", nisn);
    await dbPut("students", {
      nisn,
      nama,
      kelas: String(row.Kelas || row.KELAS || row.kelas || existing?.kelas || "").trim(),
      ttl: String(row.TTL || row.ttl || existing?.ttl || "-").trim(),
      alamat: String(row.Alamat || row.ALAMAT || row.alamat || existing?.alamat || "-").trim(),
      no_wa_ortu: String(
        row.No_WA_Ortu || row.WA || row.no_wa_ortu || existing?.no_wa_ortu || ""
      ).trim(),
      foto: existing?.foto || "",
    });
    imported++;
  }

  alert(`Berhasil mengimpor ${imported} data siswa.`);
  await renderSiswaList();
}

async function handleImportZipPhotos(file) {
  if (!file) return;
  const progressBox = document.getElementById("import-progress-box");
  const progressText = document.getElementById("import-progress-text");
  const progressBar = document.getElementById("import-progress-bar");

  progressBox.classList.remove("hidden");
  progressText.textContent = "Membaca arsip ZIP...";
  progressBar.style.width = "5%";

  try {
    const zip = await JSZip.loadAsync(file);
    const entries = Object.values(zip.files).filter(
      (entry) =>
        !entry.dir &&
        !entry.name.includes("__MACOSX") &&
        /\.(jpe?g|png|webp)$/i.test(entry.name)
    );

    if (entries.length === 0) {
      alert("Tidak ditemukan file gambar (.jpg/.png) di dalam ZIP.");
      progressBox.classList.add("hidden");
      return;
    }

    let matched = 0;
    let unmatched = 0;

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const baseName = entry.name
        .replace(/^.*[\\/]/, "")
        .replace(/\.[^/.]+$/, "")
        .trim();

      const student = await dbGet("students", baseName);
      if (student) {
        const blob = await entry.async("blob");
        const compressedBase64 = await compressImageBlob(blob, 300, 400, 0.8);
        student.foto = compressedBase64;
        await dbPut("students", student);
        matched++;
      } else {
        unmatched++;
      }

      const pct = Math.round(((i + 1) / entries.length) * 100);
      progressBar.style.width = `${pct}%`;
      progressText.textContent = `Memproses foto ${i + 1}/${entries.length} (Cocok: ${matched})...`;
    }

    alert(
      `Proses ZIP selesai!\n• Foto cocok dengan NISN: ${matched}\n• Nama file tidak cocok NISN: ${unmatched}`
    );
    await renderSiswaList();
  } catch (err) {
    alert("Gagal membaca file ZIP: " + err.message);
  } finally {
    progressBox.classList.add("hidden");
  }
}

window.editSiswa = async function (nisn) {
  const s = await dbGet("students", nisn);
  if (!s) return;

  document.getElementById("modal-siswa-title").textContent = "Edit Data Siswa";
  document.getElementById("siswa-edit-mode").value = "edit";
  document.getElementById("input-nisn").value = s.nisn;
  document.getElementById("input-nisn").readOnly = true;
  document.getElementById("input-nama").value = s.nama;
  document.getElementById("input-kelas").value = s.kelas || "";
  document.getElementById("input-wa").value = s.no_wa_ortu || "";
  document.getElementById("input-ttl").value = s.ttl || "";
  document.getElementById("input-alamat").value = s.alamat || "";

  const prev = document.getElementById("preview-foto-single");
  if (s.foto) {
    prev.src = s.foto;
    prev.classList.remove("hidden");
  } else {
    prev.classList.add("hidden");
  }

  document.getElementById("modal-siswa").classList.remove("hidden");
};

window.hapusSiswa = async function (nisn) {
  if (!confirm(`Hapus siswa dengan NISN ${nisn}?`)) return;
  await dbDelete("students", nisn);
  await renderSiswaList();
};

// ==================== 6. KELOLA KEGIATAN BARCODE ====================
async function renderKegiatanList() {
  const activities = await dbGetAll("activities");
  const container = document.getElementById("kegiatan-list");

  container.innerHTML = activities
    .map(
      (a) => `
      <div class="item-card">
        <div class="student-meta">
          <h4>${a.nama}</h4>
          <p>Jadwal: ${a.mulai || "--:--"} s.d. ${a.selesai || "--:--"}</p>
        </div>
        <div class="btn-row">
          <button class="btn btn-outline btn-sm" onclick="editKegiatan('${a.id}')">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="hapusKegiatan('${a.id}')">Hapus</button>
        </div>
      </div>
    `
    )
    .join("");
}

window.editKegiatan = async function (id) {
  const act = await dbGet("activities", id);
  if (!act) return;
  document.getElementById("form-kegiatan-title").textContent = "Edit Kegiatan";
  document.getElementById("kegiatan-id").value = act.id;
  document.getElementById("kegiatan-nama").value = act.nama;
  document.getElementById("kegiatan-mulai").value = act.mulai || "";
  document.getElementById("kegiatan-selesai").value = act.selesai || "";
  document.getElementById("btn-reset-kegiatan").classList.remove("hidden");
};

window.hapusKegiatan = async function (id) {
  if (!confirm("Hapus kegiatan ini? Riwayat scan lama tetap tersimpan.")) return;
  await dbDelete("activities", id);
  await renderKegiatanList();
};

// ==================== 7. CETAK KARTU PELAJAR PDF (UKURAN KTP) ====================
async function renderKartuTab() {
  const students = await dbGetAll("students");
  students.sort((a, b) => a.nama.localeCompare(b.nama));

  const kelasSet = [...new Set(students.map((s) => s.kelas).filter(Boolean))].sort();
  const kelasSelect = document.getElementById("print-filter-kelas");
  const prevVal = kelasSelect.value;
  kelasSelect.innerHTML =
    `<option value="">Semua Kelas (${students.length})</option>` +
    kelasSet.map((k) => `<option value="${k}">${k}</option>`).join("");
  if (kelasSet.includes(prevVal)) kelasSelect.value = prevVal;

  const q = document.getElementById("print-search-siswa").value.toLowerCase().trim();
  const kFilter = kelasSelect.value;

  const filtered = students.filter((s) => {
    const matchText =
      s.nama.toLowerCase().includes(q) || String(s.nisn).toLowerCase().includes(q);
    const matchKelas = !kFilter || s.kelas === kFilter;
    return matchText && matchKelas;
  });

  const listEl = document.getElementById("card-preview-list");
  if (filtered.length === 0) {
    listEl.innerHTML = `<p class="empty-state">Tidak ada siswa yang dipilih.</p>`;
    return;
  }

  listEl.innerHTML = filtered
    .map(
      (s) => `
      <div class="item-card">
        <div class="student-row">
          ${
            s.foto
              ? `<img src="${s.foto}" class="student-avatar" alt="${s.nama}" />`
              : `<div class="student-avatar">NO FOTO</div>`
          }
          <div class="student-meta">
            <h4>${s.nama}</h4>
            <p>NISN: ${s.nisn} • ${s.kelas || "-"}</p>
          </div>
        </div>
        <button class="btn btn-secondary btn-sm" onclick="downloadSingleCardPDF('${s.nisn}')">
          PDF 1 Kartu
        </button>
      </div>
    `
    )
    .join("");
}

async function drawStudentCardPage(doc, student, logoDataUrl) {
  // Ukuran standar KTP / ID Card: 85.6 mm x 53.98 mm
  const W = 85.6;
  const H = 53.98;

  // Latar belakang putih bersih
  doc.setFillColor(255, 255, 255);
  doc.rect(0, 0, W, H, "F");

  // Header Hijau Muhammadiyah
  doc.setFillColor(6, 95, 70);
  doc.rect(0, 0, W, 11.5, "F");

  // Garis aksen emas
  doc.setFillColor(245, 158, 11);
  doc.rect(0, 11.5, W, 0.7, "F");

  // Logo Sekolah
  if (logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, "PNG", 2.5, 1.5, 8.5, 8.5);
    } catch (_) {}
  } else {
    doc.setFillColor(251, 191, 36);
    doc.circle(6.75, 5.75, 4, "F");
    doc.setTextColor(6, 78, 59);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(6.5);
    doc.text("M5", 6.75, 6.5, { align: "center" });
  }

  // Judul Kartu & Nama SMK
  doc.setTextColor(253, 230, 138);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(6);
  doc.text("KARTU PELAJAR", 12.8, 4.7);

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(7.4);
  doc.text("SMK MUHAMMADIYAH 5 KARANGANYAR", 12.8, 9.0);

  // Pas Foto Siswa (Rasio 3:4 -> 18mm x 24mm)
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.3);
  if (student.foto) {
    doc.addImage(student.foto, "JPEG", 3, 14, 18, 24);
    doc.rect(3, 14, 18, 24);
  } else {
    doc.setFillColor(241, 245, 249);
    doc.rect(3, 14, 18, 24, "FD");
    doc.setTextColor(100, 116, 139);
    doc.setFontSize(5.5);
    doc.text("FOTO 3x4", 12, 26.5, { align: "center" });
  }

  // Kotak NISN di bawah foto agar mudah dibaca
  doc.setFillColor(236, 253, 245);
  doc.setDrawColor(167, 243, 208);
  doc.rect(3, 39.2, 18, 5.5, "FD");
  doc.setTextColor(6, 78, 59);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(6);
  doc.text(String(student.nisn), 12, 42.7, { align: "center" });

  // Biodata Siswa (Tengah: x = 23 s.d. 60.5)
  let yCursor = 16.8;
  doc.setTextColor(15, 23, 42);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(7.5);
  const namaLines = doc.splitTextToSize(student.nama.toUpperCase(), 37.5).slice(0, 2);
  doc.text(namaLines, 23, yCursor);
  yCursor += namaLines.length * 3.3 + 1.2;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(6);
  doc.setTextColor(71, 85, 105);
  doc.text(`NISN : ${student.nisn}`, 23, yCursor);
  yCursor += 3.4;

  const ttlLines = doc.splitTextToSize(`TTL : ${student.ttl || "-"}`, 37.5).slice(0, 2);
  doc.text(ttlLines, 23, yCursor);
  yCursor += ttlLines.length * 3.0 + 0.6;

  const alamatLines = doc
    .splitTextToSize(`Alamat : ${student.alamat || "-"}`, 37.5)
    .slice(0, 3);
  doc.text(alamatLines, 23, yCursor);

  // QR Code Persegi (Kanan: Quiet zone putih + QR 20x20 mm)
  const qrDataUrl = await generateQRDataURL(student.nisn, 260);
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(203, 213, 225);
  doc.rect(61.5, 13.8, 21.6, 21.6, "FD");
  if (qrDataUrl) {
    doc.addImage(qrDataUrl, "PNG", 62.3, 14.6, 20, 20);
  }

  doc.setTextColor(6, 95, 70);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(5);
  doc.text("SCAN KEHADIRAN", 72.3, 38.2, { align: "center" });

  // Footer Kartu
  doc.setFillColor(241, 245, 249);
  doc.rect(0, 48.8, W, 5.18, "F");
  doc.setTextColor(71, 85, 105);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(5);
  doc.text("Kartu Identitas Resmi Siswa • SMK Muhammadiyah 5 Karanganyar", W / 2, 52.0, {
    align: "center",
  });
}

async function generatePDFForStudents(studentList, fileName) {
  if (studentList.length === 0) {
    alert("Tidak ada data siswa untuk dicetak.");
    return;
  }

  const progressBox = document.getElementById("pdf-progress-box");
  const progressText = document.getElementById("pdf-progress-text");
  const progressBar = document.getElementById("pdf-progress-bar");

  progressBox.classList.remove("hidden");
  progressBar.style.width = "0%";

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({
    orientation: "landscape",
    unit: "mm",
    format: [85.6, 53.98],
  });

  const logoDataUrl = localStorage.getItem("scanmuh5_logo") || "";

  for (let i = 0; i < studentList.length; i++) {
    if (i > 0) {
      doc.addPage([85.6, 53.98], "landscape");
    }
    await drawStudentCardPage(doc, studentList[i], logoDataUrl);

    const pct = Math.round(((i + 1) / studentList.length) * 100);
    progressBar.style.width = `${pct}%`;
    progressText.textContent = `Membuat kartu ${i + 1} dari ${studentList.length} siswa...`;
  }

  doc.save(fileName);
  progressBox.classList.add("hidden");
}

window.downloadSingleCardPDF = async function (nisn) {
  const student = await dbGet("students", nisn);
  if (!student) return;
  await generatePDFForStudents([student], `Kartu_${student.nisn}_${student.nama}.pdf`);
};

// ==================== 8. LAPORAN PER SISWA & SHARE WHATSAPP ====================
async function initLaporanTab() {
  const students = await dbGetAll("students");
  students.sort((a, b) => a.nama.localeCompare(b.nama));

  const select = document.getElementById("laporan-siswa-select");
  const prevVal = select.value;
  select.innerHTML =
    `<option value="">-- Pilih Nama Siswa --</option>` +
    students
      .map((s) => `<option value="${s.nisn}">${s.nama} (${s.kelas || "-"} - ${s.nisn})</option>`)
      .join("");

  if (prevVal && students.some((s) => s.nisn === prevVal)) {
    select.value = prevVal;
  }

  const startInput = document.getElementById("laporan-tgl-mulai");
  const endInput = document.getElementById("laporan-tgl-selesai");
  if (!startInput.value) {
    const today = getTodayISO();
    startInput.value = today.slice(0, 8) + "01"; // Tanggal 1 bulan berjalan
    endInput.value = today;
  }

  await renderLaporanSiswa();
}

async function renderLaporanSiswa() {
  const nisn = document.getElementById("laporan-siswa-select").value;
  const startDate = document.getElementById("laporan-tgl-mulai").value;
  const endDate = document.getElementById("laporan-tgl-selesai").value;
  const summaryBox = document.getElementById("laporan-summary-box");
  const historyList = document.getElementById("laporan-history-list");
  const btnWA = document.getElementById("btn-share-wa");

  if (!nisn) {
    summaryBox.classList.add("hidden");
    btnWA.disabled = true;
    historyList.innerHTML = `<p class="empty-state">Pilih siswa di atas untuk melihat rincian kegiatan.</p>`;
    return;
  }

  const student = await dbGet("students", nisn);
  const allLogs = await dbGetAll("logs");

  const filteredLogs = allLogs.filter((l) => {
    if (l.nisn !== nisn) return false;
    if (startDate && l.tanggal < startDate) return false;
    if (endDate && l.tanggal > endDate) return false;
    return true;
  });

  // Hitung rekap per jenis kegiatan
  const counts = {};
  filteredLogs.forEach((l) => {
    counts[l.activity_nama] = (counts[l.activity_nama] || 0) + 1;
  });

  const rekapLines = Object.entries(counts)
    .map(([keg, jml]) => `• ${keg}: <strong>${jml} kali</strong>`)
    .join("<br/>");

  summaryBox.classList.remove("hidden");
  summaryBox.innerHTML = `
    <div><strong>${student.nama}</strong> (${student.kelas || "-"})</div>
    <div>NISN: ${student.nisn} | WA Ortu: ${student.no_wa_ortu || "Belum diisi"}</div>
    <hr style="margin:8px 0; border:none; border-top:1px solid #cbd5e1;" />
    <div><strong>Rekap Periode ${formatDateID(startDate)} s.d. ${formatDateID(endDate)}:</strong></div>
    <div>${rekapLines || "Belum ada catatan kegiatan pada periode ini."}</div>
  `;

  btnWA.disabled = false;

  if (filteredLogs.length === 0) {
    historyList.innerHTML = `<p class="empty-state">Tidak ada catatan scan pada rentang tanggal ini.</p>`;
    return;
  }

  historyList.innerHTML = filteredLogs
    .slice()
    .reverse()
    .map(
      (l) => `
      <div class="item-card">
        <div class="student-meta">
          <h4>${l.activity_nama}</h4>
          <p>Tanggal: ${formatDateID(l.tanggal)} • Pukul ${l.waktu}</p>
        </div>
        <span class="badge-info">${l.status}</span>
      </div>
    `
    )
    .join("");
}

async function shareLaporanToWhatsApp() {
  const nisn = document.getElementById("laporan-siswa-select").value;
  if (!nisn) return;

  const student = await dbGet("students", nisn);
  const startDate = document.getElementById("laporan-tgl-mulai").value;
  const endDate = document.getElementById("laporan-tgl-selesai").value;
  const allLogs = await dbGetAll("logs");

  const filteredLogs = allLogs.filter((l) => {
    if (l.nisn !== nisn) return false;
    if (startDate && l.tanggal < startDate) return false;
    if (endDate && l.tanggal > endDate) return false;
    return true;
  });

  const counts = {};
  filteredLogs.forEach((l) => {
    counts[l.activity_nama] = (counts[l.activity_nama] || 0) + 1;
  });

  const rekapTeks =
    Object.entries(counts)
      .map(([keg, jml]) => `- ${keg}: ${jml} kali`)
      .join("\n") || "- Belum ada catatan kegiatan";

  const detailTerbaru = filteredLogs
    .slice(-10)
    .map((l) => `• ${formatDateID(l.tanggal)} (${l.waktu.slice(0, 5)}) - ${l.activity_nama}`)
    .join("\n");

  const pesan =
    `*LAPORAN KEGIATAN SISWA*\n` +
    `*SMK MUHAMMADIYAH 5 KARANGANYAR*\n\n` +
    `Nama : *${student.nama}*\n` +
    `NISN : ${student.nisn}\n` +
    `Kelas : ${student.kelas || "-"}\n` +
    `Periode : ${formatDateID(startDate)} s.d. ${formatDateID(endDate)}\n\n` +
    `*Ringkasan Kehadiran Kegiatan:*\n${rekapTeks}\n\n` +
    (detailTerbaru ? `*Catatan Terbaru:*\n${detailTerbaru}\n\n` : "") +
    `_Dikirim melalui aplikasi ScanMuh5_`;

  // Normalisasi nomor WA Indonesia (08xxx -> 628xxx)
  let phone = (student.no_wa_ortu || "").replace(/[^0-9]/g, "");
  if (phone.startsWith("0")) {
    phone = "62" + phone.slice(1);
  }

  const encodedText = encodeURIComponent(pesan);
  const waUrl = phone
    ? `https://wa.me/${phone}?text=${encodedText}`
    : `https://wa.me/?text=${encodedText}`;

  window.open(waUrl, "_blank");
}

// ==================== 9. PENGATURAN, LOGO & BACKUP GOOGLE SHEETS ====================
function initSettings() {
  const savedLogo = localStorage.getItem("scanmuh5_logo");
  const previewLogo = document.getElementById("preview-logo-smk");
  if (savedLogo) {
    previewLogo.src = savedLogo;
    previewLogo.classList.remove("hidden");
  }

  document.getElementById("input-logo-smk").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      localStorage.setItem("scanmuh5_logo", reader.result);
      previewLogo.src = reader.result;
      previewLogo.classList.remove("hidden");
      alert("Logo SMK berhasil disimpan!");
    };
    reader.readAsDataURL(file);
  });

  document.getElementById("btn-hapus-logo").addEventListener("click", () => {
    localStorage.removeItem("scanmuh5_logo");
    previewLogo.classList.add("hidden");
    alert("Logo dikembalikan ke bawaan.");
  });

  const gasInput = document.getElementById("input-gas-url");
  gasInput.value = localStorage.getItem("scanmuh5_gas_url") || "";

  document.getElementById("btn-save-gas-url").addEventListener("click", () => {
    localStorage.setItem("scanmuh5_gas_url", gasInput.value.trim());
    alert("URL Google Apps Script tersimpan.");
  });

  // Backup ke Google Sheet
  document.getElementById("btn-sync-gsheet").addEventListener("click", async () => {
    const url = localStorage.getItem("scanmuh5_gas_url") || gasInput.value.trim();
    const statusEl = document.getElementById("sync-status-text");

    if (!url) {
      alert("Masukkan dan simpan URL Web App Google Apps Script terlebih dahulu.");
      return;
    }
    if (!navigator.onLine) {
      alert("HP sedang offline. Hubungkan ke internet untuk backup ke Google Sheet.");
      return;
    }

    statusEl.textContent = "Sedang mengirim data ke Google Sheet...";

    try {
      const students = await dbGetAll("students");
      const activities = await dbGetAll("activities");
      const logs = await dbGetAll("logs");

      // Kirim data teks (tanpa foto Base64 agar tidak melebihi batas sel Google Sheets)
      const cleanStudents = students.map(({ foto, ...rest }) => ({
        ...rest,
        punya_foto: foto ? "Ya" : "Tidak",
      }));

      const payload = {
        school: "SMK Muhammadiyah 5 Karanganyar",
        exported_at: new Date().toISOString(),
        students: cleanStudents,
        activities,
        logs,
      };

      await fetch(url, {
        method: "POST",
        mode: "no-cors",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(payload),
      });

      const nowStr = new Date().toLocaleString("id-ID");
      statusEl.textContent = `✅ Backup terkirim pada ${nowStr} (${cleanStudents.length} siswa, ${logs.length} riwayat scan).`;
    } catch (err) {
      statusEl.textContent = `❌ Gagal backup: ${err.message}`;
    }
  });

  // Export Backup JSON Lengkap (Termasuk Foto)
  document.getElementById("btn-export-json").addEventListener("click", async () => {
    const data = {
      app: "ScanMuh5",
      date: new Date().toISOString(),
      students: await dbGetAll("students"),
      activities: await dbGetAll("activities"),
      logs: await dbGetAll("logs"),
    };
    const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Backup_Full_ScanMuh5_${getTodayISO()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  // Import Restore JSON
  document.getElementById("input-import-json").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.students)) {
        for (const s of parsed.students) await dbPut("students", s);
      }
      if (Array.isArray(parsed.activities)) {
        for (const a of parsed.activities) await dbPut("activities", a);
      }
      if (Array.isArray(parsed.logs)) {
        for (const l of parsed.logs) await dbPut("logs", l);
      }
      alert("Pemulihan backup lengkap berhasil!");
      await renderSiswaList();
    } catch (err) {
      alert("File backup tidak valid: " + err.message);
    }
  });
}

// ==================== 10. EVENT LISTENERS UTAMA ====================
document.addEventListener("DOMContentLoaded", async () => {
  await openDatabase();
  await seedDefaultActivities();

  initNavigation();
  initSettings();
  await refreshScanTab();

  // Register Service Worker untuk GitHub Pages (Relative Path)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch((err) => {
      console.warn("SW registration failed:", err);
    });
  }

  // Event Tab Scan
  document.getElementById("scan-activity-select").addEventListener("change", updateActivityInfo);
  document.getElementById("btn-toggle-camera").addEventListener("click", async () => {
    if (isCameraRunning) {
      await stopScanner();
    } else {
      await startScanner();
    }
  });

  document.getElementById("btn-manual-scan").addEventListener("click", async () => {
    const input = document.getElementById("manual-nisn-input");
    const val = input.value.trim();
    if (!val) return;
    await processScanNISN(val);
    input.value = "";
  });

  // Event Tab Siswa
  document.getElementById("btn-add-siswa").addEventListener("click", () => {
    document.getElementById("modal-siswa-title").textContent = "Tambah Data Siswa";
    document.getElementById("siswa-edit-mode").value = "add";
    document.getElementById("form-siswa").reset();
    document.getElementById("input-nisn").readOnly = false;
    document.getElementById("preview-foto-single").classList.add("hidden");
    document.getElementById("modal-siswa").classList.remove("hidden");
  });

  document.getElementById("btn-close-modal-siswa").addEventListener("click", () => {
    document.getElementById("modal-siswa").classList.add("hidden");
  });

  document.getElementById("input-foto-single").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const compressed = await compressImageBlob(file, 300, 400, 0.8);
    const prev = document.getElementById("preview-foto-single");
    prev.src = compressed;
    prev.classList.remove("hidden");
  });

  document.getElementById("form-siswa").addEventListener("submit", async (e) => {
    e.preventDefault();
    const nisn = document.getElementById("input-nisn").value.trim();
    const existing = await dbGet("students", nisn);
    const prevImg = document.getElementById("preview-foto-single");
    const fotoData = !prevImg.classList.contains("hidden") ? prevImg.src : existing?.foto || "";

    await dbPut("students", {
      nisn,
      nama: document.getElementById("input-nama").value.trim(),
      kelas: document.getElementById("input-kelas").value.trim(),
      no_wa_ortu: document.getElementById("input-wa").value.trim(),
      ttl: document.getElementById("input-ttl").value.trim(),
      alamat: document.getElementById("input-alamat").value.trim(),
      foto: fotoData,
    });

    document.getElementById("modal-siswa").classList.add("hidden");
    await renderSiswaList();
  });

  document.getElementById("btn-download-template").addEventListener("click", downloadExcelTemplate);
  document.getElementById("input-import-excel").addEventListener("change", (e) => {
    handleImportExcel(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("input-import-zip").addEventListener("change", (e) => {
    handleImportZipPhotos(e.target.files[0]);
    e.target.value = "";
  });
  document.getElementById("search-siswa").addEventListener("input", renderSiswaList);
  document.getElementById("filter-kelas-siswa").addEventListener("change", renderSiswaList);

  // Event Tab Kegiatan
  document.getElementById("form-kegiatan").addEventListener("submit", async (e) => {
    e.preventDefault();
    const idVal = document.getElementById("kegiatan-id").value || `act_${Date.now()}`;
    await dbPut("activities", {
      id: idVal,
      nama: document.getElementById("kegiatan-nama").value.trim(),
      mulai: document.getElementById("kegiatan-mulai").value,
      selesai: document.getElementById("kegiatan-selesai").value,
    });

    document.getElementById("form-kegiatan").reset();
    document.getElementById("kegiatan-id").value = "";
    document.getElementById("form-kegiatan-title").textContent = "Kelola Kegiatan Barcode";
    document.getElementById("btn-reset-kegiatan").classList.add("hidden");
    await renderKegiatanList();
  });

  document.getElementById("btn-reset-kegiatan").addEventListener("click", () => {
    document.getElementById("form-kegiatan").reset();
    document.getElementById("kegiatan-id").value = "";
    document.getElementById("form-kegiatan-title").textContent = "Kelola Kegiatan Barcode";
    document.getElementById("btn-reset-kegiatan").classList.add("hidden");
  });

  // Event Tab Kartu Pelajar PDF
  document.getElementById("print-filter-kelas").addEventListener("change", renderKartuTab);
  document.getElementById("print-search-siswa").addEventListener("input", renderKartuTab);
  document.getElementById("btn-generate-pdf-bulk").addEventListener("click", async () => {
    const students = await dbGetAll("students");
    students.sort((a, b) => a.nama.localeCompare(b.nama));
    const kFilter = document.getElementById("print-filter-kelas").value;
    const q = document.getElementById("print-search-siswa").value.toLowerCase().trim();

    const filtered = students.filter((s) => {
      const matchText =
        s.nama.toLowerCase().includes(q) || String(s.nisn).toLowerCase().includes(q);
      const matchKelas = !kFilter || s.kelas === kFilter;
      return matchText && matchKelas;
    });

    const suffix = kFilter ? kFilter.replace(/\s+/g, "_") : "Semua_Siswa";
    await generatePDFForStudents(filtered, `Kartu_Pelajar_ScanMuh5_${suffix}.pdf`);
  });

  // Event Tab Laporan
  document.getElementById("laporan-siswa-select").addEventListener("change", renderLaporanSiswa);
  document.getElementById("laporan-tgl-mulai").addEventListener("change", renderLaporanSiswa);
  document.getElementById("laporan-tgl-selesai").addEventListener("change", renderLaporanSiswa);
  document.getElementById("btn-share-wa").addEventListener("click", shareLaporanToWhatsApp);
});