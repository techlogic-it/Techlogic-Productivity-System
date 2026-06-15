import { execFileSync, execSync } from 'child_process';

// Foreground-app + window-title + idle sampling. This is the ONE platform-specific
// module. The reference build implements macOS; the production Windows agent
// replaces it with Win32 calls (see README):
//   - foreground app : GetForegroundWindow → GetWindowThreadProcessId → process name
//   - window title   : GetWindowText
//   - idle seconds   : GetLastInputInfo (ticks since last input)

const APPLESCRIPT = [
  'tell application "System Events"',
  '  set p to first application process whose frontmost is true',
  '  set appName to name of p',
  '  set winTitle to ""',
  '  try',
  '    set winTitle to value of attribute "AXTitle" of front window of p',
  '  end try',
  '  return appName & "||" & winTitle',
  'end tell',
];

export function getForeground() {
  if (process.platform !== 'darwin') {
    return { processName: 'unknown', windowTitle: null };
  }
  try {
    const args = APPLESCRIPT.flatMap((line) => ['-e', line]);
    const out = execFileSync('osascript', args, { encoding: 'utf8', timeout: 4000 }).trim();
    const [appName, winTitle] = out.split('||');
    // Normalise to a process-name-like key (the catalogue matches upper-cased).
    return { processName: (appName || 'unknown').toUpperCase(), windowTitle: winTitle || null };
  } catch {
    return { processName: 'unknown', windowTitle: null };
  }
}

export function getIdleSec() {
  if (process.platform !== 'darwin') return 0;
  try {
    const ns = execSync("ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF; exit}'", {
      encoding: 'utf8', timeout: 4000,
    }).trim();
    return Math.floor(Number(ns) / 1e9) || 0;
  } catch {
    return 0;
  }
}
