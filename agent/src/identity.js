import os from 'os';
import { execFileSync } from 'child_process';

// The monitored person's identity = the OS account. The server keys employees on
// (organisationId, localAccountKey), so this must be STABLE per user on a device.
//
//   Reference (macOS/Linux): localAccountKey = login username.
//   Production (Windows):     localAccountKey = the user's SID
//                             (e.g. S-1-5-21-…), obtained from the token. The SID
//                             is immutable even if the account is renamed — use it
//                             in preference to the username.

export function getIdentity() {
  const username = os.userInfo().username;
  let displayName = username;
  if (process.platform === 'darwin') {
    try { displayName = execFileSync('id', ['-F'], { encoding: 'utf8' }).trim() || username; }
    catch { /* keep username */ }
  }
  return {
    localAccountKey: username, // Windows: replace with the user SID
    displayName,
    deviceName: os.hostname(),
  };
}
