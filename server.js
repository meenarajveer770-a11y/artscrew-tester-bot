const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'testers_config.json');
const AUTH_DIR = path.join(__dirname, 'auth_session');

let sock = null;
let currentQrDataUrl = null;
let connectionStatus = 'initializing';
let botPhoneNumber = null;
let lastRemindedTimes = {}; // { [testerName]: timestamp }
let logsList = [];

function addLog(msg) {
  const time = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true });
  logsList.unshift(`[${time}] ${msg}`);
  if (logsList.length > 50) logsList.pop();
  console.log(`[${time}] ${msg}`);
}

// Load config
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Config read error:', e);
  }
  return {
    apiEndpoint: 'https://artscrew.pages.dev/api/testers',
    checkIntervalMinutes: 60,
    dailyTargetSeconds: 600,
    activeHoursIst: { start: 11, end: 23 },
    testers: []
  };
}

function saveConfig(cfg) {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (e) {
    console.error('Config save error:', e);
    return false;
  }
}

// Format seconds into minutes/seconds string
function formatDuration(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s < 10 ? '0' + s : s}s`;
}

// Helper to sanitize Indian/Intl phone number for WhatsApp JID
function formatJid(phone) {
  let clean = String(phone || '').replace(/[^0-9]/g, '');
  if (clean.length === 10) clean = '91' + clean; // Default India prefix
  return clean ? `${clean}@s.whatsapp.net` : null;
}

const CLOUD_API_URL = 'https://artscrew.pages.dev/api/testers';
const WA_CLOUD_SECRET = process.env.WA_CLOUD_SECRET || 'artscrew_wa_cloud_2026_secret';

async function pullCloudState() {
  try {
    const res = await fetch(CLOUD_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ action: 'get_cloud_state', secret: WA_CLOUD_SECRET })
    });
    const data = await res.json();
    if (data && data.success) {
      if (data.lastRemindedTimes && typeof data.lastRemindedTimes === 'object') {
        lastRemindedTimes = { ...data.lastRemindedTimes, ...lastRemindedTimes };
      }
      if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
      const hasLocalCreds = fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
      const files = data.sessionFiles || {};
      const fileKeys = Object.keys(files);
      if (!hasLocalCreds && fileKeys.length > 0) {
        for (const fname of fileKeys) {
          const safeName = path.basename(fname);
          fs.writeFileSync(path.join(AUTH_DIR, safeName), files[fname], 'utf8');
        }
        addLog(`☁️ Restored ${fileKeys.length} WhatsApp session files from Cloudflare R2!`);
      }
    }
  } catch (e) {
    console.warn('Cloud state pull note:', e.message);
  }
}

async function pushCloudState() {
  try {
    const sessionFiles = {};
    if (fs.existsSync(AUTH_DIR)) {
      const list = fs.readdirSync(AUTH_DIR);
      for (const fname of list) {
        const fullPath = path.join(AUTH_DIR, fname);
        if (fs.statSync(fullPath).isFile()) {
          sessionFiles[fname] = fs.readFileSync(fullPath, 'utf8');
        }
      }
    }
    if (Object.keys(sessionFiles).length === 0) return;
    await fetch(CLOUD_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'save_cloud_state',
        secret: WA_CLOUD_SECRET,
        sessionFiles,
        lastRemindedTimes
      })
    });
  } catch (e) {
    console.warn('Cloud state push note:', e.message);
  }
}

const sentMessagesCache = new Map();

// WhatsApp Connection Engine
async function connectToWhatsApp() {
  try {
    if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
    await pullCloudState();
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['Artscrew Tester Bot', 'Chrome', '1.0.0'],
      getMessage: async (key) => {
        if (key && key.id && sentMessagesCache.has(key.id)) {
          return sentMessagesCache.get(key.id);
        }
        return undefined;
      }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = 'waiting_for_qr';
        try {
          currentQrDataUrl = await qrcode.toDataURL(qr);
          qrcode.toString(qr, { type: 'terminal', small: true }, (err, termQr) => {
            if (!err) {
              console.log('\n' + termQr);
              console.log('📲 Scan this QR Code with WhatsApp on your iPhone:');
              console.log('   (WhatsApp > Settings > Linked Devices > Link a Device)\n');
            }
          });
          addLog('⚡ New QR Code generated! Please scan with WhatsApp on your iPhone.');
        } catch (qrErr) {
          console.error('QR gen error:', qrErr);
        }
      }

      if (connection === 'close') {
        currentQrDataUrl = null;
        const statusCode = (lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode);
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        connectionStatus = shouldReconnect ? 'reconnecting' : 'logged_out';
        addLog(`Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 5000);
        } else {
          // Cleared logged out session
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          setTimeout(connectToWhatsApp, 3000);
        }
      } else if (connection === 'open') {
        currentQrDataUrl = null;
        connectionStatus = 'connected';
        botPhoneNumber = (sock.user && sock.user.id) ? sock.user.id.split(':')[0] : 'Connected';
        addLog(`🎉 WhatsApp Linked Successfully! Active as +${botPhoneNumber}`);
        // Automatically check if any scheduled reminders are due 5s after reconnecting (e.g. after PC wakes from sleep)
        setTimeout(() => {
          runReminderCycle(false);
        }, 5000);
      }
    });
  } catch (err) {
    console.error('WhatsApp connection error:', err);
    connectionStatus = 'error';
    setTimeout(connectToWhatsApp, 10000);
  }
}

let isCycleRunning = false;

async function waitForConnection(maxWaitMs = 25000) {
  const start = Date.now();
  while ((connectionStatus !== 'connected' || !sock) && (Date.now() - start < maxWaitMs)) {
    await delay(1000);
  }
  return connectionStatus === 'connected' && !!sock;
}

// Check Testers and Send Personalized Reminders
async function runReminderCycle(isManualTrigger = false) {
  if (isCycleRunning) {
    return { success: false, reason: 'Cycle already in progress' };
  }

  if (connectionStatus !== 'connected' || !sock) {
    if (connectionStatus === 'reconnecting') {
      addLog('⏳ WhatsApp reconnecting... waiting up to 25s before reminder cycle.');
      const ready = await waitForConnection(25000);
      if (!ready) {
        addLog('⚠️ WhatsApp still not connected after wait. Skipping reminder cycle.');
        return { success: false, reason: 'WhatsApp not connected' };
      }
    } else {
      addLog('⚠️ WhatsApp is not linked yet. Skipping reminder cycle.');
      return { success: false, reason: 'WhatsApp not connected' };
    }
  }

  const config = loadConfig();

  // Check IST Hour (Don't disturb between 10 PM and 10 AM unless manually triggered)
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const istDate = new Date(utc + (3600000 * 5.5));
  const currentHourIst = istDate.getHours();

  const startHour = config.activeHoursIst ? config.activeHoursIst.start : 11;
  const endHour = config.activeHoursIst ? config.activeHoursIst.end : 23;

  if (!isManualTrigger && (currentHourIst < startHour || currentHourIst >= endHour)) {
    addLog(`🌙 Quiet Hours (${currentHourIst}:00 IST). Automatic reminders active between ${startHour}:00 AM - ${endHour}:00 PM.`);
    return { success: true, reason: 'Quiet hours' };
  }

  isCycleRunning = true;
  addLog('🔍 Fetching live tester progress from Artscrew API...');

  try {
    const res = await fetch(config.apiEndpoint || 'https://artscrew.pages.dev/api/testers', {
      headers: { 'Cache-Control': 'no-cache' }
    });
    const data = await res.json();

    if (!data || !data.success || !Array.isArray(data.testers)) {
      addLog('❌ Failed to retrieve valid tester statistics.');
      return { success: false, reason: 'API response invalid' };
    }

    const testersApiList = data.testers;
    const phoneMap = {};
    (config.testers || []).forEach(t => {
      if (t.name && t.phone) phoneMap[t.name.trim()] = t.phone.trim();
    });

    const nowTs = Date.now();
    const intervalMins = Number(config.checkIntervalMinutes) || 60;
    const intervalMs = Math.max(30, intervalMins - 10) * 60 * 1000; // e.g. 50m tolerance for 1h interval
    let sentCount = 0;
    let skippedCount = 0;

    for (const apiTester of testersApiList) {
      const name = apiTester.name;
      const todaySeconds = apiTester.todaySeconds || 0;
      const hasCompleted = apiTester.hasReachedTarget || (todaySeconds >= 600);

      // 1. If tester already finished 10 minutes today, skip!
      if (hasCompleted) {
        continue;
      }

      // 2. Check if reminded within last 1 hour
      const lastReminded = lastRemindedTimes[name] || 0;
      if (!isManualTrigger && (nowTs - lastReminded < intervalMs)) {
        skippedCount++;
        continue;
      }

      // 3. Find Phone Number
      const phone = phoneMap[name];
      if (!phone) {
        addLog(`⚠️ No phone number configured for "${name}". Skipping.`);
        continue;
      }

      const jid = formatJid(phone);
      if (!jid) {
        addLog(`⚠️ Invalid phone format for "${name}" (${phone}). Skipping.`);
        continue;
      }

      // 4. Construct Polite Message with Exact Usage & Remaining Time
      const remainingSec = Math.max(0, 600 - todaySeconds);
      const usedFormatted = formatDuration(todaySeconds);
      const remainingFormatted = formatDuration(remainingSec);

      const reminderMessage = `Hey ${name}! 👋\n\nGoogle Play closed testing ke liye aaj Artscrew app 10 minute use karna compulsory hai.\n\n📊 *Aapka Aaj Ka Record:*\n⏱️ App use hua: *${usedFormatted}* (10 min me se)\n⏳ Target bacha hai: *${remainingFormatted}* baaki hai\n\n💡 *Tip:* App khol kar thoda sa scroll ya drawing canvas/tutorial open karke 1-2 line draw kar lena aur screen lock mat hone dena, taaki Google Play par attendance 100% count ho sake 🙏\n\n(Note: Jaise hi aapke 10 minute complete honge, reminders aana auto-stop ho jayega).`;

      // 5. Send WhatsApp Message with safe human-like delay (wait if socket is reconnecting)
      try {
        if (connectionStatus !== 'connected' || !sock) {
          await waitForConnection(25000);
        }
        const sentMsg = await sock.sendMessage(jid, { text: reminderMessage });
        if (sentMsg && sentMsg.key && sentMsg.key.id) {
          sentMessagesCache.set(sentMsg.key.id, sentMsg.message || { conversation: reminderMessage });
        }
        lastRemindedTimes[name] = Date.now();
        sentCount++;
        addLog(`✅ Reminder sent to ${name} (${phone}) - Today: ${formatDuration(todaySeconds)}/10m`);

        // Wait 4-7 seconds before next message to keep WhatsApp account 100% safe
        await delay(Math.floor(Math.random() * 3000) + 4000);
      } catch (sendErr) {
        addLog(`❌ Failed to send message to ${name} (${phone}): ${sendErr && sendErr.message ? sendErr.message : sendErr}`);
      }
    }

    addLog(`🏁 Reminder cycle finished. Sent: ${sentCount}, Skipped: ${skippedCount}`);
    await pushCloudState();
    return { success: true, sent: sentCount, skipped: skippedCount };
  } catch (fetchErr) {
    addLog(`❌ Error in reminder cycle: ${fetchErr.message}`);
    return { success: false, error: fetchErr.message };
  } finally {
    isCycleRunning = false;
  }
}

// Interval Scheduler (Every 10 minutes, checks if 1 hour elapsed since last reminder)
setInterval(() => {
  runReminderCycle(false);
}, 10 * 60 * 1000);

// Initial check 30 seconds after start
setTimeout(() => {
  runReminderCycle(false);
}, 30000);

// Web Dashboard UI
app.get('/', (req, res) => {
  const config = loadConfig();
  const testers = config.testers || [];

  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Artscrew Closed Testers WhatsApp Bot</title>
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800;900&display=swap" rel="stylesheet">
      <style>
        body { font-family: 'Plus Jakarta Sans', sans-serif; background: #0F172A; color: #F8FAFC; margin: 0; padding: 20px; }
        .card { background: #1E293B; border: 1px solid #334155; border-radius: 16px; padding: 20px; max-width: 680px; margin: 0 auto 20px auto; }
        h1 { font-size: 20px; margin: 0 0 8px 0; color: #FF6B4A; }
        .status-badge { display: inline-block; padding: 4px 12px; border-radius: 99px; font-size: 12px; font-weight: 800; }
        .status-connected { background: #065F46; color: #34D399; }
        .status-waiting { background: #854D0E; color: #FDE047; }
        .status-error { background: #991B1B; color: #FCA5A5; }
        .qr-box { text-align: center; margin: 20px 0; padding: 20px; background: white; border-radius: 16px; display: inline-block; }
        .btn { background: #25D366; color: white; border: none; padding: 10px 18px; border-radius: 10px; font-weight: 800; cursor: pointer; font-size: 13px; }
        .btn-secondary { background: #475569; }
        table { width: 100%; border-collapse: collapse; margin-top: 14px; }
        th, td { text-align: left; padding: 8px 10px; font-size: 12px; border-bottom: 1px solid #334155; }
        th { color: #94A3B8; text-transform: uppercase; font-size: 11px; }
        input[type="text"] { width: 100%; padding: 6px 10px; background: #0F172A; border: 1px solid #475569; color: white; border-radius: 8px; font-size: 12px; box-sizing: border-box; }
        .logs-box { background: #0F172A; border: 1px solid #334155; border-radius: 10px; padding: 12px; font-family: monospace; font-size: 11px; max-height: 220px; overflow-y: auto; color: #A7F3D0; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>🤖 Artscrew Closed Tester WhatsApp Auto-Bot</h1>
        <div style="font-size: 12.5px; color: #94A3B8; margin-bottom: 14px;">
          Automatic 1-Hour 1-on-1 Reminders (11:00 AM - 11:00 PM IST)
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
          <div>
            Status: 
            <span class="status-badge ${connectionStatus === 'connected' ? 'status-connected' : (connectionStatus === 'waiting_for_qr' ? 'status-waiting' : 'status-error')}">
              ${connectionStatus.toUpperCase()}
            </span>
            ${botPhoneNumber ? `<span style="font-size: 12px; color: #34D399; margin-left: 8px;">(+${botPhoneNumber})</span>` : ''}
          </div>
          <form method="POST" action="/trigger-now" style="margin: 0;">
            <button class="btn" type="submit" ${connectionStatus !== 'connected' ? 'disabled style="opacity:0.5;"' : ''}>
              ⚡ Send Check-In Reminders Now
            </button>
          </form>
        </div>

        ${connectionStatus === 'waiting_for_qr' && currentQrDataUrl ? `
          <div style="text-align: center; margin: 20px 0;">
            <div style="font-size: 13px; font-weight: 700; color: #FDE047; margin-bottom: 10px;">
              📲 Scan this QR Code with WhatsApp on your iPhone:<br/>
              <span style="font-size: 11px; color: #94A3B8;">Settings ➔ Linked Devices ➔ Link a Device</span>
            </div>
            <div class="qr-box">
              <img src="${currentQrDataUrl}" alt="Scan QR Code" style="width: 240px; height: 240px; display: block;" />
            </div>
            <div style="font-size: 11px; color: #94A3B8;">Page will automatically reload once connected.</div>
          </div>
        ` : ''}

        ${connectionStatus === 'connected' ? `
          <div style="background: rgba(6, 95, 70, 0.3); border: 1px solid #065F46; border-radius: 10px; padding: 12px; font-size: 12px; color: #A7F3D0; margin-bottom: 16px;">
            ✅ <strong>WhatsApp 100% Connected!</strong> The bot is running in the cloud 24/7. It will automatically check Artscrew live progress and send personal reminders every 2 hours to anyone who hasn't completed their 10 minutes today.
          </div>
        ` : ''}
      </div>

      <!-- Testers Phone Configuration -->
      <div class="card">
        <h2 style="font-size: 16px; margin: 0 0 6px 0;">📱 13 Testers Mobile Numbers</h2>
        <div style="font-size: 12px; color: #94A3B8; margin-bottom: 12px;">
          Enter each tester's 10-digit WhatsApp number (e.g. <code>9876543210</code>). Bot will send DMs to these numbers.
        </div>

        <form method="POST" action="/save-testers">
          <table>
            <thead>
              <tr>
                <th style="width: 40px;">#</th>
                <th style="width: 140px;">Tester Name</th>
                <th>WhatsApp Mobile Number</th>
              </tr>
            </thead>
            <tbody>
              ${testers.map((t, idx) => `
                <tr>
                  <td>${idx + 1}</td>
                  <td><strong>${t.name}</strong></td>
                  <td>
                    <input type="text" name="phone_${idx}" value="${t.phone || ''}" placeholder="e.g. 9876543210" />
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <div style="margin-top: 14px; text-align: right;">
            <button type="submit" class="btn">💾 Save All Numbers</button>
          </div>
        </form>
      </div>

      <!-- Activity Logs -->
      <div class="card">
        <h2 style="font-size: 16px; margin: 0 0 10px 0;">📜 Live Activity Log</h2>
        <div class="logs-box">
          ${logsList.length > 0 ? logsList.map(l => `<div>${l}</div>`).join('') : '<div>Waiting for first cycle...</div>'}
        </div>
      </div>

      <script>
        // Auto refresh page every 15s if waiting for QR code
        ${connectionStatus === 'waiting_for_qr' ? 'setTimeout(() => window.location.reload(), 15000);' : ''}
      </script>
    </body>
    </html>
  `);
});

// Save testers phone numbers
app.post('/save-testers', (req, res) => {
  const config = loadConfig();
  if (Array.isArray(config.testers)) {
    config.testers.forEach((t, idx) => {
      const val = req.body[`phone_${idx}`];
      if (val !== undefined) t.phone = String(val).trim();
    });
    saveConfig(config);
    addLog('💾 Testers mobile numbers updated successfully.');
  }
  res.redirect('/');
});

// Manual Trigger
app.post('/trigger-now', async (req, res) => {
  addLog('⚡ Manual trigger initiated from Web Dashboard...');
  runReminderCycle(true);
  res.redirect('/');
});

// Health check endpoint for Cloud monitoring (e.g., Render / UptimeRobot)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    whatsapp: connectionStatus,
    timestamp: new Date().toISOString()
  });
});

// Start Server & Connect WhatsApp
app.listen(PORT, () => {
  console.log(`Artscrew WhatsApp Bot Web Dashboard listening on port ${PORT}`);
  connectToWhatsApp();
});
