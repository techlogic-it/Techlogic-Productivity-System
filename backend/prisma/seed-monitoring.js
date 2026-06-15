import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Starter catalogue of common Windows apps. processName is the executable as
// reported by the agent (stored upper-case). Admins refine these in the UI.
const APPS = [
  // Communication
  { processName: 'OUTLOOK.EXE', displayName: 'Outlook', category: 'COMMUNICATION', weight: 'NEUTRAL' },
  { processName: 'TEAMS.EXE', displayName: 'Microsoft Teams', category: 'COMMUNICATION', weight: 'NEUTRAL' },
  { processName: 'MS-TEAMS.EXE', displayName: 'Microsoft Teams (new)', category: 'COMMUNICATION', weight: 'NEUTRAL' },
  { processName: 'SLACK.EXE', displayName: 'Slack', category: 'COMMUNICATION', weight: 'NEUTRAL' },
  { processName: 'ZOOM.EXE', displayName: 'Zoom', category: 'COMMUNICATION', weight: 'NEUTRAL' },

  // Productive / Office
  { processName: 'EXCEL.EXE', displayName: 'Excel', category: 'PRODUCTIVE', weight: 'PRODUCTIVE' },
  { processName: 'WINWORD.EXE', displayName: 'Word', category: 'PRODUCTIVE', weight: 'PRODUCTIVE' },
  { processName: 'POWERPNT.EXE', displayName: 'PowerPoint', category: 'PRODUCTIVE', weight: 'PRODUCTIVE' },
  { processName: 'ONENOTE.EXE', displayName: 'OneNote', category: 'PRODUCTIVE', weight: 'PRODUCTIVE' },
  { processName: 'WINPROJ.EXE', displayName: 'Project', category: 'PRODUCTIVE', weight: 'PRODUCTIVE' },

  // Development
  { processName: 'CODE.EXE', displayName: 'VS Code', category: 'DEVELOPMENT', weight: 'PRODUCTIVE' },
  { processName: 'DEVENV.EXE', displayName: 'Visual Studio', category: 'DEVELOPMENT', weight: 'PRODUCTIVE' },
  { processName: 'WINDOWSTERMINAL.EXE', displayName: 'Windows Terminal', category: 'DEVELOPMENT', weight: 'PRODUCTIVE' },
  { processName: 'POWERSHELL.EXE', displayName: 'PowerShell', category: 'DEVELOPMENT', weight: 'PRODUCTIVE' },

  // Admin / back-office
  { processName: 'MMC.EXE', displayName: 'Microsoft Management Console', category: 'ADMIN_BACKOFFICE', weight: 'PRODUCTIVE' },

  // RMM / Support (remote management + remote-access tooling)
  { processName: 'MSTSC.EXE', displayName: 'Remote Desktop', category: 'RMM_SUPPORT', weight: 'PRODUCTIVE' },
  { processName: 'NINJARMMAGENT.EXE', displayName: 'NinjaOne Agent', category: 'RMM_SUPPORT', weight: 'PRODUCTIVE' },
  { processName: 'TEAMVIEWER.EXE', displayName: 'TeamViewer', category: 'RMM_SUPPORT', weight: 'PRODUCTIVE' },
  { processName: 'ANYDESK.EXE', displayName: 'AnyDesk', category: 'RMM_SUPPORT', weight: 'PRODUCTIVE' },

  // Research / browsers (neutral by default — context varies)
  { processName: 'CHROME.EXE', displayName: 'Google Chrome', category: 'RESEARCH', weight: 'NEUTRAL' },
  { processName: 'MSEDGE.EXE', displayName: 'Microsoft Edge', category: 'RESEARCH', weight: 'NEUTRAL' },
  { processName: 'FIREFOX.EXE', displayName: 'Firefox', category: 'RESEARCH', weight: 'NEUTRAL' },

  // Social
  { processName: 'WHATSAPP.EXE', displayName: 'WhatsApp', category: 'SOCIAL', weight: 'NON_PRODUCTIVE' },

  // Social / leisure (desktop apps — browser-based sites are matched by title later)
  { processName: 'DISCORD.EXE', displayName: 'Discord', category: 'SOCIAL', weight: 'NON_PRODUCTIVE' },
  { processName: 'TIKTOK.EXE', displayName: 'TikTok', category: 'SOCIAL', weight: 'NON_PRODUCTIVE' },
  { processName: 'TELEGRAM.EXE', displayName: 'Telegram', category: 'SOCIAL', weight: 'NON_PRODUCTIVE' },

  // Entertainment
  { processName: 'SPOTIFY.EXE', displayName: 'Spotify', category: 'ENTERTAINMENT', weight: 'NON_PRODUCTIVE' },
  { processName: 'VLC.EXE', displayName: 'VLC Media Player', category: 'ENTERTAINMENT', weight: 'NON_PRODUCTIVE' },
  { processName: 'STEAM.EXE', displayName: 'Steam', category: 'ENTERTAINMENT', weight: 'NON_PRODUCTIVE' },
  { processName: 'NETFLIX.EXE', displayName: 'Netflix', category: 'ENTERTAINMENT', weight: 'NON_PRODUCTIVE' },
  { processName: 'EPICGAMESLAUNCHER.EXE', displayName: 'Epic Games', category: 'ENTERTAINMENT', weight: 'NON_PRODUCTIVE' },
];

// Title/page keyword rules for browser-based sites (matched in the window title).
const TITLE_RULES = [
  { keyword: 'youtube', category: 'ENTERTAINMENT', weight: 'NON_PRODUCTIVE' },
  { keyword: 'netflix', category: 'ENTERTAINMENT', weight: 'NON_PRODUCTIVE' },
  { keyword: 'twitch', category: 'ENTERTAINMENT', weight: 'NON_PRODUCTIVE' },
  { keyword: 'facebook', category: 'SOCIAL', weight: 'NON_PRODUCTIVE' },
  { keyword: 'instagram', category: 'SOCIAL', weight: 'NON_PRODUCTIVE' },
  { keyword: 'tiktok', category: 'SOCIAL', weight: 'NON_PRODUCTIVE' },
  { keyword: 'reddit', category: 'SOCIAL', weight: 'NON_PRODUCTIVE' },
  { keyword: 'twitter', category: 'SOCIAL', weight: 'NON_PRODUCTIVE' },
];

async function main() {
  let created = 0, updated = 0;
  for (const app of APPS) {
    const res = await prisma.monitoredApp.upsert({
      where: { processName: app.processName },
      update: { displayName: app.displayName, category: app.category, weight: app.weight },
      create: app,
    });
    if (res.createdAt.getTime() === res.updatedAt.getTime()) created++; else updated++;
  }
  console.log(`Monitored app catalogue seeded: ${created} created, ${updated} updated (${APPS.length} total).`);

  let rulesCreated = 0;
  for (const rule of TITLE_RULES) {
    const res = await prisma.titleRule.upsert({
      where: { keyword: rule.keyword },
      update: {}, // don't clobber admin edits
      create: rule,
    });
    if (res.createdAt.getTime() === res.updatedAt.getTime()) rulesCreated++;
  }
  console.log(`Title rules seeded: ${rulesCreated} created (${TITLE_RULES.length} total).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
