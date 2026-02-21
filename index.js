const express = require('express');
const fetch = require('node-fetch');
const multer = require('multer');
const path = require('path');
const config = require('./setting.js');

const app = express();
const PORT = config.PORT || 8080;
const HOST = config.HOST || 'localhost';

// Penyimpanan sementara untuk history upload
const uploads = new Map();

app.use(require('cors')());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Konfigurasi multer (memory storage)
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB per file
}).array('files', 10);

//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📤 FUNGSI GENERATE ID PENDEK
//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function generateShortId(length = 5) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📤 FUNGSI UPLOAD KE GITHUB (dengan nama pendek acak)
//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function uploadToGitHub(file) {
  try {
    const ext = path.extname(file.originalname);
    const shortId = generateShortId(5); // misal "ja7ha"
    const filename = shortId + ext; // "ja7ha.jpm"
    const githubPath = `${config.GITHUB_PATH}/${filename}`;

    const content = file.buffer.toString('base64');

    const response = await fetch(`https://api.github.com/repos/${config.GITHUB_REPO}/contents/${githubPath}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${config.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      },
      body: JSON.stringify({
        message: `Upload file ${filename}`,
        content: content,
        branch: config.GITHUB_BRANCH
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.message || 'Gagal upload ke GitHub');
    }

    // URL yang dikembalikan adalah endpoint proxy
    const fileUrl = `${config.URL}/file/${filename}`;

    return {
      success: true,
      originalName: file.originalname,
      name: filename,
      url: fileUrl,
      size: file.size
    };
  } catch (error) {
    return { success: false, originalName: file.originalname, error: error.message };
  }
}

//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📤 API UPLOAD
//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/upload', (req, res) => {
  uploadMiddleware(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ success: false, message: err.message });
    }

    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ success: false, message: 'Tidak ada file yang dipilih' });
    }

    try {
      const results = [];
      for (const file of files) {
        const result = await uploadToGitHub(file);
        results.push(result);
      }

      // Simpan history upload (opsional)
      const sessionId = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
      if (!uploads.has(sessionId)) uploads.set(sessionId, []);
      uploads.get(sessionId).push(...results.filter(r => r.success));

      // Kirim notifikasi Telegram (opsional)
      if (config.TELEGRAM_TOKEN && config.OWNER_ID) {
        const successCount = results.filter(r => r.success).length;
        const msg = `<b>📤 File diupload</b>\n` +
                    `Jumlah: ${successCount} dari ${files.length}\n` +
                    `IP: ${sessionId}\n` +
                    `Waktu: ${new Date().toLocaleString('id-ID')}`;
        await fetch(`https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: config.OWNER_ID,
            text: msg,
            parse_mode: 'HTML'
          })
        }).catch(() => {});
      }

      res.json({ success: true, results });
    } catch (error) {
      res.status(500).json({ success: false, message: error.message });
    }
  });
});

//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🖼️ ENDPOINT PROXY UNTUK FILE
//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/file/:filename', async (req, res) => {
  const filename = req.params.filename;
  // Validasi filename: hanya huruf kecil, angka, titik, garis bawah, strip
  if (!filename.match(/^[a-z0-9._-]+$/i)) {
    return res.status(400).send('Invalid filename');
  }

  const githubRawUrl = `https://raw.githubusercontent.com/${config.GITHUB_REPO}/${config.GITHUB_BRANCH}/${config.GITHUB_PATH}/${filename}`;

  try {
    const response = await fetch(githubRawUrl);
    if (!response.ok) {
      return res.status(404).send('File not found');
    }

    const buffer = await response.buffer();
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.mp4': 'video/mp4', '.pdf': 'application/pdf',
      '.txt': 'text/plain', '.html': 'text/html', '.css': 'text/css',
      '.js': 'application/javascript', '.json': 'application/json',
      '.zip': 'application/zip', '.rar': 'application/x-rar-compressed',
      '.7z': 'application/x-7z-compressed', '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav', '.webm': 'video/webm', '.webp': 'image/webp',
      '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.jpm': 'application/octet-stream' // contoh
    };
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.set('Content-Type', contentType);
    res.send(buffer);
  } catch (error) {
    res.status(500).send('Error fetching file');
  }
});

//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🗑️ ENDPOINT HISTORY (opsional)
//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/api/history', (req, res) => {
  const sessionId = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const history = uploads.get(sessionId) || [];
  res.json({ success: true, history });
});

//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🎨 ROUTE UTAMA (HTML) - UPLOADER
//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/', (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=0.50, user-scalable=no" />
<title>NovaCat File Uploader</title>
<link rel="icon" href="https://files.catbox.moe/92681q.jpg" type="image/jpeg">
<link rel="apple-touch-icon" href="https://files.catbox.moe/92681q.jpg">
<meta name="google-site-verification" content="sB0bqKK-BcjI8SShBCJWVQptzG3n_SYMBTAgurbRirs" />
<meta property="og:type" content="website">
<meta property="og:url" content="${config.URL}">
<meta property="og:title" content="NovaCat File Uploader">
<meta property="og:description" content="Upload file gratis ke GitHub, dapatkan URL langsung.">
<meta name="twitter:card" content="summary">

<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Orbitron:wght@500;700;900&family=VT323&display=swap" rel="stylesheet">
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
<style>
:root {
  --bg-main: #02040a;
  --bg-card: #0b0f19;
  --primary: #3a6df0;
  --accent-red: #ff3b30;
  --accent-gold: #ffcc00;
  --text-main: #ffffff;
  --text-sub: #8b9bb4;
  --border-color: #1c2538;
}
* { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
body {
  font-family: 'Rajdhani', sans-serif;
  background: var(--bg-main);
  color: var(--text-main);
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow-x: hidden;
  padding-bottom: 80px;
}
::-webkit-scrollbar { width: 0px; }
.custom-header {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 60px;
  background: rgba(2, 4, 10, 0.95);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 20px;
  z-index: 1000;
  border-bottom: 1px solid var(--border-color);
  box-shadow: 0 4px 15px rgba(0,0,0,0.5);
}
.header-left { display: flex; align-items: center; gap: 15px; }
.header-title { font-family: 'Orbitron', sans-serif; font-size: 20px; font-weight: 700; color: #fff; letter-spacing: 1px; }
.page-container { padding: 80px 20px 20px 20px; }
.lux-header-card {
  background: linear-gradient(135deg, #1e3c72, #2a5298);
  border-radius: 20px;
  padding: 25px 20px;
  color: white;
  box-shadow: 0 10px 30px rgba(30,60,114,0.3);
  margin-bottom: 30px;
  border: 1px solid rgba(255,255,255,0.1);
}
.lux-icon-box { width: 50px; height: 50px; background: rgba(255,255,255,0.2); border-radius: 12px; display: flex; justify-content: center; align-items: center; font-size: 24px; backdrop-filter: blur(5px); }
.lux-head-text h2 { font-family: 'Orbitron'; font-size: 18px; margin-bottom: 2px; letter-spacing: 1px; }
.lux-head-text p { font-size: 12px; color: rgba(255,255,255,0.8); }
.lux-section-title { font-family: 'Orbitron'; font-size: 16px; color: #fff; margin-bottom: 15px; letter-spacing: 1px; padding-left: 5px; border-left: 3px solid var(--primary); line-height: 1; }
.slider-container {
  width: 100%;
  background: var(--bg-card);
  border-radius: 20px;
  overflow: hidden;
  border: 1px solid var(--border-color);
  box-shadow: 0 5px 20px rgba(0,0,0,0.3);
  margin-bottom: 30px;
  position: relative;
  height: 200px;
  touch-action: pan-y;
  cursor: grab;
  user-select: none;
}
.slider-container:active { cursor: grabbing; }
.slider-track {
  display: flex;
  width: 200%;
  height: 100%;
  transition: transform 0.4s ease-out;
}
.slide { width: 50%; height: 100%; position: relative; flex-shrink: 0; }
.slide video { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
.lux-news-content {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 100%;
  padding: 20px;
  background: linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.6) 50%, transparent 100%);
  z-index: 5;
}
.lux-news-content h3 { font-family: 'Orbitron'; font-size: 16px; color: #fff; margin-bottom: 5px; text-shadow: 0 2px 4px rgba(0,0,0,0.8); }
.lux-news-content p { font-size: 12px; color: #d0d0d0; text-shadow: 0 1px 2px rgba(0,0,0,0.8); }

/* UPLOAD CARD */
.upload-card {
  background: var(--bg-card);
  border-radius: 20px;
  padding: 30px 20px;
  border: 2px solid var(--border-color);
  margin-bottom: 30px;
  text-align: center;
}
.drop-area {
  border: 2px dashed var(--primary);
  border-radius: 15px;
  padding: 40px 20px;
  margin: 20px 0;
  cursor: pointer;
  transition: all 0.3s;
  background: rgba(58, 109, 240, 0.05);
}
.drop-area:hover { border-color: var(--accent-gold); background: rgba(255,204,0,0.05); }
.drop-area i { font-size: 48px; color: var(--primary); margin-bottom: 15px; }
.file-list { margin: 20px 0; text-align: left; }
.file-item {
  background: rgba(255,255,255,0.05);
  padding: 10px 15px;
  border-radius: 8px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.file-item i { color: var(--primary); }
.file-name { flex: 1; word-break: break-all; }
.file-size { color: var(--text-sub); font-size: 12px; }
.upload-btn {
  background: linear-gradient(90deg, #1e3c72, #2a5298);
  border: none;
  border-radius: 50px;
  color: white;
  font-family: 'Orbitron';
  font-size: 18px;
  font-weight: bold;
  padding: 16px 30px;
  cursor: pointer;
  box-shadow: 0 0 20px rgba(58,109,240,0.3);
  transition: 0.2s;
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.upload-btn:active { transform: scale(0.98); }
.upload-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.result-area {
  background: rgba(0,0,0,0.3);
  border-radius: 15px;
  padding: 20px;
  margin-top: 20px;
  max-height: 300px;
  overflow-y: auto;
  text-align: left;
}
.result-item {
  background: var(--bg-card);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 10px;
}
.result-item a {
  color: var(--primary);
  text-decoration: none;
  word-break: break-all;
  display: block;
  margin-top: 5px;
  font-size: 14px;
}
.result-item .copy-btn {
  background: transparent;
  border: 1px solid var(--primary);
  color: var(--primary);
  padding: 4px 10px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
  margin-left: 10px;
}
.footer {
  text-align: center;
  padding: 20px;
  margin-top: 30px;
  border-top: 1px solid var(--border-color);
  color: var(--text-sub);
  font-size: 12px;
}
</style>
</head>
<body>
<div class="custom-header">
  <div class="header-left">
    <div class="header-title">NOVACAT UPLOADER</div>
  </div>
  <div style="color: var(--text-sub); font-size: 12px;"><i class="fas fa-cloud-upload-alt"></i> GitHub Storage</div>
</div>

<div class="page-container">
  <div class="lux-header-card">
    <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 15px;">
      <div class="lux-icon-box"><i class="fas fa-cloud-upload-alt"></i></div>
      <div class="lux-head-text">
        <p>Welcome to</p>
        <h2>NovaCat File Uploader</h2>
      </div>
    </div>
    <div style="font-size: 14px; opacity: 0.9;">
      Upload file ke GitHub dengan mudah, dapatkan URL langsung. Gratis!
    </div>
  </div>

  <div class="lux-section-title">Latest News</div>
  <div class="slider-container" id="newsSlider">
    <div class="slider-track">
      <div class="slide">
        <video src="https://files.catbox.moe/7iyjd5.mp4" autoplay muted loop playsinline></video>
        <div class="lux-news-content">
          <h3>NovaCat Uploader v${config.VERSI_WEB || '1.0'}</h3>
          <p>Upload file langsung ke GitHub, simpan selamanya!</p>
        </div>
      </div>
      <div class="slide">
        <video src="https://files.catbox.moe/sbwa8f.mp4" autoplay muted loop playsinline></video>
        <div class="lux-news-content">
          <h3>Mudah & Cepat</h3>
          <p>Upload multiple file, dapatkan link dalam detik</p>
        </div>
      </div>
    </div>
  </div>

  <div class="lux-section-title">Upload Files</div>
  <div class="upload-card">
    <div class="drop-area" id="dropArea" onclick="document.getElementById('fileInput').click()">
      <i class="fas fa-cloud-upload-alt"></i>
      <h3>Drag & drop file atau klik di sini</h3>
      <p style="color: var(--text-sub); margin-top: 10px;">Maks 10 file, masing-masing max 50MB</p>
    </div>
    <input type="file" id="fileInput" multiple style="display: none;" accept="*/*">
    
    <div id="fileList" class="file-list"></div>
    
    <button class="upload-btn" id="uploadBtn" onclick="uploadFiles()">
      <i class="fas fa-upload"></i> Upload Sekarang
    </button>

    <div id="resultArea" class="result-area" style="display: none;">
      <h4><i class="fas fa-link"></i> Hasil Upload:</h4>
      <div id="resultList"></div>
    </div>
  </div>

  <div class="footer">
    <p>© 2026 NovaCat - All rights reserved</p>
    <p style="margin-top: 10px;">
      <i class="fab fa-telegram"></i> ${config.DEVELOPER || '@Novabot403'} • 
      <i class="fas fa-code"></i> Version ${config.VERSI_WEB || '1.0'}
    </p>
  </div>
</div>

<script>
// ==================== SLIDER ====================
let currentSlide = 0;
let slideInterval;
const sliderContainer = document.getElementById('newsSlider');
const sliderTrack = document.querySelector('.slider-track');
function startSlider() { clearInterval(slideInterval); slideInterval = setInterval(nextSlide, 5000); }
function nextSlide() { currentSlide = (currentSlide + 1) % 2; updateSlider(); }
function previousSlide() { currentSlide = (currentSlide - 1 + 2) % 2; updateSlider(); }
function updateSlider() { if (sliderTrack) sliderTrack.style.transform = \`translateX(-\${currentSlide * 50}%)\`; }
function setupSlider() {
  if (!sliderContainer || !sliderTrack) return;
  let isSwiping = false, startX = 0, currentX = 0;
  function getPositionX(e) { return e.type.includes('mouse') ? e.pageX : e.touches[0].clientX; }
  sliderContainer.addEventListener('touchstart', (e) => { startX = getPositionX(e); isSwiping = true; clearInterval(slideInterval); });
  sliderContainer.addEventListener('touchmove', (e) => { if (!isSwiping) return; currentX = getPositionX(e); const diff = currentX - startX; if (Math.abs(diff) > 20) sliderTrack.style.transform = \`translateX(-\${currentSlide * 50 + (diff / sliderContainer.offsetWidth) * 50}%)\`; });
  sliderContainer.addEventListener('touchend', () => { if (!isSwiping) return; isSwiping = false; const diff = currentX - startX; if (Math.abs(diff) > 80) diff > 0 ? previousSlide() : nextSlide(); else updateSlider(); startSlider(); });
  sliderContainer.addEventListener('mousedown', (e) => { e.preventDefault(); startX = getPositionX(e); isSwiping = true; clearInterval(slideInterval); sliderContainer.style.cursor = 'grabbing'; });
  sliderContainer.addEventListener('mousemove', (e) => { if (!isSwiping) return; e.preventDefault(); currentX = getPositionX(e); const diff = currentX - startX; if (Math.abs(diff) > 20) sliderTrack.style.transform = \`translateX(-\${currentSlide * 50 + (diff / sliderContainer.offsetWidth) * 50}%)\`; });
  sliderContainer.addEventListener('mouseup', () => { if (!isSwiping) return; isSwiping = false; sliderContainer.style.cursor = 'grab'; const diff = currentX - startX; if (Math.abs(diff) > 80) diff > 0 ? previousSlide() : nextSlide(); else updateSlider(); startSlider(); });
  sliderContainer.addEventListener('mouseleave', () => { if (isSwiping) { isSwiping = false; sliderContainer.style.cursor = 'grab'; updateSlider(); startSlider(); } });
}

// ==================== UPLOAD HANDLER ====================
const fileInput = document.getElementById('fileInput');
const fileListDiv = document.getElementById('fileList');
const uploadBtn = document.getElementById('uploadBtn');
const resultArea = document.getElementById('resultArea');
const resultList = document.getElementById('resultList');

let selectedFiles = [];

fileInput.addEventListener('change', updateFileList);
document.getElementById('dropArea').addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
document.getElementById('dropArea').addEventListener('drop', (e) => {
  e.preventDefault();
  const files = e.dataTransfer.files;
  if (files.length) {
    selectedFiles = Array.from(files);
    updateFileListDisplay();
    // Update fileInput secara tidak langsung (tidak bisa set files, tapi kita pakai selectedFiles saja)
  }
});

function updateFileList() {
  selectedFiles = Array.from(fileInput.files);
  updateFileListDisplay();
}

function updateFileListDisplay() {
  if (selectedFiles.length === 0) {
    fileListDiv.innerHTML = '';
    return;
  }
  let html = '<h4>File dipilih:</h4>';
  selectedFiles.forEach((file, idx) => {
    const size = (file.size / 1024).toFixed(2) + ' KB';
    html += \`<div class="file-item"><i class="fas fa-file"></i><span class="file-name">\${file.name}</span><span class="file-size">\${size}</span></div>\`;
  });
  fileListDiv.innerHTML = html;
}

async function uploadFiles() {
  if (selectedFiles.length === 0) {
    alert('Pilih file terlebih dahulu!');
    return;
  }

  uploadBtn.disabled = true;
  uploadBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Mengupload...';
  resultArea.style.display = 'none';
  resultList.innerHTML = '';

  const formData = new FormData();
  selectedFiles.forEach(file => formData.append('files', file));

  try {
    const response = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await response.json();
    if (data.success) {
      let html = '';
      data.results.forEach((item, idx) => {
        if (item.success) {
          html += \`
            <div class="result-item">
              <i class="fas fa-check-circle" style="color: #00ff88;"></i> <strong>\${item.originalName}</strong>
              <a href="\${item.url}" target="_blank">\${item.url}</a>
              <button class="copy-btn" onclick="copyText('\${item.url}')">Salin Link</button>
            </div>
          \`;
        } else {
          html += \`<div class="result-item" style="color: var(--accent-red);">❌ \${item.originalName}: \${item.error}</div>\`;
        }
      });
      resultList.innerHTML = html;
      resultArea.style.display = 'block';
    } else {
      alert('Gagal upload: ' + data.message);
    }
  } catch (err) {
    alert('Terjadi kesalahan: ' + err.message);
  } finally {
    uploadBtn.disabled = false;
    uploadBtn.innerHTML = '<i class="fas fa-upload"></i> Upload Sekarang';
  }
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => alert('Link disalin!'));
}

// ==================== INIT ====================
document.addEventListener('DOMContentLoaded', () => {
  setupSlider();
  startSlider();
  const videos = document.querySelectorAll('video');
  videos.forEach(v => v.play().catch(() => {}));
});
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I') || (e.ctrlKey && e.key === 'U')) e.preventDefault();
});
</script>
</body>
</html>
  `;
  res.send(html);
});

//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🚀 START SERVER
//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.listen(PORT, HOST, () => {
  console.log(`
\x1b[1m\x1b[34m╔═╗╦ ╦╦═╗╦ ╦╔╦╗╔═╗╔═╗╦  \x1b[0m
\x1b[1m\x1b[34m╠═╝╚╦╝╠╦╝║ ║ ║ ║╣ ╠═╝║  \x1b[0m
\x1b[1m\x1b[34m╩   ╩ ╩╚═╚═╝ ╩ ╚═╝╩  ╩═╝\x1b[0m
\x1b[1m\x1b[33mN O V A C A T   U P L O A D E R   v${config.VERSI_WEB || '1.0'}\x1b[0m
\x1b[1m\x1b[32m═══════════════════════════════════════\x1b[0m
🌐 Server: http://${HOST}:${PORT}
👤 Developer: ${config.DEVELOPER || '@Novabot403'}
📦 Version: ${config.VERSI_WEB || '1.0'}
✅ Uploader ready!
  `);
});