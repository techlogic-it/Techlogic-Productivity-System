# Windows agent — quick try

Self-contained test build. **No .NET install needed** on the Windows machine.

> ⚠️ This build **compiles and mirrors the verified protocol**, but has **not been
> runtime-tested on Windows** (it was cross-built from macOS). You are the first
> run — expect to report back. Not code-signed.

## 1. Copy the exe
Copy `publish\ProductivityAgent.exe` to the Windows machine (e.g. `C:\agent\`).

## 2. Make sure it can reach the backend
The agent talks to the product backend over HTTP. `--server` must be a URL the
**Windows machine** can reach — `localhost` only works if the backend runs on that
same PC. For the current dev setup the backend is on the Mac at:

```
http://<MAC-LAN-IP>:3001
```

The Windows box must be on the **same network** as the Mac, and macOS may prompt to
allow incoming connections to `node` (allow it). Test from Windows first:
`curl http://<MAC-LAN-IP>:3001/api/portal/auth/login` should answer (405/400 is fine
— it means reachable).

## 3. Run it
Open **Command Prompt** / **PowerShell** in the exe's folder.

```bat
:: One enrol + capture + upload, then exit (quick smoke test)
ProductivityAgent.exe --once --server http://<MAC-LAN-IP>:3001 --key <ENROLMENT_KEY>

:: Continuous monitoring (Ctrl-C to stop)
ProductivityAgent.exe --server http://<MAC-LAN-IP>:3001 --key <ENROLMENT_KEY>

:: Assigned laptop pre-created in the dashboard (claim code → that person's group)
ProductivityAgent.exe --server http://<MAC-LAN-IP>:3001 --key <KEY> --claim AB12-CD34
```

On first run it enrols and writes `agent.state.json` (deviceId + token) next to the
exe. Delete that file to force re-enrolment.

- **Windows SmartScreen** may say "Windows protected your PC" → *More info → Run
  anyway* (it's unsigned).
- The agent prints a line per cycle, e.g. `uploaded 3 event(s)`.

## 4. See the data
In the portal (**http://<MAC-LAN-IP>:5173/portal/login**, `demo@demo.local` /
`Demo-Pass-2026!`) → **People**: the Windows machine's signed-in user appears under
the key's default group (**Operations** for the test key), status **UNMAPPED**.
Open their report for the timeline. Map them to a name/group to "claim" them.

## Notes for production (not in this test build)
DPAPI-encrypt the token, store state under `%ProgramData%`, run as a **Windows
Service** (or per-user scheduled task on VDI), and package as **MSI/Win32** for
Intune with silent params: `msiexec /i Agent.msi SERVER=… KEY=… /qn`. See
[../agent/README.md](../agent/README.md).
