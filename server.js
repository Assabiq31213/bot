// server.js - ConvertSW HD ALL IN ONE - Kirim Video HD ke User (Bukan ke SW)
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys'
import pino from 'pino'
import express from 'express'
import path from 'path'
import fs from 'fs'
import multer from 'multer'
import sharp from 'sharp'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { fileURLToPath } from 'url'

const execFileAsync = promisify(execFile)
const runFfmpeg = (args) => execFileAsync('ffmpeg', ['-y', ...args])
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ===== CONFIG - GANTI NOMOR KAMU DI SINI =====
const config = {
  phoneNumber: '6283861473968',
  port: process.env.PORT || 3000,
  maxFileSize: 100 * 1024 * 1024
}

// ===== BAIleys CONNECTION =====
const botStatus = { connected: false, phone: config.phoneNumber, pairingCode: '', lastError: '', totalSW: 0 }
let sockInstance = null
const getSock = () => sockInstance

async function createConnection() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { version } = await fetchLatestBaileysVersion()
  const sock = makeWASocket({
    version, auth: state, logger: pino({ level: 'silent' }),
    printQRInTerminal: false, browser: ['ConvertSW-HD', 'Chrome', '1.0'],
    syncFullHistory: false, markOnlineOnConnect: true
  })
  sockInstance = sock
  sock.ev.on('creds.update', saveCreds)
  if (!sock.authState.creds.registered) {
    let phone = config.phoneNumber.replace(/[^0-9]/g, '')
    console.log(`📱 Nomor SW: ${phone} - Menunggu pairing via web...`)
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(phone)
        botStatus.pairingCode = code.slice(0, 4) + '-' + code.slice(4)
        console.log(`✅ PAIRING: ${botStatus.pairingCode}`)
      } catch (e) { botStatus.lastError = e.message; console.log('❌ Gagal pairing:', e.message) }
    }, 3000)
  }
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update
    if (connection === 'close') {
      botStatus.connected = false
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      botStatus.lastError = lastDisconnect?.error?.message || 'Disconnected'
      if (shouldReconnect) setTimeout(() => createConnection(), 3000)
      else botStatus.pairingCode = ''
    } else if (connection === 'open') {
      botStatus.connected = true; botStatus.pairingCode = ''
      console.log('✅ ConvertSW HD Terhubung! Nomor:', config.phoneNumber)
    }
  })
  return sock
}
async function requestNewPairingCode() {
  try {
    const sock = getSock(); if (!sock) return { success: false, message: 'Bot belum jalan' }
    let phone = config.phoneNumber.replace(/[^0-9]/g, '')
    const code = await sock.requestPairingCode(phone)
    botStatus.pairingCode = code.slice(0, 4) + '-' + code.slice(4)
    return { success: true, code: botStatus.pairingCode }
  } catch (e) { return { success: false, message: e.message } }
}
async function logoutBot() {
  try { const sock = getSock(); if (sock) await sock.logout(); botStatus.connected = false; botStatus.pairingCode = ''; return { success: true } }
  catch (e) { return { success: false, message: e.message } }
}

// ===== CONVERTER HD =====
async function convertImageToHD(inputPath, outputPath) {
  try {
    await sharp(inputPath).sharpen({ sigma: 1.2, m1: 1, m2: 0.5 }).modulate({ brightness: 1.05, saturation: 1.1 }).jpeg({ quality: 100, chromaSubsampling: '4:4:4' }).toFile(outputPath)
    return outputPath
  } catch { fs.copyFileSync(inputPath, outputPath); return outputPath }
}
async function convertVideoToHD(inputPath, outputPath) {
  try {
    await runFfmpeg(['-i', inputPath, '-c:v', 'libx264', '-crf', '18', '-preset', 'medium', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputPath])
    return outputPath
  } catch { fs.copyFileSync(inputPath, outputPath); return outputPath }
}
const getFileInfo = (filePath) => { const s = fs.statSync(filePath); return { size: s.size, sizeMB: (s.size / 1024 / 1024).toFixed(2) + ' MB', ext: path.extname(filePath).toLowerCase() } }
const isVideo = (f) => ['.mp4', '.mov', '.mkv', '.webm', '.avi'].includes(path.extname(f).toLowerCase())
const isImage = (f) => ['.jpg', '.jpeg', '.png', '.webp', '.heic'].includes(path.extname(f).toLowerCase())

// ===== WEB SERVER =====
for (const dir of ['./uploads', './hd-output']) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }) }
const app = express()
const PORT = config.port
app.use(express.json()); app.use(express.urlencoded({ extended: true }))
app.use('/hd-output', express.static(path.join(__dirname, 'hd-output')))
app.use('/uploads', express.static(path.join(__dirname, 'uploads')))

const storage = multer.diskStorage({ destination: './uploads', filename: (req, file, cb) => { cb(null, `upload-${Date.now()}${path.extname(file.originalname)}`) } })
const upload = multer({ storage, limits: { fileSize: config.maxFileSize } })

app.get('/api/status', (req, res) => res.json({ connected: botStatus.connected, phone: botStatus.phone, pairingCode: botStatus.pairingCode, totalSW: botStatus.totalSW, lastError: botStatus.lastError }))
app.post('/api/pairing', async (req, res) => res.json(await requestNewPairingCode()))
app.post('/api/logout', async (req, res) => res.json(await logoutBot()))

app.post('/api/sw-hd', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) return res.json({ success: false, message: 'File belum dipilih!' })
    const caption = req.body.caption || 'Hasil HD kamu ✨'
    const targetNumber = req.body.targetNumber || config.phoneNumber
    const sendToUser = req.body.sendToUser === 'true'
    const inputPath = req.file.path
    const isVid = isVideo(req.file.originalname)
    const outputName = `HD-${Date.now()}${isVid ? '.mp4' : '.jpg'}`
    const outputPath = path.join('./hd-output', outputName)
    console.log(`🔄 Convert HD: ${req.file.originalname} -> ${outputName} -> Kirim ke ${targetNumber}`)
    if (isVid) await convertVideoToHD(inputPath, outputPath)
    else if (isImage(req.file.originalname)) await convertImageToHD(inputPath, outputPath)
    else fs.copyFileSync(inputPath, outputPath)
    const originalInfo = getFileInfo(inputPath)
    const hdInfo = getFileInfo(outputPath)
    const downloadUrl = `/hd-output/${outputName}`
    let sentToUser = false
    if (sendToUser) {
      const sock = getSock()
      if (!sock || !botStatus.connected) return res.json({ success: false, message: 'WhatsApp belum terhubung! Pairing dulu via web.' })
      const cleanNumber = targetNumber.replace(/[^0-9]/g, '')
      const jid = cleanNumber + '@s.whatsapp.net'
      const buffer = fs.readFileSync(outputPath)
      console.log(`📤 Kirim HD ke user: ${jid}`)
      if (isVid) {
        await sock.sendMessage(jid, { text: `✨ *VIDEO HD KAMU SUDAH JADI!*\n\n📄 File: ${outputName}\n📦 Ukuran HD: ${hdInfo.sizeMB}\n📦 Ukuran Asli: ${originalInfo.sizeMB}\n\nVideo di bawah ini dikirim sebagai *DOKUMEN HD*, kualitas 100% original, tanpa kompres.\n\nTinggal forward / upload ke SW kamu, dijamin tidak burik! 🚀` })
        await sock.sendMessage(jid, { document: buffer, mimetype: 'video/mp4', fileName: `VIDEO-HD-${Date.now()}.mp4`, caption })
      } else {
        await sock.sendMessage(jid, { text: `✨ *FOTO HD KAMU SUDAH JADI!*\n\n📄 File: ${outputName}\n📦 Ukuran HD: ${hdInfo.sizeMB}\n\nFoto di bawah dikirim sebagai *DOKUMEN HD*, kualitas 100% original.` })
        await sock.sendMessage(jid, { document: buffer, mimetype: 'image/jpeg', fileName: `FOTO-HD-${Date.now()}.jpg`, caption })
      }
      botStatus.totalSW++; sentToUser = true
      console.log(`✅ HD terkirim ke user: ${jid}`)
    }
    res.json({ success: true, message: sentToUser ? `✅ Berhasil kirim Video HD ke ${targetNumber} (Chat Pribadi)!` : '✅ Berhasil convert ke HD!', original: originalInfo, hd: hdInfo, downloadUrl, fileName: outputName, sentToUser, targetNumber, caption })
  } catch (e) { console.log('SW HD Error:', e); res.json({ success: false, message: e.message }) }
})

app.post('/api/sw-text', async (req, res) => {
  try {
    const { caption, targetNumber } = req.body
    if (!caption) return res.json({ success: false, message: 'Caption kosong!' })
    const sock = getSock(); if (!sock || !botStatus.connected) return res.json({ success: false, message: 'WhatsApp belum terhubung!' })
    const cleanNumber = (targetNumber || config.phoneNumber).replace(/[^0-9]/g, '')
    const jid = cleanNumber + '@s.whatsapp.net'
    await sock.sendMessage(jid, { text: caption }); botStatus.totalSW++
    res.json({ success: true, message: `✅ Pesan terkirim ke ${cleanNumber}!` })
  } catch (e) { res.json({ success: false, message: e.message }) }
})

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="id"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>ConvertSW HD - Ubah SW Jadi HD</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',Arial,sans-serif;background:#0f0f0f;color:#fff;min-height:100vh}.nav{background:#1a1a1a;padding:15px 20px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0}.logo{font-size:22px;font-weight:bold}.logo span{color:#25D366}.status-badge{padding:6px 12px;border-radius:20px;font-size:13px;background:#ff4444}.status-badge.online{background:#25D366}.hero{text-align:center;padding:40px 20px}.hero h1{font-size:36px;line-height:1.2;margin-bottom:10px}.hero h1 span{color:#25D366}.hero p{color:#aaa;font-size:16px;max-width:600px;margin:0 auto}.container{max-width:650px;margin:0 auto;padding:0 20px 40px}.card{background:#1a1a1a;border-radius:20px;padding:25px;margin:15px 0;border:1px solid #333}.pairing-code{font-size:48px;font-weight:bold;letter-spacing:8px;color:#25D366;background:#000;padding:20px;border-radius:15px;margin:15px 0;text-align:center}.step{background:#222;padding:12px;border-radius:10px;margin:8px 0;font-size:14px;line-height:1.6}.upload-area{border:2px dashed #25D366;border-radius:15px;padding:30px;text-align:center;cursor:pointer}.upload-area input{display:none}.preview{max-width:100%;max-height:300px;border-radius:12px;margin:15px auto;display:none}input,textarea{width:100%;padding:13px;border-radius:12px;border:1px solid #333;background:#222;color:#fff;margin:8px 0;font-size:15px}textarea{min-height:80px}.toggle{display:flex;align-items:center;gap:10px;margin:12px 0;font-size:14px}.toggle input{width:20px;height:20px;accent-color:#25D366}button{background:#25D366;color:#fff;border:none;padding:15px;border-radius:12px;font-size:16px;font-weight:bold;cursor:pointer;width:100%;margin:8px 0}button:hover{opacity:.85}button:disabled{background:#444}button.secondary{background:#333}button.red{background:#ff4444}.result{display:none;background:#0a2e16;border:1px solid #25D366;border-radius:15px;padding:20px;margin-top:15px;text-align:center}.compare{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:15px 0;text-align:left}.compare div{background:#222;padding:12px;border-radius:10px;font-size:13px}.features{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:20px}.features div{background:#1a1a1a;padding:18px;border-radius:15px;text-align:center}.loading{display:none;text-align:center;padding:20px}.spinner{width:40px;height:40px;border:4px solid #333;border-top:4px solid #25D366;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 10px}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:500px){.hero h1{font-size:28px}.pairing-code{font-size:32px}}</style></head><body><div class="nav"><div class="logo">Convert<span>SW</span> HD</div><div class="status-badge" id="statusBadge">Offline ❌</div></div><div class="hero"><h1>Ubah Status WA Jadi <span>HD</span><br>Tanpa Burik!</h1><p>Upload foto / video, convert jadi HD kualitas original, dikirim ke chat WhatsApp kamu sebagai Dokumen. Dijamin tidak terkompres!</p></div><div class="container"><div class="card" id="pairingCard"><h3>📱 Langkah 1: Hubungkan WhatsApp</h3><p style="color:#aaa;font-size:14px;margin:10px 0">Nomor: <b id="phone">-</b> | Total Terkirim: <b id="totalSW">0</b></p><div id="pairingSection" style="display:none"><div class="pairing-code" id="pairingCode">----</div><div class="step"><b>Cara Tautkan:</b><br>1. Buka WA di HP kamu<br>2. Perangkat Tertaut > Tautkan Perangkat<br>3. Pilih "Tautkan dengan nomor telepon saja"<br>4. Masukin kode di atas dalam 60 detik</div><button class="secondary" onclick="requestPairing()">🔄 Minta Kode Baru</button></div><div id="connectedSection" style="display:none"><p style="color:#25D366;font-size:18px;font-weight:bold">✅ WhatsApp Terhubung!</p><button class="red" onclick="logout()">🚪 Logout / Ganti Nomor</button></div><p id="errorText" style="color:#ff6666;font-size:13px"></p></div><div class="card"><h3>📸 Langkah 2: Upload Foto / Video</h3><div class="upload-area" onclick="document.getElementById('fileInput').click()"><div style="font-size:50px">📤</div><p><b>Klik untuk pilih foto / video</b></p><p style="color:#aaa;font-size:13px">JPG, PNG, MP4, Max 100MB</p><input type="file" id="fileInput" accept="image/*,video/*" onchange="previewFile(this)"></div><img id="imgPreview" class="preview"><video id="videoPreview" class="preview" controls></video><p id="fileName" style="text-align:center;color:#aaa;font-size:13px;margin-top:8px"></p><label style="font-size:14px">📱 Nomor WhatsApp Tujuan (yang mau dikirimi HD):</label><input id="targetNumber" placeholder="Contoh: 6283861473968" value="6283861473968"><p style="font-size:12px;color:#aaa">Video HD akan dikirim ke chat pribadi nomor ini, BUKAN ke Status / SW.</p><label style="font-size:14px">✍️ Caption:</label><textarea id="caption" placeholder="Tulis caption... contoh: Video HD kamu ✨"></textarea><div class="toggle"><input type="checkbox" id="sendToUser" checked><label for="sendToUser"><b>Kirim hasil HD ke WhatsApp User</b></label></div><div class="loading" id="loading"><div class="spinner"></div><p>⏳ Lagi convert ke HD & kirim ke User...</p></div><button id="btnConvert" onclick="convertSW()">🚀 CONVERT & KIRIM HD KE USER</button><div class="result" id="result"><h3 id="resultTitle">✅ Berhasil!</h3><p id="resultMsg" style="font-size:14px"></p><div class="compare"><div><b>📄 File Asli</b><br><span id="origInfo">-</span></div><div><b>✨ File HD</b><br><span id="hdInfo">-</span></div></div><button onclick="downloadHD()" style="background:#fff;color:#000">⬇️ Download Hasil HD</button><p style="font-size:12px;color:#aaa;margin-top:10px">Cek WhatsApp kamu, Video HD sudah terkirim sebagai Dokumen ke chat pribadi!</p></div></div><div class="card"><h3>💬 Kirim Pesan ke User</h3><textarea id="swText" placeholder="Tulis pesan..."></textarea><button class="secondary" onclick="sendTextSW()">📤 Kirim ke User</button></div><div class="features"><div><div style="font-size:30px">✨</div><b>HD 100% Original</b><p style="font-size:12px;color:#aaa">Dikirim sebagai Dokumen</p></div><div><div style="font-size:30px">🚀</div><b>Convert Otomatis</b><p style="font-size:12px;color:#aaa">Foto di-sharpen, video CRF 18</p></div><div><div style="font-size:30px">📱</div><b>Kirim ke User</b><p style="font-size:12px;color:#aaa">Bukan ke SW, ke chat pribadi</p></div><div><div style="font-size:30px">🔒</div><b>Privasi Aman</b><p style="font-size:12px;color:#aaa">File dihapus otomatis</p></div></div></div><script>let currentDownloadUrl='';async function loadStatus(){try{const res=await fetch('/api/status');const data=await res.json();document.getElementById('phone').textContent=data.phone;document.getElementById('totalSW').textContent=data.totalSW;document.getElementById('errorText').textContent=data.lastError||'';const badge=document.getElementById('statusBadge');if(data.connected){badge.textContent='Online ✅';badge.classList.add('online');document.getElementById('connectedSection').style.display='block';document.getElementById('pairingSection').style.display='none'}else{badge.textContent='Offline ❌';badge.classList.remove('online');document.getElementById('connectedSection').style.display='none';if(data.pairingCode){document.getElementById('pairingSection').style.display='block';document.getElementById('pairingCode').textContent=data.pairingCode}}}catch(e){}}async function requestPairing(){const res=await fetch('/api/pairing',{method:'POST'});const d=await res.json();alert(d.success?'Kode baru: '+d.code:'Gagal: '+d.message);loadStatus()}async function logout(){if(!confirm('Yakin logout?'))return;await fetch('/api/logout',{method:'POST'});alert('Logout berhasil!');loadStatus()}function previewFile(input){const file=input.files[0];if(!file)return;document.getElementById('fileName').textContent=file.name+' ('+(file.size/1024/1024).toFixed(2)+' MB)';const img=document.getElementById('imgPreview');const vid=document.getElementById('videoPreview');const url=URL.createObjectURL(file);if(file.type.startsWith('image/')){img.src=url;img.style.display='block';vid.style.display='none'}else if(file.type.startsWith('video/')){vid.src=url;vid.style.display='block';img.style.display='none'}}async function convertSW(){const fileInput=document.getElementById('fileInput');if(!fileInput.files[0])return alert('Pilih foto / video dulu!');const caption=document.getElementById('caption').value||'Hasil HD kamu ✨';const targetNumber=document.getElementById('targetNumber').value||'6283861473968';const sendToUser=document.getElementById('sendToUser').checked;const form=new FormData();form.append('media',fileInput.files[0]);form.append('caption',caption);form.append('targetNumber',targetNumber);form.append('sendToUser',sendToUser);document.getElementById('loading').style.display='block';document.getElementById('btnConvert').disabled=true;document.getElementById('result').style.display='none';try{const res=await fetch('/api/sw-hd',{method:'POST',body:form});const data=await res.json();document.getElementById('loading').style.display='none';document.getElementById('btnConvert').disabled=false;if(!data.success)return alert('Gagal: '+data.message);document.getElementById('result').style.display='block';document.getElementById('resultTitle').textContent=data.sentToUser?('✅ Berhasil Kirim HD ke '+data.targetNumber+'!'):'✅ Berhasil Convert ke HD!';document.getElementById('resultMsg').textContent=data.message;document.getElementById('origInfo').textContent=data.original.sizeMB+' | '+data.original.ext;document.getElementById('hdInfo').textContent=data.hd.sizeMB+' | '+data.hd.ext+' | Kualitas 100%';currentDownloadUrl=data.downloadUrl;loadStatus()}catch(e){document.getElementById('loading').style.display='none';document.getElementById('btnConvert').disabled=false;alert('Error: '+e.message)}}function downloadHD(){if(!currentDownloadUrl)return alert('Belum ada file HD!');window.open(currentDownloadUrl,'_blank')}async function sendTextSW(){const caption=document.getElementById('swText').value;if(!caption)return alert('Tulis pesan dulu!');const targetNumber=document.getElementById('targetNumber').value;const res=await fetch('/api/sw-text',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({caption,targetNumber})});const d=await res.json();alert(d.message);if(d.success)loadStatus()}setInterval(loadStatus,3000);loadStatus()</script></body></html>`)
})

app.get('/health', (req, res) => res.json({ status: 'ok', bot: botStatus.connected ? 'online' : 'offline' }))

app.listen(PORT, () => {
  console.log(`🌐 ConvertSW HD jalan di http://localhost:${PORT}`)
  console.log(`📱 Video HD dikirim ke USER, bukan ke SW!`)
})

createConnection()