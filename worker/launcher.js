// worker/launcher.js
// Entry point for the packaged desktop app (AISongEngineWorker.exe).
//
// Goal: the user downloads ONE file, double-clicks it, pastes their REDIS_URL
// once, and the worker runs forever after. No Node install, no npm, no editing
// config files by hand.
//
// Config is looked up in this order:
//   1. REDIS_URL environment variable
//   2. .env next to the executable
//   3. config.json next to the executable  (what the wizard writes)
//   4. interactive first-run prompt -> saved to config.json

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// When packaged, process.execPath is the .exe; otherwise use this folder.
const IS_PACKAGED = Boolean(process.pkg);
const APP_DIR = IS_PACKAGED ? path.dirname(process.execPath) : __dirname;
const CONFIG_FILE = path.join(APP_DIR, 'config.json');
const ENV_FILE = path.join(APP_DIR, '.env');

function line(char = '─', n = 52) {
  return '  ' + char.repeat(n);
}

function banner() {
  console.log('');
  console.log('  🎵  AI SONG ENGINE — WORKER');
  console.log(line('═'));
}

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  try {
    for (const raw of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const s = raw.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i < 1) continue;
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  } catch (_) {
    /* ignore a malformed .env */
  }
}

function loadConfigFile() {
  if (!fs.existsSync(CONFIG_FILE)) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    for (const [k, v] of Object.entries(cfg)) {
      if (v && !process.env[k]) process.env[k] = String(v);
    }
  } catch (_) {
    /* ignore a corrupt config.json - the wizard will rewrite it */
  }
}

function saveConfig(patch) {
  let cfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (_) {}
  }
  Object.assign(cfg, patch);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

const looksLikeRedisUrl = (v) => /^rediss?:\/\/.+@.+:\d+/.test(String(v || '').trim());

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function firstRunWizard() {
  console.log('');
  console.log('  Welcome! This is a one-time setup.');
  console.log('');
  console.log('  I need your REDIS_URL so this app can talk to your dashboard.');
  console.log('  Where to find it:');
  console.log('    1. Open  vercel.com  and pick your ai-song-engine project');
  console.log('    2. Settings  ->  Environment Variables');
  console.log('    3. Find REDIS_URL, click the eye icon, copy the whole value');
  console.log('');
  console.log('  (Tip: right-click in this window to paste.)');
  console.log('');

  for (let attempt = 0; attempt < 5; attempt++) {
    const answer = (await ask('  Paste REDIS_URL here: ')).trim();
    if (!answer) continue;
    if (!looksLikeRedisUrl(answer)) {
      console.log('  ✗ That does not look like a Redis URL.');
      console.log('    It should start with rediss:// and contain a host and port.');
      console.log('');
      continue;
    }
    saveConfig({ REDIS_URL: answer });
    process.env.REDIS_URL = answer;
    console.log('');
    console.log(`  ✓ Saved to ${CONFIG_FILE}`);
    console.log('    (Next time this app starts straight away.)');
    console.log('');
    return true;
  }

  console.log('');
  console.log('  Could not read a valid REDIS_URL. Closing.');
  return false;
}

function keepWindowOpen(message) {
  console.log('');
  console.log(`  ${message}`);
  console.log('  Press Enter to close this window.');
  try {
    // Block so a double-clicked window doesn't vanish before it can be read.
    require('child_process').execSync('pause > nul', { shell: 'cmd.exe', stdio: 'inherit' });
  } catch (_) {
    try { fs.readSync(0, Buffer.alloc(1), 0, 1, null); } catch (_) {}
  }
}

(async function main() {
  banner();
  loadEnvFile();
  loadConfigFile();

  if (!process.env.REDIS_URL) {
    const ok = await firstRunWizard();
    if (!ok) return keepWindowOpen('Setup was not completed.');
  }

  try {
    require('./server.js'); // starts the HTTP health server + the queue loop
  } catch (e) {
    console.error('');
    console.error('  ✗ The worker failed to start:');
    console.error(`    ${e && e.message ? e.message : e}`);
    keepWindowOpen('Fix the problem above and run this app again.');
  }
})();
