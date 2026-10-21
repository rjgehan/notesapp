# Installing NotesApp on CasaOS

This is the short path for a CasaOS server: one compose file pasted into the CasaOS UI, no `.env` and no SSH required. [DEPLOY.md](DEPLOY.md) is the full runbook (plain Docker Compose, backups, rollback, troubleshooting); everything it says about Tailscale, Watchtower and the app applies here too.

The file is [`deploy/casaos-compose.yml`](../deploy/casaos-compose.yml). It runs three containers:

| Container | Job |
|---|---|
| `notesapp-tailscale` | Joins your tailnet as the machine `notes` and serves `https://notes.<tailnet>.ts.net` (HTTPS certificate included) |
| `notesapp` | The app. It shares the Tailscale container's network, so it has **no LAN port** and is reachable only over the tailnet |
| `notesapp-watchtower` | Checks GHCR every 5 minutes and restarts `notesapp` when a new image is pushed to `main` |

Data lives in `/DATA/AppData/notesapp/`: `data/vault` holds your notes, and `tailscale/` holds the node identity and certificates (never delete it).

## 1. One-time Tailscale setup (admin console)

1. **DNS** page: turn on **MagicDNS** and **HTTPS Certificates**.
2. **Access controls**: add a tag owner so the server can tag itself:
   ```json
   "tagOwners": { "tag:notes": ["autogroup:admin"] }
   ```
3. **Settings → Keys → Generate auth key**: Reusable **off**, Ephemeral **off**, Pre-approved **on**, Tags **tag:notes**. Copy the `tskey-auth-…` value.

Tagged machines don't expire, so the key is used once; after the first start you can blank `TS_AUTHKEY` in the app's settings.

## 2. Make the image pullable

Pushes from the private repo create a **private** package, and CasaOS cannot log in to GHCR from the UI. Pick one:

- **Recommended: make the package public.** It only contains the app, never your notes. GitHub → your profile → **Packages → notesapp → Package settings → Change visibility → Public**. Nothing else to configure.
- **Keep it private.** Create a classic GitHub token with only `read:packages` and no expiry, then on the server run `docker login ghcr.io -u rjgehan` once (paste the token as the password). Also uncomment `REPO_USER` / `REPO_PASS` in the `watchtower` service so updates can be pulled.

## 3. Install

1. Fill in the placeholders in the compose file:
   - `TS_AUTHKEY`: the key from step 1.3.
   - `notes.CHANGE-ME.ts.net` (four places): your tailnet's MagicDNS name, e.g. `notes.tail1234.ts.net`.
   - `NOTES_IDENTITY_ALLOWED_LOGINS`: your Tailscale login (the email shown in the admin console).
2. CasaOS → **App Store → Custom Install** (the `+` at the top right) → **Import** → paste the file → **Submit**, then **Install**.
3. Wait about a minute. The `notes` machine appears in the Tailscale admin console and the CasaOS tile turns green.
4. Open `https://notes.<tailnet>.ts.net` on any tailnet device, including the iPhone (Safari → Share → Add to Home Screen for an app icon). The first visit can take ~30 s while the HTTPS certificate is issued.

## Updating

Push to `main`. CI builds and publishes the image, and Watchtower restarts `notesapp` within about 5 minutes. To update Tailscale or Watchtower themselves, use the CasaOS app's **Update** or **Rebuild**.

## If something is wrong

| Symptom | Check |
|---|---|
| `notesapp` keeps restarting | CasaOS → app → **Logs**. `NOTES_ALLOWED_HOSTS ... must list` means a placeholder wasn't replaced. `No kernel-mode Tailscale interface` means `/dev/net/tun` is missing on the host. |
| Image pull fails with `denied` / `unauthorized` | The package is still private and the server isn't logged in to GHCR (step 2). |
| `403` in the browser | Your Tailscale login doesn't match `NOTES_IDENTITY_ALLOWED_LOGINS`, or you're on a tagged device. |
| `421` in the browser | The host name you opened doesn't match `NOTES_ALLOWED_HOSTS`. |
| `notes` never appears in Tailscale | The auth key was wrong, already used, or `tag:notes` has no tag owner. Generate a new key and **Rebuild** the app. |
| Certificate warning | HTTPS Certificates aren't enabled in the tailnet's DNS settings. |
| `502 Bad Gateway` after a Tailscale restart | The app reconnects on its own within a minute; if not, restart the CasaOS app. |
