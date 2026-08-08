OptiFleet AI Agent - GLOBAL deployment package
==================================================

Installs the agent on ANY Windows machine, ANYWHERE with an internet
connection - not just the office LAN. Points at the central server's public
VPS at 27.254.142.51.

Once installed, this machine becomes remotely controllable from that
server's dashboard (https://27.254.142.51) - only install this on machines
you intend to manage.

Why this works from anywhere (no VPN, no port forwarding):
The agent always makes the OUTBOUND connection to the server, never the
other way around - the same way a browser tab connects out to a website.
Any normal internet connection (home Wi-Fi, mobile hotspot, another
office, another country) already allows that kind of outbound HTTPS/WSS
traffic. Nothing needs to be opened on the target machine's own firewall
or router for this to work.

Requirements on the TARGET machine:
- Windows 10/11, any internet connection
- Administrator access

Easiest way:
1. Copy this whole folder (or the zip) to the target machine - all 6 files
   must end up together in the same folder; don't cherry-pick just the .exe.
2. Double-click RUN-ME.bat.
3. Click "Yes" on the one Windows admin permission prompt (unavoidable -
   installing any Windows service requires this; nothing after that needs
   another click).
4. A window shows install progress and pauses at the end so you can read it
   (whether it succeeds or fails) - press Enter to close it once you've
   read the result.
5. On the dashboard (https://27.254.142.51), the new device should appear
   online within a few seconds, and its real public IP / approximate
   location will show up on the "Live Tracking" page (this agent
   self-reports its own public IP rather than relying on the server's view
   of the connection, so this works correctly no matter where the machine
   physically is).

Manual way (if you'd rather run it yourself from PowerShell):
1. Right-click PowerShell -> "Run as Administrator".
2. cd into this folder, then run:
     Set-ExecutionPolicy -Scope Process Bypass -Force
     .\install.ps1
3. Confirm it's running:
     Get-Service OptiFleetAIAgent

If the service doesn't stay running after install, check
C:\ProgramData\OptiFleetAgent\logs\agent.log (the agent's own log) and
C:\ProgramData\OptiFleetAgent\logs\service-stderr.log (raw crash output, if
it died before its own logger even started) for the actual error.

About antivirus (read this if the install seems to silently do nothing):
- The agent .exe has no certificate from a recognized public Certificate
  Authority - getting one requires an organization to purchase and verify
  one, which isn't something this package can include. That makes an
  unsigned binary that installs a Windows Service look, to antivirus
  heuristics, like dropper/trojan behavior - on real test machines this got
  the .exe silently deleted moments after it ran, with no visible error at
  all.
- Two mitigations are already built into this package:
  1. install.ps1 uses NSSM (bundled nssm.exe) to register the service,
     rather than the agent binary elevating and installing itself - a much
     less suspicious pattern, and the same one this project's own dev
     machine already runs without issue.
  2. optifleet-agent.exe is signed with a self-signed code-signing
     certificate. This is NOT the same as a trusted CA certificate - Windows
     will still show it as an "Unknown Publisher" - but it does mean the
     file isn't flagged as *entirely* unsigned, which some antivirus/policy
     rules check for specifically.
  3. install.ps1 also adds a Windows Defender exclusion for the install
     folder automatically. This only affects Microsoft Defender - if the
     target machine runs a different, centrally-managed corporate
     antivirus/EDR product, that exclusion does nothing, and getting this
     allowlisted has to go through whoever administers that product.
- None of this guarantees antivirus won't still block it. If install.ps1
  reports success but the service disappears again shortly after (check
  with `Get-Service OptiFleetAIAgent` and `Test-Path
  C:\ProgramData\OptiFleetAgent\optifleet-agent.exe` a minute or two later),
  that's what's happening, and the real fix is either a real code-signing
  certificate or an explicit allowlist entry from that machine's antivirus
  administrator.

Security notes (read before handing this folder to anyone):
- OPTIFLEET_AUTH_TOKEN / OPTIFLEET_HMAC_SECRET are baked into install.ps1
  as the REAL production secrets that match the VPS's server/.env - unlike
  the earlier LAN test package, these are not placeholders. Anyone with a
  copy of this folder can register an agent against the real server, so
  distribute it only to machines you actually intend to manage, and rotate
  both secrets (here and in the VPS's /opt/optifleet/server/.env) if this
  folder is ever lost, shared too widely, or a machine running it is
  decommissioned.
- optifleet-cert.pem is a self-signed TLS certificate generated for the VPS
  IP (27.254.142.51) - not a real CA certificate, and a separate thing from
  the code-signing certificate on the .exe above. The agent trusts it via
  ca_cert_path in agent.yaml; there's no browser involved on this side, so
  there's no "click through a warning" step like there is when visiting the
  dashboard in a browser for the first time.
- If you switch the VPS from its bare IP to a real domain with a
  Let's-Encrypt-issued certificate later, this whole cert-trust step goes
  away - update server.url in agent.yaml to the new wss://domain:8443/ and
  you can leave ca_cert_path blank (a real CA cert is trusted automatically).
- To uninstall: from an elevated PowerShell,
    C:\ProgramData\OptiFleetAgent\nssm.exe stop OptiFleetAIAgent
    C:\ProgramData\OptiFleetAgent\nssm.exe remove OptiFleetAIAgent confirm
  then delete C:\ProgramData\OptiFleetAgent.
