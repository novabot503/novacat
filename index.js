const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require("path");
const config = require('./setting.js');
const app = express();
const PORT = config.PORT || 8080;
const HOST = config.HOST || 'localhost';
const orders = new Map();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📦 PAKASIR PAYMENT FUNCTIONS
//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function createQRISPayment(orderId, amount) {
try {
const response = await fetch('https://app.pakasir.com/api/transactioncreate/qris', {
method: 'POST',
headers: { 
'Content-Type': 'application/json',
'Accept': 'application/json'
},
body: JSON.stringify({
project: config.PAKASIR_PROJECT,
api_key: config.PAKASIR_API_KEY,
order_id: orderId,
amount: amount
})
});
const data = await response.json();
if (!data.success && !data.payment) {
return null;
}
const payment = data.payment || data;
// Ambil expiry time dari response (mungkin dari payment.expired_at atau data.expired_at)
let expiryTime = null;
if (payment.expired_at) {
expiryTime = payment.expired_at;
} else if (data.expired_at) {
expiryTime = data.expired_at;
} else {
// Default 30 DETIK dari sekarang (sesuai permintaan)
expiryTime = new Date(Date.now() + 30 * 1000).toISOString();
}
return {
success: true,
payment_number: payment.payment_number || payment.code || '',
qris_string: payment.payment_number || payment.qris_string || '',
expiry_time: expiryTime,
raw: data
};
} catch (error) {
return null;
}
}
async function checkPaymentStatus(orderId) {
try {
const detailUrl = `https://app.pakasir.com/api/transactiondetail?project=${encodeURIComponent(config.PAKASIR_PROJECT)}&amount=0&order_id=${encodeURIComponent(orderId)}&api_key=${encodeURIComponent(config.PAKASIR_API_KEY)}`;
const response = await fetch(detailUrl);
const data = await response.json();
const transaction = data.transaction || data || {};
let status = transaction.status || '';
if (typeof status === 'string') {
status = status.toLowerCase();
if (status === 'success' || status === 'settled') status = 'paid';
if (status === 'expired' || status === 'cancel' || status === 'failed') status = 'expired';
}
return {
success: true,
status: status,
transaction: transaction,
raw: data
};
} catch (error) {
return null;
}
}
async function processPayment(orderId, amount) {
try {
const qrData = await createQRISPayment(orderId, amount);
if (!qrData) {
throw new Error('Gagal membuat pembayaran QRIS');
}
return qrData;
} catch (error) {
throw error;
}
}

//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🎯 HELPER FUNCTIONS
//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function generateRandomPassword(length = 8) {
const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
let password = '';
for (let i = 0; i < length; i++) {
password += chars.charAt(Math.floor(Math.random() * chars.length));
}
return password;
}
function capitalize(string) {
return string.charAt(0).toUpperCase() + string.slice(1).toLowerCase();
}
function generateOrderId() {
return `ORDER_${Date.now()}_${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
}
function escapeHTML(text) {
if (!text) return '';
return text.toString()
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#039;');
}

//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 👤 CREATE OR GET PTERODACTYL USER
//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function createOrGetPterodactylUser(email) {
try {
const search = await fetch(`${config.DOMAIN}/api/application/users?filter[email]=${encodeURIComponent(email)}`, {
method: 'GET',
headers: {
'Authorization': `Bearer ${config.PLTA}`,
'Accept': 'application/json'
}
});
const searchData = await search.json();
let userId, password, isNew;
if (searchData.data && searchData.data.length > 0) {
const existing = searchData.data[0].attributes;
password = generateRandomPassword(12);
const update = await fetch(`${config.DOMAIN}/api/application/users/${existing.id}`, {
method: 'PATCH',
headers: {
'Authorization': `Bearer ${config.PLTA}`,
'Content-Type': 'application/json',
'Accept': 'application/json'
},
body: JSON.stringify({ password: password })
});
const updateData = await update.json();
if (updateData.errors) throw new Error(updateData.errors[0].detail);
userId = existing.id;
isNew = false;
} else {
const username = email.split('@')[0];
password = generateRandomPassword(12);
const create = await fetch(`${config.DOMAIN}/api/application/users`, {
method: 'POST',
headers: {
'Authorization': `Bearer ${config.PLTA}`,
'Content-Type': 'application/json',
'Accept': 'application/json'
},
body: JSON.stringify({
username: username,
email: email,
first_name: username,
last_name: 'User',
password: password
})
});
const createData = await create.json();
if (createData.errors) throw new Error(createData.errors[0].detail);
userId = createData.attributes.id;
isNew = true;
}
return { userId, password, isNew };
} catch (error) {
throw error;
}
}

//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🖥️ CREATE PTERODACTYL SERVER (MODIFIED)
//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function createPterodactylServer(email, panelType, serverName = null) {
try {
const userInfo = await createOrGetPterodactylUser(email);
const userId = userInfo.userId;
const password = userInfo.password;
let ram, disk, cpu;
if (panelType === 'unli' || panelType === 'unlimited') {
ram = 0;
disk = 0;
cpu = 0;
} else {
switch (panelType) {
case '1gb': ram = 1024; disk = 1024; cpu = 40; break;
case '2gb': ram = 2048; disk = 2048; cpu = 60; break;
case '3gb': ram = 3072; disk = 3072; cpu = 80; break;
case '4gb': ram = 4096; disk = 4096; cpu = 100; break;
case '5gb': ram = 5120; disk = 5120; cpu = 120; break;
case '6gb': ram = 6144; disk = 6144; cpu = 140; break;
case '7gb': ram = 7168; disk = 7168; cpu = 160; break;
case '8gb': ram = 8192; disk = 8192; cpu = 180; break;
case '9gb': ram = 9216; disk = 9216; cpu = 200; break;
case '10gb': ram = 10240; disk = 10240; cpu = 220; break;
default: ram = 1024; disk = 1024; cpu = 40;
}
}
const serverCount = 1;
const safeServerName = serverName || 
(panelType === 'unli' || panelType === 'unlimited' 
? `${capitalize(email.split('@')[0])} UNLI Server #${serverCount}`
: `${capitalize(email.split('@')[0])} ${panelType.toUpperCase()} Server #${serverCount}`);
const serverResponse = await fetch(`${config.DOMAIN}/api/application/servers`, {
method: 'POST',
headers: {
'Accept': 'application/json',
'Content-Type': 'application/json',
'Authorization': `Bearer ${config.PLTA}`
},
body: JSON.stringify({
name: safeServerName,
description: '',
user: userId,
egg: parseInt(config.EGG),
docker_image: 'ghcr.io/parkervcp/yolks:nodejs_20',
startup: 'npm install && npm start',
environment: {
INST: 'npm',
USER_UPLOAD: '0',
AUTO_UPDATE: '0',
CMD_RUN: 'npm start'
},
limits: {
memory: parseInt(ram),
swap: 0,
disk: parseInt(disk),
io: 500,
cpu: parseInt(cpu)
},
feature_limits: {
databases: 5,
backups: 5,
allocations: 1
},
deploy: {
locations: [parseInt(config.LOX)],
dedicated_ip: false,
port_range: []
}
})
});
const serverData = await serverResponse.json();
if (serverData.errors) {
throw new Error(serverData.errors[0].detail || 'Gagal membuat server');
}
return {
success: true,
serverId: serverData.attributes.id,
identifier: serverData.attributes.identifier,
name: safeServerName,
panelType: panelType,
ram: ram,
disk: disk,
cpu: cpu,
createdAt: new Date().toISOString(),
panelUrl: `${config.URL}/server/${serverData.attributes.identifier}`,
username: email,
password: password,
isNewUser: userInfo.isNew
};
} catch (error) {
throw error;
}
}

//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 📊 ROUTES API
//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/create-order', (req, res) => {
// Ambil IP user untuk identifikasi (opsional)
const userIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
// Lanjutkan seperti biasa
(async () => {
try {
const { email, panel_type } = req.body;
if (!email || !panel_type) {
return res.status(400).json({ 
success: false, 
message: 'Email dan tipe panel harus diisi' 
});
}
const priceMap = {
'1gb': config.PRICE_1GB || 500,
'2gb': config.PRICE_2GB || 500,
'3gb': config.PRICE_3GB || 500,
'4gb': config.PRICE_4GB || 500,
'5gb': config.PRICE_5GB || 500,
'6gb': config.PRICE_6GB || 500,
'7gb': config.PRICE_7GB || 500,
'8gb': config.PRICE_8GB || 500,
'9gb': config.PRICE_9GB || 500,
'10gb': config.PRICE_10GB || 500,
'unli': config.PRICE_UNLI || 500
};
const amount = priceMap[panel_type] || 500;
if (amount <= 0) {
return res.status(400).json({ 
success: false, 
message: 'Harga tidak valid' 
});
}
const orderId = generateOrderId();
const payment = await processPayment(orderId, amount);
if (!payment) {
return res.status(500).json({ 
success: false, 
message: 'Gagal membuat pembayaran' 
});
}
const order = {
order_id: orderId,
email: email,
panel_type: panel_type,
amount: amount,
payment_number: payment.payment_number,
qris_string: payment.qris_string,
expiry_time: payment.expiry_time, // simpan expiry time
status: 'pending',
created_at: new Date().toISOString(),
panel_created: false,
user_ip: userIp // simpan IP untuk referensi
};
orders.set(orderId, order);
const qrUrl = `https://quickchart.io/qr?text=${encodeURIComponent(payment.qris_string)}&size=300&margin=1`;
res.json({
success: true,
order: order,
qr_url: qrUrl,
payment_info: payment
});
} catch (error) {
res.status(500).json({ 
success: false, 
message: 'Internal server error' 
});
}
})();
});

app.get('/api/check-payment/:orderId', async (req, res) => {
try {
const { orderId } = req.params;
const paymentStatus = await checkPaymentStatus(orderId);
if (!paymentStatus) {
return res.status(500).json({ 
success: false, 
message: 'Gagal memeriksa status pembayaran' 
});
}
const order = orders.get(orderId);
if (order) {
order.status = paymentStatus.status;
orders.set(orderId, order);
}
// Kirim juga expiry_time jika ada
res.json({
success: true,
status: paymentStatus.status,
order_id: orderId,
transaction: paymentStatus.transaction,
expiry_time: order ? order.expiry_time : null
});
} catch (error) {
res.status(500).json({ 
success: false, 
message: 'Internal server error' 
});
}
});

app.post('/api/create-panel', async (req, res) => {
try {
const { order_id, email, panel_type } = req.body;
if (!order_id) {
return res.status(400).json({ 
success: false, 
message: 'Order ID diperlukan' 
});
}
const order = orders.get(order_id);
if (!order) {
return res.status(404).json({ 
success: false, 
message: 'Order tidak ditemukan' 
});
}
// Status yang dianggap sukses
const paidStatuses = ['paid', 'success', 'settled'];
if (!paidStatuses.includes(order.status)) {
return res.status(400).json({ 
success: false, 
message: 'Pembayaran belum berhasil. Status: ' + order.status 
});
}
if (order.panel_created) {
return res.status(400).json({ 
success: false, 
message: 'Panel sudah dibuat sebelumnya' 
});
}
const panelResult = await createPterodactylServer(email || order.email, panel_type || order.panel_type);
if (!panelResult.success) {
return res.status(500).json({ 
success: false, 
message: 'Gagal membuat panel' 
});
}
order.panel_created = true;
order.panel_data = panelResult;
orders.set(order_id, order);
// Notifikasi ke owner (tetap)
const ownerMsg = `<blockquote>✅ PANEL BARU DIBUAT</blockquote>\n\n` +
`<b>📅 Waktu:</b> ${new Date().toLocaleString('id-ID')}\n` +
`<b>📧 Email:</b> ${escapeHTML(order.email)}\n` +
`<b>📦 Tipe Panel:</b> ${order.panel_type.toUpperCase()}\n` +
`<b>💰 Harga:</b> Rp ${order.amount.toLocaleString('id-ID')}\n` +
`<b>🆔 Server ID:</b> <code>${panelResult.serverId}</code>\n` +
`<b>🏷️ Nama Server:</b> ${escapeHTML(panelResult.name)}\n` +
`<b>💾 RAM:</b> ${panelResult.ram === 0 ? 'Unlimited' : panelResult.ram + 'MB'}\n` +
`<b>💿 Disk:</b> ${panelResult.disk === 0 ? 'Unlimited' : panelResult.disk + 'MB'}\n` +
`<b>⚡ CPU:</b> ${panelResult.cpu === 0 ? 'Unlimited' : panelResult.cpu + '%'}`;
const ownerKeyboard = {
inline_keyboard: [
[
{ 
text: '🛒 Beli Panel', 
url: config.URL
}
]
]
};
try {
const url = `https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`;
const response = await fetch(url, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
chat_id: config.OWNER_ID,
text: ownerMsg,
parse_mode: 'HTML',
reply_markup: ownerKeyboard
})
});
const result = await response.json();
if (!result.ok) {
}
} catch (telegramError) {
}
res.json({
success: true,
panel: panelResult,
message: 'Panel berhasil dibuat!'
});
} catch (error) {
res.status(500).json({ 
success: false, 
message: error.message || 'Internal server error' 
});
}
});

//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔔 WEBHOOK UNTUK PAKASIR
//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.post('/api/webhook/pakasir', async (req, res) => {
try {
const data = req.body;
console.log('Webhook received:', JSON.stringify(data, null, 2));

// Verifikasi token jika diperlukan (misal dengan query parameter ?token=xxx)
const token = req.query.token;
if (config.WEBHOOK_TOKEN && token !== config.WEBHOOK_TOKEN) {
return res.status(401).json({ success: false, message: 'Unauthorized' });
}

// Ambil order_id dari data yang dikirim
const orderId = data.order_id || data.orderId;
if (!orderId) {
return res.status(400).json({ success: false, message: 'No order_id' });
}

// Cari order
const order = orders.get(orderId);
// Jika order tidak ditemukan, kita tetap respon 200 agar Pakasir tidak mengulang
if (!order) {
console.log(`Order ${orderId} not found in this instance, but webhook received`);
return res.json({ success: true, message: 'Webhook received but order not in this instance' });
}

// Tentukan status dari data
let status = data.status || data.transaction_status || '';
if (typeof status === 'string') {
status = status.toLowerCase();
if (status === 'success' || status === 'settled') status = 'paid';
}

// Update status order
order.status = status;
orders.set(orderId, order);

// Jika status paid dan panel belum dibuat, buat panel
if (status === 'paid' && !order.panel_created) {
console.log(`Payment received for order ${orderId}, creating panel...`);
try {
const panelResult = await createPterodactylServer(order.email, order.panel_type);
if (panelResult.success) {
order.panel_created = true;
order.panel_data = panelResult;
orders.set(orderId, order);

// Kirim notifikasi ke owner
const ownerMsg = `<blockquote>✅ PANEL BARU DIBUAT VIA WEBHOOK</blockquote>\n\n` +
`<b>📅 Waktu:</b> ${new Date().toLocaleString('id-ID')}\n` +
`<b>📧 Email:</b> ${escapeHTML(order.email)}\n` +
`<b>📦 Tipe Panel:</b> ${order.panel_type.toUpperCase()}\n` +
`<b>💰 Harga:</b> Rp ${order.amount.toLocaleString('id-ID')}\n` +
`<b>🆔 Server ID:</b> <code>${panelResult.serverId}</code>\n` +
`<b>🏷️ Nama Server:</b> ${escapeHTML(panelResult.name)}\n` +
`<b>💾 RAM:</b> ${panelResult.ram === 0 ? 'Unlimited' : panelResult.ram + 'MB'}\n` +
`<b>💿 Disk:</b> ${panelResult.disk === 0 ? 'Unlimited' : panelResult.disk + 'MB'}\n` +
`<b>⚡ CPU:</b> ${panelResult.cpu === 0 ? 'Unlimited' : panelResult.cpu + '%'}`;

try {
const url = `https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`;
await fetch(url, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({
chat_id: config.OWNER_ID,
text: ownerMsg,
parse_mode: 'HTML',
reply_markup: { inline_keyboard: [[{ text: '🛒 Beli Panel', url: config.URL }]] }
})
});
} catch (telegramError) {
// ignore
}

return res.json({ success: true, message: 'Panel created via webhook' });
} else {
// Gagal membuat panel, tetap respon sukses agar Pakasir tidak mengulang
console.error(`Failed to create panel for order ${orderId}`);
return res.json({ success: true, message: 'Payment received but panel creation failed' });
}
} catch (panelError) {
console.error(`Panel creation error for order ${orderId}:`, panelError);
return res.json({ success: true, message: 'Payment received but panel creation error' });
}
}

// Jika bukan paid atau panel sudah ada
res.json({ success: true, message: 'Webhook processed' });
} catch (error) {
console.error('Webhook error:', error);
res.status(500).json({ success: false, message: 'Internal server error' });
}
});

//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🎨 ROUTE UTAMA (HTML) - DENGAN SLIDER 2 VIDEO + PERMISSION BANNER
//━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
app.get('/', (req, res) => {
// Definisikan harga dengan aman
const safePrice = (val) => val || 500;
const html = `
<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=0.50, user-scalable=no" />
<title>Novabot Panel Store</title>

<!-- Favicon -->
<link rel="icon" href="https://files.catbox.moe/92681q.jpg" type="image/jpeg">
<link rel="apple-touch-icon" href="https://files.catbox.moe/92681q.jpg">

<!-- Google Site Verification -->
<meta name="google-site-verification" content="sB0bqKK-BcjI8SShBCJWVQptzG3n_SYMBTAgurbRirs" />

<!-- Meta tag untuk semua platform (WhatsApp, Telegram, Facebook, Twitter) - hanya teks, tanpa gambar -->
<meta property="og:type" content="website">
<meta property="og:url" content="https://novabot-store.vercel.app">
<meta property="og:title" content="Novabot Panel Store">
<meta property="og:description" content="Jual panel Pterodactyl terbaik dengan harga terjangkau. Pembayaran via QRIS.">
<meta name="twitter:card" content="summary">

<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Orbitron:wght@500;700;900&family=VT323&display=swap" rel="stylesheet">
<link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
<style>

/* ========================================= */
/* 1. RESET & GLOBAL STYLES */
/* ========================================= */
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
* { 
box-sizing: border-box; 
margin: 0; 
padding: 0; 
-webkit-tap-highlight-color: transparent; 
outline: none;
}
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

/* ========================================= */
/* 2. HEADER */
/* ========================================= */
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

        .header-left { 
            display: flex; 
            align-items: center; 
            gap: 15px; 
        }

        .header-title { 
            font-family: 'Orbitron', sans-serif; 
            font-size: 20px; 
            font-weight: 700; 
            color: #fff; 
            letter-spacing: 1px; 
        }

        /* ========================================= */
        /* 3. DASHBOARD COMPONENTS */
        /* ========================================= */
        .page-container { 
            padding: 80px 20px 20px 20px; 
        }

        .lux-header-card {
            background: linear-gradient(135deg, #1e3c72, #2a5298); 
            border-radius: 20px; 
            padding: 25px 20px; 
            color: white;
            box-shadow: 0 10px 30px rgba(30, 60, 114, 0.3);
            margin-bottom: 30px; 
            position: relative; 
            overflow: hidden;
            border: 1px solid rgba(255,255,255,0.1);
        }

        .lux-icon-box { 
            width: 50px; 
            height: 50px; 
            background: rgba(255,255,255,0.2); 
            border-radius: 12px; 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            font-size: 24px; 
            backdrop-filter: blur(5px); 
        }

        .lux-head-text h2 { 
            font-family: 'Orbitron'; 
            font-size: 18px; 
            margin-bottom: 2px; 
            letter-spacing: 1px; 
        }

        .lux-head-text p { 
            font-size: 12px; 
            color: rgba(255,255,255,0.8); 
            font-family: 'Rajdhani'; 
        }

        .lux-section-title { 
            font-family: 'Orbitron'; 
            font-size: 16px; 
            color: #fff; 
            margin-bottom: 15px; 
            letter-spacing: 1px; 
            padding-left: 5px; 
            border-left: 3px solid var(--primary); 
            line-height: 1; 
        }

        /* SLIDER UTAMA - 2 VIDEO */
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

        .slider-container:active {
            cursor: grabbing;
        }

        .slider-track {
            display: flex;
            width: 200%; /* 2 video = 200% */
            height: 100%;
            transition: transform 0.4s ease-out;
        }

        .slide { 
            width: 50%; /* Masing-masing video 50% dari track */
            height: 100%; 
            position: relative; 
            flex-shrink: 0;
        }

        .slide video { 
            width: 100%; 
            height: 100%; 
            object-fit: cover; 
            display: block; 
            pointer-events: none; 
        }

        .lux-news-content { 
            position: absolute; 
            bottom: 0; 
            left: 0; 
            width: 100%; 
            padding: 20px; 
            display: flex; 
            flex-direction: column; 
            justify-content: flex-end;
            background: linear-gradient(to top, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.6) 50%, transparent 100%);
            z-index: 5;
        }

        .lux-news-content h3 { 
            font-family: 'Orbitron'; 
            font-size: 16px; 
            color: #fff; 
            margin-bottom: 5px; 
            text-shadow: 0 2px 4px rgba(0,0,0,0.8); 
        }

        .lux-news-content p { 
            font-size: 12px; 
            color: #d0d0d0; 
            text-shadow: 0 1px 2px rgba(0,0,0,0.8); 
        }

        /* PRICING GRID */
        .pricing-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
            gap: 15px;
            margin-bottom: 30px;
        }

        .price-card {
            background: var(--bg-card);
            border-radius: 15px;
            padding: 20px;
            text-align: center;
            border: 2px solid var(--border-color);
            transition: all 0.3s ease;
            position: relative;
            overflow: hidden;
        }

        .price-card:hover {
            border-color: var(--primary);
            transform: translateY(-5px);
            box-shadow: 0 10px 25px rgba(58, 109, 240, 0.2);
        }

        .panel-type {
            font-family: 'Orbitron';
            font-size: 1.5rem;
            color: var(--primary);
            margin-bottom: 10px;
            text-transform: uppercase;
        }

        .panel-specs {
            font-size: 0.9rem;
            color: var(--text-sub);
            margin-bottom: 15px;
            line-height: 1.4;
        }

        .price {
            font-size: 2rem;
            font-weight: bold;
            color: var(--accent-gold);
            margin: 15px 0;
        }

        .yoshi-btn { 
            width: 100%; 
            padding: 16px; 
            margin-top: 10px; 
            background: linear-gradient(90deg, #1e3c72, #2a5298); 
            border: none; 
            border-radius: 50px; 
            color: #fff; 
            font-family: 'Orbitron'; 
            font-size: 16px; 
            font-weight: bold; 
            cursor: pointer; 
            box-shadow: 0 0 20px rgba(58, 109, 240, 0.3); 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            gap: 10px; 
            transition: 0.2s; 
        }

        .yoshi-btn:active { 
            transform: scale(0.98); 
        }

        .yoshi-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        /* MODAL STYLES */
        .modal, .email-modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.9);
            z-index: 2000;
            align-items: center;
            justify-content: center;
        }

        .modal-content, .email-modal-content {
            background: var(--bg-card);
            padding: 30px;
            border-radius: 20px;
            max-width: 400px;
            width: 90%;
            text-align: center;
            border: 2px solid var(--primary);
            box-shadow: 0 0 30px rgba(58, 109, 240, 0.2);
            position: relative;
            overflow: hidden;
        }

        .email-modal-bg {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            opacity: 0.1;
            z-index: -1;
        }

        .email-modal-bg video {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }

        .modal h2, .email-modal h2 {
            font-family: 'Orbitron';
            color: var(--primary);
            margin-bottom: 20px;
            font-size: 1.5rem;
        }

        .qr-container {
            margin: 20px 0;
            padding: 15px;
            background: white;
            border-radius: 10px;
            display: inline-block;
        }

        .qr-container img {
            width: 250px;
            height: 250px;
            display: block;
        }

        .payment-info {
            background: rgba(255,255,255,0.1);
            padding: 15px;
            border-radius: 10px;
            margin: 15px 0;
            font-family: monospace;
            word-break: break-all;
            font-size: 12px;
            color: #fff;
        }

        .status-message {
            margin: 15px 0;
            padding: 10px;
            border-radius: 8px;
            background: rgba(255,255,255,0.1);
            font-size: 14px;
            color: var(--text-sub);
        }

        .status-message.success {
            background: rgba(0, 255, 136, 0.1);
            color: #00ff88;
            border: 1px solid #00ff88;
        }

        .status-message.error {
            background: rgba(255, 59, 48, 0.1);
            color: #ff3b30;
            border: 1px solid #ff3b30;
        }

        .status-message.pending {
            background: rgba(255, 204, 0, 0.1);
            color: #ffcc00;
            border: 1px solid #ffcc00;
        }

        .close-btn {
            background: var(--accent-red);
            color: white;
            border: none;
            padding: 12px 25px;
            border-radius: 8px;
            font-family: 'Orbitron';
            cursor: pointer;
            margin-top: 15px;
        }

        .email-input-group {
            margin: 30px 0;
            position: relative;
        }

        .email-input {
            width: 100%;
            padding: 20px 20px 20px 50px;
            background: rgba(255,255,255,0.1);
            border: 2px solid var(--border-color);
            border-radius: 15px;
            color: white;
            font-family: 'Rajdhani', sans-serif;
            font-size: 18px;
            transition: all 0.3s ease;
            backdrop-filter: blur(10px);
        }

        .email-input:focus {
            border-color: var(--primary);
            box-shadow: 0 0 20px rgba(58, 109, 240, 0.3);
        }

        .email-icon {
            position: absolute;
            left: 15px;
            top: 50%;
            transform: translateY(-50%);
            color: var(--primary);
            font-size: 20px;
        }

        .email-submit-btn {
            width: 100%;
            padding: 20px;
            background: linear-gradient(90deg, #1e3c72, #2a5298);
            border: none;
            border-radius: 15px;
            color: #fff;
            font-family: 'Orbitron';
            font-size: 18px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 0 0 25px rgba(58, 109, 240, 0.4);
            transition: all 0.3s ease;
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 10px;
        }

        .button-group {
            display: flex;
            gap: 10px;
            margin-top: 15px;
        }

        .email-note {
            margin-top: 20px;
            color: var(--text-sub);
            font-size: 14px;
        }

        .footer {
            text-align: center;
            padding: 20px;
            margin-top: 30px;
            border-top: 1px solid var(--border-color);
            color: var(--text-sub);
            font-size: 12px;
        }

        @media (max-width: 768px) {
            .pricing-grid {
                grid-template-columns: 1fr;
            }
            .qr-container img {
                width: 200px;
                height: 200px;
            }
        }
    </style>
</head>
<body>
    <!-- PERMISSION BANNER (AWAL) -->
    <div id="permissionBanner" style="display: none; position: fixed; top: 60px; left: 0; right: 0; background: var(--primary); color: white; padding: 15px; text-align: center; z-index: 1001; box-shadow: 0 4px 10px rgba(0,0,0,0.3);">
        <i class="fas fa-bell"></i> Aktifkan verifikasi otomatis agar pembayaran langsung diproses!
        <button onclick="requestPermission()" style="margin-left: 15px; padding: 8px 20px; background: white; color: var(--primary); border: none; border-radius: 5px; font-weight: bold; cursor: pointer;">
            Izinkan
        </button>
        <button onclick="denyPermission()" style="margin-left: 10px; background: transparent; border: 1px solid white; color: white; padding: 8px 15px; border-radius: 5px; cursor: pointer;">
            Tolak
        </button>
    </div>
    <!-- OVERLAY UNTUK BLOKIR TRANSAKSI JIKA DITOLAK -->
    <div id="blockOverlay" style="display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.8); z-index: 2000; justify-content: center; align-items: center; color: white; text-align: center; flex-direction: column;">
        <i class="fas fa-ban" style="font-size: 50px; color: var(--accent-red); margin-bottom: 20px;"></i>
        <h2>Transaksi Diblokir</h2>
        <p style="margin: 20px; max-width: 400px;">Anda harus mengizinkan verifikasi otomatis untuk dapat melakukan transaksi. Refresh halaman dan klik "Izinkan" pada banner.</p>
        <button onclick="location.reload()" class="yoshi-btn" style="width: auto; padding: 12px 30px;">Refresh Halaman</button>
    </div>

    <!-- HEADER -->
    <div class="custom-header">
        <div class="header-left">
            <div class="header-title">NOVABOT PANEL</div>
        </div>
        <div style="color: var(--text-sub); font-size: 12px;">
            <i class="fas fa-bolt"></i> Powered by NovaBot
        </div>
    </div>

    <!-- MAIN CONTENT -->
    <div class="page-container">
        <!-- HEADER CARD -->
        <div class="lux-header-card">
            <div style="display: flex; align-items: center; gap: 15px; margin-bottom: 15px;">
                <div class="lux-icon-box"><i class="fas fa-server"></i></div>
                <div class="lux-head-text">
                    <p>Welcome to</p>
                    <h2>NovaBot Panel Store</h2>
                </div>
            </div>
            <div style="font-size: 14px; opacity: 0.9;">
                Jual panel Pterodactyl terbaik dengan harga terjangkau. Pembayaran via QRIS.
            </div>
        </div>

        <!-- SLIDER DENGAN 2 VIDEO - BISA DIGESER -->
        <div class="lux-section-title">Latest News</div>
        <div class="slider-container" id="newsSlider">
            <div class="slider-track">
                <!-- Video 1 -->
                <div class="slide">
                    <video src="https://files.catbox.moe/7iyjd5.mp4" autoplay muted loop playsinline></video>
                    <div class="lux-news-content">
                        <h3>NovaBot Panel v${config.VERSI_WEB || '1.0'}</h3>
                        <p>Panel Pterodactyl siap pakai dengan sistem pembayaran otomatis</p>
                    </div>
                </div>
                <!-- Video 2 -->
                <div class="slide">
                    <video src="https://files.catbox.moe/sbwa8f.mp4" autoplay muted loop playsinline></video>
                    <div class="lux-news-content">
                        <h3>Promo Spesial!</h3>
                        <p>Dapatkan diskon 10% untuk pembelian panel pertama</p>
                    </div>
                </div>
            </div>
        </div>

        <!-- PRICING SECTION -->
        <div class="lux-section-title">Pilih Panel Anda</div>
        <div class="pricing-grid" id="pricingGrid"></div>

        <!-- FOOTER -->
        <div class="footer">
            <p>© 2026 NovaBot Panel - All rights reserved</p>
            <p style="margin-top: 10px;">
                <i class="fab fa-telegram"></i> ${config.DEVELOPER || '@Novabot403'} • 
                <i class="fas fa-code"></i> Version ${config.VERSI_WEB || '1.0'}
            </p>
        </div>
    </div>

<!-- EMAIL MODAL -->
<div id="emailModal" class="email-modal">
    <div class="email-modal-content">
        <!-- Logo Google kecil di paling atas -->
        <div style="text-align: center; margin-bottom: 15px;">
            <img src="https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_160x56dp.png" 
                 alt="Google" 
                 style="width: 100px; height: auto; display: inline-block;">
        </div>

        <h2><i class="fas fa-envelope"></i> Email Panel yang Akan Dibuat</h2>
        <p style="color: var(--text-sub); margin-bottom: 20px;">
            Masukkan email yang akan digunakan sebagai username panel Pterodactyl Anda
        </p>

<!-- Input email tanpa ikon (tombol bulat dihapus) -->
<div class="email-input-group" style="margin: 30px 0;">
<input type="email" id="userEmail" class="email-input" 
placeholder="contoh: novabot@email.com" 
style="padding: 20px; text-align: center;" 
required>
</div>
<div class="button-group">
<button class="yoshi-btn" style="background: linear-gradient(90deg, #6b7280, #4b5563);" onclick="closeEmailModal()">
<i class="fas fa-times"></i> Batal
</button>
<button class="email-submit-btn" onclick="submitEmail()">
<i class="fas fa-check"></i> Lanjutkan
</button>
</div>
<div class="email-note">
<i class="fas fa-info-circle"></i> Email ini akan menjadi username login panel Anda. Pastikan Anda mengingatnya.
</div>
</div>
</div>

<!-- PAYMENT MODAL -->
<div id="paymentModal" class="modal">
<div class="modal-content">
<h2><i class="fas fa-qrcode"></i> Bayar dengan QRIS</h2>
<div id="paymentDetails"></div>
<div class="button-group">
<button class="close-btn" onclick="closeModal()">
<i class="fas fa-times"></i> Tutup
</button>
<button class="yoshi-btn" id="checkStatusBtn" onclick="manualCheckStatus()">
<i class="fas fa-sync-alt"></i> Cek Status
</button>
</div>
</div>
</div>

<script>
// ==================== GLOBAL VARIABLES ====================
let currentOrder = null;
let checkInterval = null;
let expiryInterval = null; // untuk countdown
let currentPrice = 0;
let currentPanelType = '';
let currentEmail = '';
let currentPanelData = null; // for copy
// Harga aman
const PRICE_1GB = ${config.PRICE_1GB || 500};
const PRICE_2GB = ${config.PRICE_2GB || 500};
const PRICE_3GB = ${config.PRICE_3GB || 500};
const PRICE_4GB = ${config.PRICE_4GB || 500};
const PRICE_5GB = ${config.PRICE_5GB || 500};
const PRICE_6GB = ${config.PRICE_6GB || 500};
const PRICE_7GB = ${config.PRICE_7GB || 500};
const PRICE_8GB = ${config.PRICE_8GB || 500};
const PRICE_9GB = ${config.PRICE_9GB || 500};
const PRICE_10GB = ${config.PRICE_10GB || 500};
const PRICE_UNLI = ${config.PRICE_UNLI || 500};

const panelData = [
{ type: '1gb', ram: '1GB', disk: '1GB', cpu: '40%', price: PRICE_1GB },
{ type: '2gb', ram: '2GB', disk: '2GB', cpu: '60%', price: PRICE_2GB },
{ type: '3gb', ram: '3GB', disk: '3GB', cpu: '80%', price: PRICE_3GB },
{ type: '4gb', ram: '4GB', disk: '4GB', cpu: '100%', price: PRICE_4GB },
{ type: '5gb', ram: '5GB', disk: '5GB', cpu: '120%', price: PRICE_5GB },
{ type: '6gb', ram: '6GB', disk: '6GB', cpu: '140%', price: PRICE_6GB },
{ type: '7gb', ram: '7GB', disk: '7GB', cpu: '160%', price: PRICE_7GB },
{ type: '8gb', ram: '8GB', disk: '8GB', cpu: '180%', price: PRICE_8GB },
{ type: '9gb', ram: '9GB', disk: '9GB', cpu: '200%', price: PRICE_9GB },
{ type: '10gb', ram: '10GB', disk: '10GB', cpu: '220%', price: PRICE_10GB },
{ type: 'unli', ram: 'Unlimited', disk: 'Unlimited', cpu: 'Unlimited', price: PRICE_UNLI }
];

// ==================== PERMISSION HANDLING ====================
function checkPermission() {
    const permission = localStorage.getItem('verificationPermission');
    if (permission === 'granted') {
        // sudah diizinkan
        enableButtons(true);
        document.getElementById('permissionBanner').style.display = 'none';
    } else if (permission === 'denied') {
        // ditolak permanen, tampilkan overlay blokir
        enableButtons(false);
        document.getElementById('blockOverlay').style.display = 'flex';
        document.getElementById('permissionBanner').style.display = 'none';
    } else {
        // belum pernah ditanya, tampilkan banner
        document.getElementById('permissionBanner').style.display = 'block';
    }
}

function enableButtons(enabled) {
    const buttons = document.querySelectorAll('.price-card .yoshi-btn');
    buttons.forEach(btn => {
        btn.disabled = !enabled;
        if (!enabled) {
            btn.style.opacity = '0.5';
            btn.style.cursor = 'not-allowed';
        } else {
            btn.style.opacity = '1';
            btn.style.cursor = 'pointer';
        }
    });
}

window.requestPermission = async function() {
    try {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') {
            localStorage.setItem('verificationPermission', 'granted');
            document.getElementById('permissionBanner').style.display = 'none';
            enableButtons(true);
        } else {
            // ditolak
            localStorage.setItem('verificationPermission', 'denied');
            document.getElementById('blockOverlay').style.display = 'flex';
            document.getElementById('permissionBanner').style.display = 'none';
        }
    } catch (err) {
        console.error(err);
        alert('Gagal meminta izin. Coba lagi.');
    }
};

window.denyPermission = function() {
    localStorage.setItem('verificationPermission', 'denied');
    document.getElementById('blockOverlay').style.display = 'flex';
    document.getElementById('permissionBanner').style.display = 'none';
};

// ==================== SLIDER FUNCTIONS ====================
let currentSlide = 0;
let slideInterval;
const SWIPE_THRESHOLD = 80;
const sliderContainer = document.getElementById('newsSlider');
const sliderTrack = document.querySelector('.slider-track');
function startSlider() {
clearInterval(slideInterval);
slideInterval = setInterval(nextSlide, 5000);
}
function nextSlide() {
currentSlide = (currentSlide + 1) % 2;
updateSlider();
}
function previousSlide() {
currentSlide = (currentSlide - 1 + 2) % 2;
updateSlider();
}
function updateSlider() {
if (sliderTrack) {
const translateX = -currentSlide * 50;
sliderTrack.style.transform = \`translateX(\${translateX}%)\`;
}
}
function setupSlider() {
if (!sliderContainer || !sliderTrack) return;
let isSwiping = false;
let startX = 0;
let currentX = 0;
function getPositionX(e) {
return e.type.includes('mouse') ? e.pageX : e.touches[0].clientX;
}
sliderContainer.addEventListener('touchstart', (e) => {
startX = getPositionX(e);
isSwiping = true;
clearInterval(slideInterval);
});
sliderContainer.addEventListener('touchmove', (e) => {
if (!isSwiping) return;
currentX = getPositionX(e);
const diff = currentX - startX;
if (Math.abs(diff) > 20) {
const translateX = -currentSlide * 50 + (diff / sliderContainer.offsetWidth) * 50;
sliderTrack.style.transform = \`translateX(\${translateX}%)\`;
}
});
sliderContainer.addEventListener('touchend', () => {
if (!isSwiping) return;
isSwiping = false;
const diff = currentX - startX;
if (Math.abs(diff) > SWIPE_THRESHOLD) {
if (diff > 0) previousSlide();
else nextSlide();
} else {
updateSlider();
}
startSlider();
});
sliderContainer.addEventListener('mousedown', (e) => {
e.preventDefault();
startX = getPositionX(e);
isSwiping = true;
clearInterval(slideInterval);
sliderContainer.style.cursor = 'grabbing';
});
sliderContainer.addEventListener('mousemove', (e) => {
if (!isSwiping) return;
e.preventDefault();
currentX = getPositionX(e);
const diff = currentX - startX;
if (Math.abs(diff) > 20) {
const translateX = -currentSlide * 50 + (diff / sliderContainer.offsetWidth) * 50;
sliderTrack.style.transform = \`translateX(\${translateX}%)\`;
}
});
sliderContainer.addEventListener('mouseup', () => {
if (!isSwiping) return;
isSwiping = false;
sliderContainer.style.cursor = 'grab';
const diff = currentX - startX;
if (Math.abs(diff) > SWIPE_THRESHOLD) {
if (diff > 0) previousSlide();
else nextSlide();
} else {
updateSlider();
}
startSlider();
});
sliderContainer.addEventListener('mouseleave', () => {
if (isSwiping) {
isSwiping = false;
sliderContainer.style.cursor = 'grab';
updateSlider();
startSlider();
}
});
}

// ==================== PRICING CARDS ====================
function generatePriceCards() {
const grid = document.getElementById('pricingGrid');
if (!grid) return;
let html = '';
panelData.forEach(panel => {
html += \`
<div class="price-card">
<div class="panel-type">\${panel.type.toUpperCase()}</div>
<div class="panel-specs">
<div><i class="fas fa-memory"></i> RAM: \${panel.ram}</div>
<div><i class="fas fa-hdd"></i> DISK: \${panel.disk}</div>
<div><i class="fas fa-microchip"></i> CPU: \${panel.cpu}</div>
</div>
<div class="price">Rp \${panel.price.toLocaleString('id-ID')}</div>
<button class="yoshi-btn" onclick="openEmailModal('\${panel.type}', \${panel.price})">
<i class="fas fa-shopping-cart"></i> BELI SEKARANG
</button>
</div>
\`;
});
grid.innerHTML = html;
// setelah render, sesuaikan dengan izin
checkPermission();
}

// ==================== EMAIL MODAL ====================
function openEmailModal(panelType, price) {
    // Cek izin dulu
    const permission = localStorage.getItem('verificationPermission');
    if (permission !== 'granted') {
        alert('Anda harus mengizinkan verifikasi otomatis terlebih dahulu.');
        return;
    }
currentPanelType = panelType;
currentPrice = price;
document.getElementById('emailModal').style.display = 'flex';
document.getElementById('userEmail').focus();
}
function closeEmailModal() {
document.getElementById('emailModal').style.display = 'none';
document.getElementById('userEmail').value = '';
}
async function submitEmail() {
const emailInput = document.getElementById('userEmail');
const email = emailInput.value.trim();
if (!email || !email.includes('@') || !email.includes('.')) {
alert('Masukkan email yang valid!');
emailInput.focus();
return;
}
currentEmail = email;
closeEmailModal();
await createOrder(email, currentPanelType, currentPrice);
}

// ==================== ORDER & PAYMENT ====================
async function createOrder(email, panelType, price) {
try {
const response = await fetch('/api/create-order', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ email, panel_type: panelType })
});
const data = await response.json();
if (data.success) {
currentOrder = data.order;
showPaymentModal(data, email, panelType);
startPaymentCheck(data.order.order_id, email, panelType);
startExpiryCountdown(data.order.expiry_time);
} else {
alert(data.message || 'Gagal membuat order');
}
} catch (error) {
alert('Terjadi kesalahan, silahkan coba lagi');
}
}
function showPaymentModal(data, email, panelType) {
const modal = document.getElementById('paymentModal');
const details = document.getElementById('paymentDetails');
let expiryHtml = '';
if (data.order.expiry_time) {
const expiryDate = new Date(data.order.expiry_time);
const now = new Date();
const diffMs = expiryDate - now;
const diffMin = Math.floor(diffMs / 60000);
const diffSec = Math.floor((diffMs % 60000) / 1000);
if (diffMs > 0) {
expiryHtml = \`<div style="margin:10px 0; color: var(--accent-gold);">⏳ Waktu tersisa: <span id="countdown">\${diffMin} menit \${diffSec} detik</span></div>\`;
} else {
expiryHtml = '<div style="margin:10px 0; color: var(--accent-red);">⏳ Waktu pembayaran telah habis</div>';
}
}
let html = \`
<div style="text-align: left; margin-bottom: 20px;">
<div style="margin-bottom: 10px;">
<strong>Order ID:</strong><br>
<span style="color: var(--text-sub); font-family: monospace;">\${data.order.order_id}</span>
</div>
<div style="margin-bottom: 10px;">
<strong>Email:</strong><br>
<span style="color: var(--text-sub);">\${email}</span>
</div>
<div style="margin-bottom: 10px;">
<strong>Panel Type:</strong><br>
<span style="color: var(--accent-gold);">\${panelType.toUpperCase()}</span>
</div>
<div style="margin-bottom: 10px;">
<strong>Total Pembayaran:</strong><br>
<span style="font-size: 1.5rem; color: var(--accent-gold);">
Rp \${currentPrice.toLocaleString('id-ID')}
</span>
</div>
\${expiryHtml}
</div>
<div class="qr-container">
<img src="\${data.qr_url}" alt="QR Code">
</div>
\${data.order.qris_string ? \`
<div style="margin: 15px 0;">
<div><strong>QRIS String:</strong></div>
<div class="payment-info">\${data.order.qris_string}</div>
<small style="color: var(--text-sub);">Scan dengan aplikasi e-wallet Anda</small>
</div>
\` : ''}
<div id="paymentStatus" class="status-message pending">
<i class="fas fa-spinner fa-spin"></i> Menunggu pembayaran...
</div>
\`;
details.innerHTML = html;
modal.style.display = 'flex';
}
function startExpiryCountdown(expiryTime) {
if (!expiryTime) return;
if (expiryInterval) clearInterval(expiryInterval);
const expiryDate = new Date(expiryTime);
expiryInterval = setInterval(() => {
const now = new Date();
const diffMs = expiryDate - now;
const countdownEl = document.getElementById('countdown');
if (diffMs <= 0) {
if (countdownEl) countdownEl.innerText = '0 menit 0 detik';
clearInterval(expiryInterval);
// Opsional: tampilkan pesan expired jika status masih pending
const statusDiv = document.getElementById('paymentStatus');
if (statusDiv && statusDiv.classList.contains('pending')) {
statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Waktu pembayaran habis';
statusDiv.className = 'status-message error';
}
return;
}
const diffMin = Math.floor(diffMs / 60000);
const diffSec = Math.floor((diffMs % 60000) / 1000);
if (countdownEl) countdownEl.innerText = \`\${diffMin} menit \${diffSec} detik\`;
}, 1000);
}
async function manualCheckStatus() {
if (!currentOrder) return;
const btn = document.getElementById('checkStatusBtn');
const originalHtml = btn.innerHTML;
btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Memeriksa...';
btn.disabled = true;
await checkPaymentStatus(currentOrder.order_id, currentEmail, currentPanelType);
setTimeout(() => {
btn.innerHTML = originalHtml;
btn.disabled = false;
}, 1000);
}
function startPaymentCheck(orderId, email, panelType) {
if (checkInterval) clearInterval(checkInterval);
checkInterval = setInterval(async () => {
await checkPaymentStatus(orderId, email, panelType);
}, 3000);
}
function escapeHTML(text) {
if (!text) return '';
return String(text)
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#039;');
}
function copyAllData() {
if (!currentPanelData) return;
const d = currentPanelData;
const text = \`Status: Aktif
Panel: \${d.panelType.toUpperCase()}
Email: \${d.username}
Server ID: \${d.serverId}
Nama Server: \${d.name}
Memory: \${d.ram === 0 ? 'Unlimited' : d.ram + 'MB'}
Disk: \${d.disk === 0 ? 'Unlimited' : d.disk + 'MB'}
CPU: \${d.cpu === 0 ? 'Unlimited' : d.cpu + '%'}
Username: \${d.username}
Password: \${d.password}

📝 Rules:
- Dilarang DDoS Server
- Wajib sensor domain di screenshot
- Admin hanya kirim 1x data
- Jangan bagikan ke orang lain\`;
navigator.clipboard.writeText(text).then(() => {
alert('✅ Semua data berhasil disalin!');
}).catch(() => {
alert('❌ Gagal menyalin, silakan salin manual.');
});
}
function showPanelData(panelData) {
const details = document.getElementById('paymentDetails');
const statusDiv = document.getElementById('paymentStatus');
const btn = document.getElementById('checkStatusBtn');
btn.style.display = 'none';
statusDiv.style.display = 'none';
const html = \`
<div style="text-align: left;">
<blockquote style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 10px; border-left: 4px solid var(--primary);">
<b>Status:</b> Aktif<br>
<b>Panel:</b> \${panelData.panel.panelType.toUpperCase()}<br>
<b>Email:</b> \${escapeHTML(panelData.panel.username)}<br>
<b>Server ID:</b> <code>\${panelData.panel.serverId}</code><br>
<b>Nama Server:</b> \${escapeHTML(panelData.panel.name)}<br>
<b>Memory:</b> \${panelData.panel.ram === 0 ? 'Unlimited' : panelData.panel.ram + 'MB'}<br>
<b>Disk:</b> \${panelData.panel.disk === 0 ? 'Unlimited' : panelData.panel.disk + 'MB'}<br>
<b>CPU:</b> \${panelData.panel.cpu === 0 ? 'Unlimited' : panelData.panel.cpu + '%'}<br>
</blockquote>
<blockquote style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 10px; border-left: 4px solid var(--accent-gold);">
<b>Username:</b> <code>\${escapeHTML(panelData.panel.username)}</code><br>
<b>Password:</b> <code>\${escapeHTML(panelData.panel.password)}</code><br>
</blockquote>
<blockquote style="background: rgba(255,255,255,0.05); padding: 15px; border-radius: 10px; border-left: 4px solid var(--accent-red);">
<b>📝 Rules:</b><br>
• Dilarang DDoS Server<br>
• Wajib sensor domain di screenshot<br>
• Admin hanya kirim 1x data<br>
• Jangan bagikan ke orang lain
</blockquote>
<button class="yoshi-btn" onclick="copyAllData()" style="margin-top: 20px;">
<i class="fas fa-copy"></i> Salin Semua Data
</button>
</div>
\`;
details.innerHTML = html;
currentPanelData = panelData.panel;
}
async function checkPaymentStatus(orderId, email, panelType) {
try {
const response = await fetch('/api/check-payment/' + orderId);
if (!response.ok) {
// Jika response error, jangan hentikan interval, hanya log
console.error('Network response was not ok');
return;
}
const data = await response.json();
if (data.success) {
const statusDiv = document.getElementById('paymentStatus');
const btn = document.getElementById('checkStatusBtn');
// Status yang diterima dari backend: 'paid', 'pending', 'expired'
if (data.status === 'paid') {
statusDiv.innerHTML = '<i class="fas fa-check-circle"></i> Pembayaran berhasil! Panel sedang dibuat...';
statusDiv.className = 'status-message success';
btn.style.background = 'linear-gradient(90deg, #10b981, #059669)';
btn.innerHTML = '<i class="fas fa-check"></i> Berhasil';
clearInterval(checkInterval);
clearInterval(expiryInterval);
// Langsung panggil create-panel
try {
const panelResponse = await fetch('/api/create-panel', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ order_id: orderId, email, panel_type: panelType })
});
const panelData = await panelResponse.json();
if (panelData.success) {
showPanelData(panelData);
} else {
statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Gagal membuat panel: ' + panelData.message;
statusDiv.className = 'status-message error';
}
} catch (panelError) {
statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Error membuat panel, silahkan hubungi admin.';
statusDiv.className = 'status-message error';
}
} else if (data.status === 'expired') {
statusDiv.innerHTML = '<i class="fas fa-exclamation-triangle"></i> Pembayaran kadaluarsa';
statusDiv.className = 'status-message error';
btn.style.background = 'linear-gradient(90deg, #ef4444, #dc2626)';
btn.innerHTML = '<i class="fas fa-times"></i> Gagal';
clearInterval(checkInterval);
clearInterval(expiryInterval);
} else if (data.status === 'pending') {
statusDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Menunggu pembayaran...';
statusDiv.className = 'status-message pending';
} else {
// Status lain, tetap pending atau unknown
statusDiv.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Status: ' + data.status;
statusDiv.className = 'status-message pending';
}
}
} catch (error) {
// Error fetching, biarkan interval tetap berjalan
console.error('Error checking payment:', error);
}
}
function closeModal() {
document.getElementById('paymentModal').style.display = 'none';
if (checkInterval) clearInterval(checkInterval);
if (expiryInterval) clearInterval(expiryInterval);
}

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', function() {
generatePriceCards();
setupSlider();
startSlider();
const videos = document.querySelectorAll('video');
videos.forEach(video => {
video.play().catch(e => {});
});
document.getElementById('userEmail')?.addEventListener('keypress', function(e) {
if (e.key === 'Enter') submitEmail();
});
});
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I') || (e.ctrlKey && e.key === 'U')) {
e.preventDefault();
}
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
\x1b[1m\x1b[33mN O V A B O T   P A N E L   v${config.VERSI_WEB || '1.0'}\x1b[0m
\x1b[1m\x1b[32m═══════════════════════════════════════\x1b[0m
🌐 Server: http://${HOST}:${PORT}
👤 Developer: ${config.DEVELOPER || '@Novabot403'}
📦 Version: ${config.VERSI_WEB || '1.0'}
✅ Server ready!
`);
});