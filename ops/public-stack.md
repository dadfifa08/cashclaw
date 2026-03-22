# Cateo Public Stack

## Stable Tunnel Mode

Cateo now supports a stable Cloudflare named tunnel for the public site bridge.

### Exact Cutover Commands

Run these on the host **after** `cloudflared tunnel login` succeeds or once you have a named tunnel run token from Cloudflare:

```powershell
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel login
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel create cateo-public-bridge
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel route dns cateo-public-bridge bridge.cateo.org
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel token cateo-public-bridge
```

Set the token and stable URL on the host:

```powershell
$env:CATEO_CLOUDFLARE_TUNNEL_TOKEN='<paste-the-token-output-here>'
$env:CATEO_PUBLIC_BACKEND_URL='https://bridge.cateo.org'
pwsh -File .\ops\start-public-stack.ps1 -WebsiteRoot C:\Users\dadfi\Projects\cateo
```

If you already created the tunnel in Cloudflare and only have the run token, skip the `tunnel login/create/route dns` commands and set the two environment variables directly before running `start-public-stack.ps1`.

Set these environment variables on the host machine before running `ops/start-public-stack.ps1`:

- `CATEO_CLOUDFLARE_TUNNEL_TOKEN`: the Cloudflare named tunnel run token.
- `CATEO_PUBLIC_BACKEND_URL`: the stable public bridge URL, for example `https://bridge.cateo.org`.

Then run:

```powershell
pwsh -File .\ops\start-public-stack.ps1 -WebsiteRoot C:\Users\dadfi\Projects\cateo
```

The script will:

1. Start the local site bridge on loopback.
2. Start `cloudflared` in named tunnel mode.
3. Verify the public bridge health endpoint.
4. Update `CATEO_BACKEND_URL` in Vercel production when the public URL changes.

## Quick Tunnel Fallback

If no named tunnel token is present, the script falls back to a temporary `trycloudflare.com` quick tunnel.

## Always-On Watchdog

Install the watchdog scheduled task with:

```powershell
pwsh -File .\ops\install-public-stack-task.ps1 -WebsiteRoot C:\Users\dadfi\Projects\cateo
```

If you are using a named tunnel and want the task definition to pin the public URL explicitly:

```powershell
pwsh -File .\ops\install-public-stack-task.ps1 -WebsiteRoot C:\Users\dadfi\Projects\cateo -PublicUrl https://bridge.cateo.org
```

## Dedicated Host

If you need stronger uptime than a workstation can provide, move these components to an always-on host:

- `npm run site:bridge`
- `cloudflared`
- Ollama with the Cateo model set

A small VM or dedicated Windows mini-PC is enough if the local models fit the hardware profile.
