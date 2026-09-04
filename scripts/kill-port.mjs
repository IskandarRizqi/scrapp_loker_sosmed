import { execSync } from 'node:child_process';

const PORT = process.env.PORT || '3000';
const isWin = process.platform === 'win32';

let stdout = '';
try {
  if (isWin) {
    stdout = execSync('netstat -ano', { encoding: 'utf8' });
  } else {
    stdout = execSync(`lsof -ti:${PORT}`, { encoding: 'utf8' });
  }
} catch {
  process.exit(0);
}

const pids = new Set();
if (isWin) {
  const winRe = new RegExp(`^\\S+\\s+(\\S*):${PORT}\\s+\\S+\\s+LISTENING\\s+(\\d+)$`);
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.trim().match(winRe);
    if (m && m[2]) pids.add(m[2]);
  }
} else {
  for (const line of stdout.split(/\r?\n/)) {
    const pid = line.trim();
    if (/^\d+$/.test(pid)) pids.add(pid);
  }
}

for (const pid of pids) {
  try {
    if (isWin) execSync(`taskkill /F /PID ${pid}`, { stdio: 'inherit' });
    else execSync(`kill -9 ${pid}`, { stdio: 'inherit' });
    console.log(`[predev] Port ${PORT} dibebaskan dari PID ${pid}.`);
  } catch {
    // ignore: process may already be gone
  }
}
