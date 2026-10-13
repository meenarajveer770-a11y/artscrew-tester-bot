const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'testers_config.json');
const AUTH_DIR = path.join(__dirname, 'auth_session');
const API_URL = 'https://artscrew.pages.dev/api/testers';
const WA_CLOUD_SECRET = process.env.WA_CLOUD_SECRET || 'artscrew_wa_cloud_2026_secret';

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Config read error:', e);
  }
  return {
    apiEndpoint: API_URL,
    checkIntervalMinutes: 60,
    dailyTargetSeconds: 600,
    activeHoursIst: { start: 11, end: 23 },
    testers: []
  };
}

function formatDuration(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s < 10 ? '0' + s : s}s`;
}

function formatJid(phone) {
  let clean = String(phone || '').replace(/[^0-9]/g, '');
  if (clean.length === 10) clean = '91' + clean;
  return clean ? `${clean}@s.whatsapp.net` : null;
}

// Download session files & lastRemindedTimes from Cloudflare R2
async function pullCloudState() {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ action: 'get_cloud_state', secret: WA_CLOUD_SECRET })
    });
    const data = await res.json();
    if (data && data.success) {
      if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
      const files = data.sessionFiles || {};
      const fileKeys = Object.keys(files);
      if (fileKeys.length > 0) {
        for (const fname of fileKeys) {
          const safeName = path.basename(fname);
          fs.writeFileSync(path.join(AUTH_DIR, safeName), files[fname], 'utf8');
        }
        console.log(`☁️ Restored ${fileKeys.length} WhatsApp session files from Cloudflare R2.`);
      }
      return data.lastRemindedTimes || {};
    }
  } catch (err) {
    console.error('⚠️ Failed to pull cloud state from R2:', err.message);
  }
  return {};
}

// Upload current session files & lastRemindedTimes to Cloudflare R2
async function pushCloudState(lastRemindedTimes) {
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
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'save_cloud_state',
        secret: WA_CLOUD_SECRET,
        sessionFiles,
        lastRemindedTimes
      })
    });
    const data = await res.json();
    if (data && data.success) {
      console.log(`☁️ Synced ${Object.keys(sessionFiles).length} WhatsApp session files & reminder timestamps to Cloudflare R2.`);
    }
  } catch (err) {
    console.error('⚠️ Failed to push cloud state to R2:', err.message);
  }
}

async function main() {
  const isForce = process.argv.includes('--force');
  const isSyncOnly = process.argv.includes('--sync-only');

  const config = loadConfig();

  if (isSyncOnly) {
    console.log('☁️ Uploading local WhatsApp auth_session to Cloudflare R2...');
    const seededTimes = {};
    const nowSeed = Date.now();
    (config.testers || []).forEach(t => {
      if (t.name) seededTimes[t.name.trim()] = nowSeed;
    });
    await pushCloudState(seededTimes);
    await delay(300);
    process.exit(0);
  }

  // Check IST active hours (11:00 AM - 11:00 PM IST)
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const istDate = new Date(utc + (3600000 * 5.5));
  const currentHourIst = istDate.getHours();
  const startHour = config.activeHoursIst ? config.activeHoursIst.start : 11;
  const endHour = config.activeHoursIst ? config.activeHoursIst.end : 23;

  if (!isForce && (currentHourIst < startHour || currentHourIst >= endHour)) {
    console.log(`🌙 Quiet Hours (${currentHourIst}:00 IST). Active between ${startHour}:00 - ${endHour}:00 IST. Exiting.`);
    process.exit(0);
  }

  // 1. Pull latest session & reminder timestamps from R2
  const lastRemindedTimes = await pullCloudState();

  // 2. Connect to WhatsApp with Signal retry cache (prevents 'Waiting for this message')
  const sentMessagesCache = new Map();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const sock = makeWASocket({
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

  const connected = await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), 30000);
    sock.ev.on('connection.update', (update) => {
      const { connection } = update;
      if (connection === 'open') {
        clearTimeout(timeout);
        resolve(true);
      } else if (connection === 'close') {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          clearTimeout(timeout);
          resolve(false);
        }
      }
    });
  });

  if (!connected) {
    console.error('❌ Could not establish WhatsApp connection within 30s.');
    process.exit(1);
  }

  console.log('✅ WhatsApp Connected in Cloud! Checking live tester progress...');
  await delay(2500);

  // 3. Fetch live tester stats
  const res = await fetch(config.apiEndpoint || API_URL, { headers: { 'Cache-Control': 'no-cache' } });
  const data = await res.json();
  if (!data || !data.success || !Array.isArray(data.testers)) {
    console.error('❌ Invalid tester API response');
    process.exit(1);
  }

  const phoneMap = {};
  (config.testers || []).forEach(t => {
    if (t.name && t.phone) phoneMap[t.name.trim()] = t.phone.trim();
  });

  const nowTs = Date.now();
  const intervalMins = Number(config.checkIntervalMinutes) || 60;
  const intervalMs = Math.max(30, intervalMins - 12) * 60 * 1000; // 48m tolerance for hourly cron
  let sentCount = 0;
  let skippedCount = 0;

  for (const apiTester of data.testers) {
    const name = apiTester.name;
    const todaySeconds = apiTester.todaySeconds || 0;
    const hasCompleted = apiTester.hasReachedTarget || (todaySeconds >= 600);

    if (hasCompleted) continue;

    const lastReminded = lastRemindedTimes[name] || 0;
    if (!isForce && (nowTs - lastReminded < intervalMs)) {
      skippedCount++;
      continue;
    }

    const phone = phoneMap[name];
    const jid = formatJid(phone);
    if (!jid) continue;

    const remainingSec = Math.max(0, 600 - todaySeconds);
    const usedFormatted = formatDuration(todaySeconds);
    const remainingFormatted = formatDuration(remainingSec);

    const reminderMessage = `Hey ${name}! 👋\n\nGoogle Play closed testing ke liye aaj Artscrew app 10 minute use karna compulsory hai.\n\n📊 *Aapka Aaj Ka Record:*\n⏱️ App use hua: *${usedFormatted}* (10 min me se)\n⏳ Target bacha hai: *${remainingFormatted}* baaki hai\n\n💡 *Tip:* App khol kar thoda sa scroll ya drawing canvas/tutorial open karke 1-2 line draw kar lena aur screen lock mat hone dena, taaki Google Play par attendance 100% count ho sake 🙏\n\n(Note: Jaise hi aapke 10 minute complete honge, reminders aana auto-stop ho jayega).`;

    try {
      const sentMsg = await sock.sendMessage(jid, { text: reminderMessage });
      if (sentMsg && sentMsg.key && sentMsg.key.id) {
        sentMessagesCache.set(sentMsg.key.id, sentMsg.message || { conversation: reminderMessage });
      }
      lastRemindedTimes[name] = Date.now();
      sentCount++;
      console.log(`✅ Cloud Reminder sent to ${name} (${phone}) - Today: ${usedFormatted}/10m`);
      await delay(Math.floor(Math.random() * 3000) + 4000);
    } catch (err) {
      console.error(`❌ Failed to send to ${name}:`, err.message);
    }
  }

  console.log(`🏁 Cloud Reminder cycle finished. Sent: ${sentCount}, Skipped: ${skippedCount}`);

  // 4. Wait 15s if messages were sent so Signal retry receipts from phones are fulfilled cleanly
  if (sentCount > 0) {
    console.log('⏳ Waiting 15s to fulfill any Signal encryption retry receipts...');
    await delay(15000);
  } else {
    await delay(2000);
  }
  await pushCloudState(lastRemindedTimes);
  await delay(300);
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
