# NotesApp: deployment runbook

This runbook takes a fresh Linux `homeserver` to a running NotesApp at `https://notes.<tailnet>.ts.net`. Follow Part 1 top to bottom once. Parts 2 and 3 cover day-to-day operations and troubleshooting. The reasoning behind each choice is in [DESIGN.md](DESIGN.md) §2 and §7.

**Placeholders.** Replace these wherever they appear:

| Placeholder | Meaning | Where to find it |
|---|---|---|
| `<tailnet>` | Your tailnet's DNS name, the `tail1234` in `tail1234.ts.net` | Tailscale admin console → [DNS](https://login.tailscale.com/admin/dns) → Tailnet name |
| `you@example.com` | Your Tailscale login (GitHub sign-ins look like `name@github`) | Admin console → [Users](https://login.tailscale.com/admin/users) |
| `<github-user>` | The GitHub account that owns the repository (`rjgehan`) | |
| `notes-<hex>` | Your private ntfy topic (step 7) | |

**Conventions.** `sh` blocks run on `homeserver` as your normal login user, uid 1000, which is a member of the `docker` group. `powershell` blocks run on `rgpc`. From step 3 on, `docker compose` commands run in `~/notesapp/deploy`.

---

## Part 1: First deploy

### 1. GitHub: repository, first image and pull token

**1.1 Make the first commit, create the private repository and push** (rgpc):

```powershell
cd C:\development\NotesApp
git status --short --ignored   # deploy/.env and dev-vault/, if present, must show as ignored (!!), never as untracked (??)
git add -A
git commit -m "NotesApp v1"    # the first commit; "nothing to commit" is fine if everything is already committed
gh repo create rjgehan/notesapp --private --source . --remote origin
git push -u origin main
gh run watch        # pick the CI run: backend, frontend and publish / image must all go green
```

`git push` needs at least one commit on `main`; without it, it fails with `src refspec main does not match any` and no CI run starts. Never commit `deploy/.env` (secrets) or `dev-vault/` (your local test notes); `.gitignore` excludes both, which is what the `git status` check confirms.

This push is the first real build of the Dockerfile, because rgpc has no Docker. If a job fails, fix it and push again; nothing reaches the server until `publish` succeeds.

**1.2 Check the package.** Open <https://github.com/users/rjgehan/packages/container/package/notesapp>. It shows the tags `latest` and `sha-<7 hex>`, it is linked to `rjgehan/notesapp`, and its visibility is **Private** (packages pushed from a private repository start private). Keep it private. Step 8 checks that both architectures are there.

**1.3 Create the pull token.** Open <https://github.com/settings/tokens/new?scopes=read:packages&description=homeserver%20GHCR%20pull> (a **classic** token; the scope is pre-selected):

- Expiration: **No expiration.** An expired token would stop deploys silently.
- Scopes: only `read:packages`.

Generate it and keep it in your password manager; step 8 and the token rotation in Part 2 need it. Fine-grained tokens do not work with GitHub Packages. With only this scope, the token can read packages and nothing else.

Private repositories use your account's included Actions minutes. The weekly rebuild and Dependabot's PRs count towards them.

### 2. homeserver prerequisites

```sh
docker version --format 'Engine {{.Server.Version}}'   # 29.x
docker compose version                                  # v5.x
uname -m                                                # x86_64 or aarch64 (both images are published)
ls -l /dev/net/tun                                      # crw-rw-rw- ... 10, 200 ... /dev/net/tun
id -u; id -nG                                           # 1000, and the groups include docker
docker info --format '{{.LoggingDriver}}'               # usually json-file (see below)
df -h /srv                                              # room for the vault, its history and attachments
```

- **`/dev/net/tun` missing:** `sudo modprobe tun && echo tun | sudo tee /etc/modules-load.d/tun.conf`. The Tailscale container needs it for kernel mode, which is mandatory (DESIGN §2.4).
- **Not in the `docker` group:** `sudo usermod -aG docker "$USER"`, then log out and back in.
- **Your uid is not 1000:** that works, but the app runs as uid 1000 and owns the vault, so edit vault files with `sudo -u '#1000' …` (Part 2, *Editing the vault over SSH*).
- **Logging driver:** the compose file gives all three containers the `local` driver with rotation (5 × 10 MB), whatever the daemon default is. If the default is `json-file`, other containers on this host grow their logs without limit on the same disk; consider setting `log-driver` in `/etc/docker/daemon.json`.

**Raise the inotify limit.** The app watches every vault folder, and inotify limits are per real uid, so it shares them with uid 1000's editors and sync tools. When it runs out, the app falls back to a rescan every 5 minutes.

```sh
sysctl fs.inotify.max_user_watches
echo 'fs.inotify.max_user_watches=524288' | sudo tee /etc/sysctl.d/60-notesapp-inotify.conf
sudo sysctl --system > /dev/null && sysctl fs.inotify.max_user_watches   # 524288
```

### 3. Put the deploy files on homeserver

The server pulls `deploy/` from the repository with a **read-only deploy key**, so later changes arrive with `git pull`.

```sh
ssh-keygen -t ed25519 -N '' -C 'homeserver notesapp deploy key' -f ~/.ssh/notesapp_deploy
cat ~/.ssh/notesapp_deploy.pub
```

On GitHub: **rjgehan/notesapp → Settings → Deploy keys → Add deploy key**. Title `homeserver`, paste the public key, leave **Allow write access** unchecked.

```sh
cat >> ~/.ssh/config <<'EOF'
Host github-notesapp
  HostName github.com
  User git
  IdentityFile ~/.ssh/notesapp_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
git clone git@github-notesapp:rjgehan/notesapp.git ~/notesapp
cd ~/notesapp/deploy && ls -A        # .env.example  docker-compose.yml  tailscale
```

The first connection asks you to confirm GitHub's host key; compare it with [GitHub's published fingerprints](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints).

### 4. Create the volumes (once)

```sh
sudo install -d -o 1000 -g 1000 /srv/notes/data /srv/notes/data/vault /srv/notes/data/.config
docker volume create --driver local --opt type=none --opt o=bind --opt device=/srv/notes/data notes-data
docker volume create tailscale-state
docker volume ls --filter name=notes-data --filter name=tailscale-state
```

- Both volumes are declared `external: true`, so Compose never creates or deletes them. `docker compose down -v` deletes every volume a compose file owns; with external volumes it cannot take the vault, its history or the Tailscale identity with it.
- `notes-data` is **bind-backed**: the vault is the plain directory `/srv/notes/data/vault` on the host, which makes backups, inspection and editing over SSH simple.
- `tailscale-state` holds the node's identity and TLS certificate. **Never delete it.** A lost state creates a new node (`notes-1`, a different URL) and requests new certificates, and Let's Encrypt rate limits can then lock you out for about 34 hours.

**Optional: import an existing Obsidian vault** now, before the first start, so that NotesApp takes over its settings (Part 2, *Import an Obsidian vault*, has the details and the checks afterwards):

```sh
sudo cp -a /path/to/MyVault/. /srv/notes/data/vault/
sudo chown -R 1000:1000 /srv/notes/data/vault
```

The app serves immediately and commits `Import existing vault (N files)` in the background (`git.state: importing` in `/api/status` until it finishes); no welcome note is written. An imported `.git` is kept, but its hooks never run, and a git-lfs repository gets history disabled.

### 5. Tailscale admin console

1. **[DNS](https://login.tailscale.com/admin/dns):** MagicDNS enabled, and under **HTTPS Certificates** click **Enable**. Note the tailnet name.
2. **[Access controls](https://login.tailscale.com/admin/acls/file):** declare the tag. This is required: an auth key can only carry a tag that has an owner. Add to the top-level object (or add the line to an existing `tagOwners` block):
   ```jsonc
   "tagOwners": {
     "tag:notes": ["autogroup:admin"],
   },
   ```
3. **[Machines](https://login.tailscale.com/admin/machines):** if a machine called `notes` already exists (from an earlier attempt), remove it now, or the new node becomes `notes-1`.
4. **[Keys](https://login.tailscale.com/admin/settings/keys) → Generate auth key:**
   - Description `notes on homeserver`
   - Reusable: **off**
   - Expiration: 1 day (the key is used once, within minutes)
   - Ephemeral: off
   - Pre-approved: on (matters only if device approval is enabled)
   - Tags: on, `tag:notes`

   Copy the `tskey-auth-…` value for step 7. Tagged nodes have key expiry disabled by default, so the node itself never needs re-authentication.

### 6. Tailnet policy (strongly recommended)

The deploy works without this step, but it is the only thing that limits what code running next to the app can reach on your tailnet. Do it now or soon after the first deploy.

**What it changes.** The default policy is one allow-all rule (`{"src": ["*"], "dst": ["*"], "ip": ["*"]}` in `grants`, or `{"action": "accept", "src": ["*"], "dst": ["*:*"]}` in older `acls`). `*` includes tagged devices, so the `notes` node, and therefore any code in the app's network namespace (a compromised dependency, a future server-side fetch), can open connections to `rgpc`, `mac` and `beach` on every port. The policy below keeps your own devices' access to each other exactly as it is and changes two things:

1. `tag:notes` is the source of no grant at all, so the notes node can reach nothing.
2. Your devices reach the notes node on `tcp:443` only (serve's HTTPS endpoint; nothing else is meant to be reachable there).

**Before you edit:**

1. Copy your current policy file somewhere safe, so you can paste it back.
2. On [Machines](https://login.tailscale.com/admin/machines), list every flow the new grants do not cover by themselves: devices with a **tag** (other than `notes`), devices **shared** with you or by you, **exit nodes**, **subnet routers**, and other **people** who are members of your tailnet. Each needs its own grant (examples in the snippet).

**The change.** Replace the allow-all grant (or the allow-all `acls` entry) with the following. Keep `tagOwners` from step 5 and leave your `ssh` section as it is; your own devices keep port 22 through the first grant.

```jsonc
  "grants": [
    // Your own (user-owned) devices reach each other on every port, as before.
    // autogroup:self never includes tagged devices, so tag:notes is not covered.
    { "src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["*"] },

    // NotesApp: HTTPS only.
    { "src": ["autogroup:member"], "dst": ["tag:notes"], "ip": ["tcp:443"] },

    // Add one grant per flow from your list, for example:
    // { "src": ["autogroup:member"], "dst": ["tag:server"], "ip": ["*"] },          // your other tagged devices
    // { "src": ["autogroup:member"], "dst": ["autogroup:internet"], "ip": ["*"] },  // using exit nodes
    // { "src": ["autogroup:member"], "dst": ["192.168.1.0/24"], "ip": ["*"] },      // a subnet route
    // { "src": ["autogroup:member"], "dst": ["friend@example.com"], "ip": ["*"] },   // another member's devices
  ],

  "hosts": {
    "rgpc": "<rgpc tailscale IPv4>",   // output of `tailscale ip -4` on rgpc
  },

  "tests": [
    // The notes node reaches nothing: not rgpc, and a tagged source cannot even reach notes:443.
    { "src": "tag:notes", "deny": ["rgpc:22", "rgpc:443", "rgpc:445", "rgpc:3389", "tag:notes:443"] },
    // You reach the app on 443 and nothing else on that node.
    { "src": "you@example.com", "accept": ["tag:notes:443"], "deny": ["tag:notes:8080", "tag:notes:22"] },
  ],
```

The policy file is HuJSON, so the comments and trailing commas are fine. Tailscale runs the `tests` on save and refuses a policy that fails them; an unreplaced `<rgpc tailscale IPv4>` also fails the save, on purpose. After saving, the **Preview rules** tab shows, per user or device, what it can reach: `tag:notes` should have no outgoing access at all. If anything you rely on stops working, add the missing grant, or paste your saved copy back.

### 7. Configure `deploy/.env`

```sh
cd ~/notesapp/deploy
cp .env.example .env
chmod 600 .env
nano .env
```

| Variable | Value |
|---|---|
| `TS_AUTHKEY` | The auth key from step 5. Deleted again in step 9. |
| `NOTES_ALLOWED_HOSTS` | `notes.<tailnet>.ts.net`, exactly. The app answers `421` to any other `Host`. |
| `NOTES_IDENTITY_ALLOWED_LOGINS` | Your login exactly as the Users page shows it; comma-separated for several. Everyone else gets `403`. |
| `WATCHTOWER_NOTIFICATION_URL` | Optional, recommended: an ntfy URL (below). Empty means no notifications. |
| `TZ` | Your IANA time zone, for logs and git commit times, e.g. `Europe/Berlin`. |

The blocks after these are optional and can wait: backups (*Backups*, recommended), `NOTES_GIT_LARGE_FILE_THRESHOLD` (*Large files*; the default of 25 MB suits most vaults), the GitHub mirror (*Mirror to GitHub*) and the Anthropic API key of Ask your vault (*Ask your vault*).

**ntfy (recommended).** With it, Watchtower reports every update session (updated, failed, skipped), which is how you find out that deploys have stopped, for example after the pull token was revoked. Without it, a broken pipeline is silent.

```sh
echo "notes-$(openssl rand -hex 16)"   # your topic; anyone who knows it can read and post, so keep it secret
```

Set `WATCHTOWER_NOTIFICATION_URL=ntfy://ntfy.sh/notes-<hex>` (or `ntfy://ntfy.example.com/<topic>` for a self-hosted server), install the ntfy app on the iPhone and subscribe to the same topic on `ntfy.sh`. Test the subscription: `curl -d 'test from homeserver' https://ntfy.sh/notes-<hex>`.

**Validate:**

```sh
docker compose config --quiet && echo "compose OK"
docker compose config | sed -n '/^volumes:/,$p'    # both volumes show external: true
```

Do not paste the full `docker compose config` output anywhere: it contains the auth key.

### 8. Registry credentials

Watchtower and your own `docker` CLI both pull the private image with the token from step 1.3.

```sh
read -rsp 'GHCR token: ' GHCR_PAT; echo
sudo install -d -m 700 /etc/watchtower
printf '%s' "$GHCR_PAT" | sudo docker --config /etc/watchtower login ghcr.io -u <github-user> --password-stdin
printf '%s' "$GHCR_PAT" | docker login ghcr.io -u <github-user> --password-stdin
unset GHCR_PAT
sudo chmod 600 /etc/watchtower/config.json
sudo grep -c '"auth"' /etc/watchtower/config.json   # 1
```

The warning about credentials being stored unencrypted is expected: Watchtower can only read credentials stored inline in `config.json`. If the last command prints `0`, the Docker CLI used a credential helper; see *Watchtower authentication errors* in Part 3.

Check access and both architectures:

```sh
docker buildx imagetools inspect ghcr.io/rjgehan/notesapp:latest | grep -E 'Platform:\s+linux/(amd64|arm64)'
```

### 9. Start

```sh
cd ~/notesapp/deploy
docker compose pull
docker compose up -d
docker compose logs -f tailscale notes     # Ctrl-C stops following; the containers keep running
```

`tailscale` logs in with the key and becomes `notes.<tailnet>.ts.net`, then turns healthy, which starts `notes`. On an empty vault the app creates `Welcome.md`, starts serving, and commits `Initial commit` shortly after. `watchtower` sends its startup message if ntfy is configured.

**Remove the auth key** once `tailscale` is logged in. The key is single-use and now spent; deleting it keeps it out of `docker inspect` for the life of the node.

```sh
sed -i '/^TS_AUTHKEY=/d' .env
docker compose up -d                                 # recreates tailscale without the key; notes follows
docker compose exec tailscale printenv TS_AUTHKEY    # prints an empty line
```

### 10. Verify

```sh
docker compose ps                                                  # tailscale and notes (healthy), watchtower Up
docker compose exec tailscale ip link show tailscale0              # kernel mode: the interface exists
docker compose logs notes | grep TailscaleInterfaceCheck           # the app's kernel-mode check passed
docker compose exec tailscale wget -qO- http://127.0.0.1:8080/readyz; echo   # {"status":"UP"}
docker inspect --format '{{.HostConfig.LogConfig}}' notes-notes-1  # {local map[max-file:5 max-size:10m]}
docker compose logs watchtower                                     # started, no authentication errors
```

`notes` can take a minute or two to show `(healthy)`; the image's health check has a 60 s start period.

Then from your devices:

1. **rgpc:** open `https://notes.<tailnet>.ts.net`. You see `Welcome.md` (the very first HTTPS request can take a few seconds while the certificate is issued). `curl.exe -fsS https://notes.<tailnet>.ts.net/readyz` prints `{"status":"UP"}`.
2. **Deployed build:** `https://notes.<tailnet>.ts.net/api/status` shows `buildSha` equal to `git rev-parse origin/main` on rgpc.
3. **iPhone:** open the same URL in Safari (Share → Add to Home Screen if you like).
4. **Port 8080 is closed:** from `beach`, `curl -m 5 http://notes:8080` must fail.
5. **Smoke test:** run the browser checklist in [DESIGN.md §8.3](DESIGN.md#83-browser-smoke-checklist) on rgpc and on the iPhone.
6. **Backups:** set up the nightly backups and do the restore drill once (Part 2, *Backups*). Until then, the vault and its history exist on this one disk only.

---

## Part 2: Operations

### Where things are

| What | Where |
|---|---|
| Deploy files | `~/notesapp/deploy` (a git checkout; update with `git pull`) |
| Secrets | `~/notesapp/deploy/.env` (mode 600), `~/notesapp/deploy/secrets/` (backup password, off-site keys, the mirror token and the Anthropic API key, mode 600), `/srv/notes/data/secrets/claude-token` (Ask your vault, uid 1000, mode 600), `/srv/notes/data/secrets/ntfy.json` (app alerts and reminders, uid 1000, mode 600), `/srv/notes/data/secrets/push.json` (the reminders' Web Push key and devices, created by the app) and `/etc/watchtower/config.json` (root, mode 600) |
| Vault: notes, attachments, `.git`, `.trash`, `.notesapp` | `/srv/notes/data/vault` (volume `notes-data`, mounted at `/data`) |
| Tailscale identity and certificates | volume `tailscale-state` |
| Backups | `/mnt/backup/notes-restic` (local restic repository, second disk) and the off-site bucket; run state in volume `notes_backup-state` |
| Status page | `https://notes.<tailnet>.ts.net/x/status` (*Status* in the ribbon or the phone drawer) |
| Containers | `notes-tailscale-1`, `notes-notes-1`, `notes-watchtower-1`; with backups `notes-backup-1` and `notes-backup-scheduler-1` |

### Updates

- **The app updates itself.** Watchtower checks GHCR every 5 minutes, so a green push to `main` is live a few minutes after its publish job finishes; the weekly scheduled rebuild arrives the same way. Each update session is reported to ntfy if configured. During the 10–30 s restart the app answers `502`; open tabs show *Reconnecting* and recover on their own.
- **Which build is running:** the status page (*Server*), `buildSha` in `https://notes.<tailnet>.ts.net/api/status`, or
  `docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' notes-notes-1`.
- **Update now** instead of waiting: `docker compose pull notes && docker compose up -d notes`.

### Pause and resume updates

```sh
docker compose stop watchtower      # pause
docker compose start watchtower     # resume
```

### Roll back a bad release

Watchtower does not roll back a crash-looping image, and its cleanup deletes the previous one. Pin a known-good build instead:

1. Find the last good commit. Its image tag is `sha-` plus the first 7 hex characters of the commit id:
   ```sh
   git -C ~/notesapp fetch -q && git -C ~/notesapp log --format='sha-%h  %s' --abbrev=7 -10 origin/main
   ```
   (If git prints more than 7 hex characters, use the first 7. The package page from step 1.2 lists every tag.)
2. Pin it with an override file, which Compose merges automatically and git ignores:
   ```sh
   cd ~/notesapp/deploy
   cat > docker-compose.override.yml <<'EOF'
   services:
     notes:
       image: ghcr.io/rjgehan/notesapp:sha-1a2b3c4
   EOF
   docker compose up -d notes
   ```
3. Check `buildSha` in `/api/status`. A `sha-` tag never changes, so Watchtower leaves the container alone.
4. When a fixed build is on `main`, return to `latest`:
   ```sh
   rm docker-compose.override.yml && docker compose up -d notes
   ```

Rolling back is safe for data. If the newer build wrote settings the older one does not understand, the older one shows settings as read-only instead of resetting them, until you return to `latest`.

### Monthly: update Tailscale, Watchtower and the backup images

None of them is updated automatically: a Tailscale restart briefly cuts the app off (Part 3), and Watchtower, restic and the scheduler's `docker:cli` are pinned by digest (two of them hold the Docker socket). Dependabot proposes their bumps as PRs; merge those first. `docker compose up -d` pulls a changed pin by itself.

```sh
git -C ~/notesapp pull --ff-only
cd ~/notesapp/deploy
docker compose pull tailscale watchtower
docker compose up -d
```

Recreating `tailscale` also restarts `notes`: expect about 30 s of `502`.

### Update the deploy files

After a change under `deploy/` is merged:

```sh
git -C ~/notesapp pull --ff-only
cd ~/notesapp/deploy && docker compose up -d     # recreates only what changed
```

### Logs

```sh
docker compose logs -f notes                                # follow
docker compose logs --since 24h notes | grep -E ' (ERROR|WARN) '
```

Stable ERROR markers to search for (DESIGN §5.18): `GIT_COMMIT_FAILED`, `GIT_MIRROR_FAILED`, `WATCHER_DEGRADED`, `TAILSCALE_WATCHDOG_EXIT`, `STORAGE_LOW`, `SETTINGS_READ_ONLY`. Logs are rotated at 5 × 10 MB per container. Note content and search queries are never logged; paths are. With *App alerts* set up, the app also pushes each marker to your phone, and the status page counts them under *App alerts*.

### Monitoring

Four signals: Watchtower's ntfy reports, an external `/readyz` probe, the ERROR markers above (pushed by the app itself once *App alerts* is set up), and the **status page** at `https://notes.<tailnet>.ts.net/x/status`, which lists every problem first and then shows the server, history, disk, backups, alerts and live sync at a glance.

**Probe from `beach`** (any always-on tailnet machine with cron), every 5 minutes, posting to the same ntfy topic on failure. The retries ride out the restart of a normal deploy:

```sh
crontab -e
```

```
*/5 * * * * curl -fsS -m 10 --retry 4 --retry-delay 15 --retry-all-errors -o /dev/null https://notes.<tailnet>.ts.net/readyz || curl -fsS -m 20 -H 'Title: NotesApp is down' -d 'readyz failed from beach' https://ntfy.sh/notes-<hex>
```

`/readyz` is exempt from the identity allowlist, so the probe also works from a tagged machine; with the step 6 policy, that machine's tag then needs `{ "src": ["tag:<its tag>"], "dst": ["tag:notes"], "ip": ["tcp:443"] }`.

**Disk:** `/api/status` shows `disk.freeBytes`, the size of the git repository (`disk.repoBytes`) and the files kept out of it (`git.largeFiles`, *Large files*); **Settings › About** shows the same. Uploads are refused below 1 GiB free.

**Mirror:** when the GitHub mirror is set up, `mirror` in `/api/status` and the status bar show whether it is current; failures are logged as `GIT_MIRROR_FAILED` (*Mirror to GitHub*).

### App alerts

NotesApp pushes its own problems to ntfy (ROADMAP item 38, DESIGN §5.18.1): history not being saved, the mirror failing, the disk filling up, the file watcher failing, read-only settings, and a restart after losing the Tailscale network (the ERROR markers in *Logs*). Each alert is a fixed text with a link to the status page; paths, error texts and note content never leave the server. While a problem lasts it is sent at most once an hour, with a "still happening" count, and at most 10 alerts go out in any hour. Nothing is sent until you create the file below.

**1. A topic.** Reuse the Watchtower topic from step 7 (`notes-<hex>`), or make one for app problems with `openssl rand -hex 16`. Subscribe to it in the ntfy app on the iPhone.

**2. `ntfy.json`,** in the data volume next to the vault, never inside it, so it never reaches git, the trash or the mirror:

```sh
sudo install -d -o 1000 -g 1000 -m 700 /srv/notes/data/secrets
sudo -u '#1000' sh -c 'umask 077 && cat > /srv/notes/data/secrets/ntfy.json' <<'EOF'
{ "server": "https://ntfy.sh", "topic": "notes-<hex>" }
EOF
```

- **With an access token** (a reserved topic on ntfy.sh, or a self-hosted server with access control), add `"token": "tk_…"`. A token is only sent over `https://`, or over `http://` to a tailnet host.
- **A self-hosted ntfy on the tailnet:** `"server": "https://ntfy.<tailnet>.ts.net"`.
- **A separate topic for app problems,** for example when the reminders use the main one (*Reminders*): `"alerts": { "topic": "notes-ops-<hex>" }`; reminders take `"reminders": { "topic": "notes-remind-<hex>" }`. `"alerts": false` switches the alerts off and keeps the file.
- **With a plain (not bind-backed) volume:** `docker compose exec -T notes sh -c 'umask 077 && mkdir -p /data/secrets && cat > /data/secrets/ntfy.json' < ntfy.json`.

No restart is needed: the app reads the file again whenever it changes.

**3. Test it.** On the status page, *App alerts* says "sent to ntfy at https://ntfy.sh", or what is wrong with the file. Press **Send a test alert**: the phone shows *NotesApp: test alert*.

The backups (`NOTES_BACKUP_NTFY_URL`) and Watchtower (`WATCHTOWER_NOTIFICATION_URL`) keep their own settings in `.env`; all three can post to the same topic.

### Reminders

Task reminders and the daily-note nudge (ROADMAP items 9 and 4c, DESIGN §5.26). One scheduler in the app delivers each reminder at its time through the routes switched on in **Settings › Reminders**; all of them are off by default, and a reminder counts as delivered once one route takes it. Reminders missed while the app was down (up to a day) are delivered when it starts. Times are read in the time zone the devices report (the latest one wins); the status there shows it.

**Web Push** reaches subscribed devices with the app closed: the iPhone and iPad through the app added to the Home Screen (**iOS 16.4 or later**: Safari › Share › *Add to Home Screen*, open it from the icon), and desktop Chrome, Edge and Firefox from a tab. In **Settings › Reminders**, press **Subscribe this device**, allow notifications, switch on **Send by Web Push**, and press **Send a test** next to the device.

- Nothing to configure on the server. On first use the app creates its VAPID key pair in `/srv/notes/data/secrets/push.json` (uid 1000, mode 600), next to `ntfy.json`; the subscribed devices are kept there too. Losing the file only means subscribing the devices again.
- Messages go from the app to the browser vendors' push services (Apple, Google, Mozilla), so **the app needs outbound HTTPS** to them, like the mirror. Each message is encrypted for its device: the push service sees neither the title nor the notes, only that a message was sent.
- The VAPID contact defaults to `https://<first NOTES_ALLOWED_HOSTS host>`. Should a push service refuse it (`BadJwtToken`, `403` in the device's last error), set `NOTES_REMINDERS_VAPID_SUBJECT=mailto:you@example.com` on the `notes` service.
- A device whose subscription expired (`404`/`410` from its push service) is removed; subscribe it again. On the iPhone, notification buttons do not exist: tapping the notification opens the task. Snooze and Done buttons work on desktop.

**ntfy** uses the `ntfy.json` of *App alerts*, to its default topic, or to a topic of its own:

```json
{ "server": "https://ntfy.sh", "topic": "notes-<hex>", "token": "tk_…",
  "alerts": { "topic": "notes-ops-<hex>" }, "reminders": { "topic": "notes-remind-<hex>" } }
```

Switch on **Send through ntfy** and press its **Send a test**. **Title only** (on by default) sends the task's title and nothing else; with ntfy.sh, that title leaves the tailnet. With a self-hosted ntfy on the tailnet you may switch it off to get the due date and the start of the notes too (on iOS, instant delivery still passes message ids and timing through ntfy.sh, ROADMAP item 9).

**In the app**: **Show in open tabs** shows a reminder in every open NotesApp tab, with a browser notification after **Allow**. Nothing arrives while every tab is closed, so pair it with one of the others.

**The daily-note nudge** (**Daily-note nudge**, at 09:00 unless changed) reminds you when today's daily note does not exist yet.

The scheduler's state is `.notesapp/reminders.json` in the vault, kept out of git.

### Backups

Nightly [restic](https://restic.net) snapshots (ROADMAP item 1, DESIGN §7.10) of the `notes-data` volume (the vault with its `.git`, trash and settings) and of `tailscale-state`. They go to a repository on a **second disk** on homeserver and from there to Backblaze B2 or Amazon S3, and keep 7 daily, 4 weekly and 12 monthly snapshots.

Every night at 04:00 NotesApp is **stopped for the local snapshot** and started again. Stopping makes it commit its pending history, so a snapshot never holds a half-written file or a half-made commit. After the first run this takes seconds, plus the app's restart; open tabs show *Reconnecting* and recover on their own, and unsaved edits stay in the browser. The off-site copy and the clean-up run while the app is back up.

Nothing runs until you set it up. Two containers do the work:

- `backup` is the restic sidecar.
- `backup-scheduler` starts each night's run and holds the Docker socket, like Watchtower. *Host cron instead of backup-scheduler* below avoids that.

On CasaOS the same two containers are a second paste-in app: [CASAOS.md](CASAOS.md) *Nightly backups*.

#### Set up the nightly backups

**1. A second disk.** Mount a USB disk or a second internal disk permanently, then create the repository directory on it. The example formats a **new, empty** partition `/dev/sdX1`; skip `mkfs` for a disk that already has a filesystem, and use its label or UUID.

```sh
lsblk -f                                         # find the disk
sudo mkfs.ext4 -L notes-backup /dev/sdX1         # ERASES the partition
sudo install -d /mnt/backup
echo 'LABEL=notes-backup /mnt/backup ext4 defaults,nofail,x-systemd.device-timeout=10s 0 2' | sudo tee -a /etc/fstab
sudo systemctl daemon-reload && sudo mount /mnt/backup
findmnt /mnt/backup                              # must list the disk; df -h /mnt/backup /srv/notes shows two filesystems
sudo install -d -m 700 /mnt/backup/notes-restic
```

`nofail` lets the server boot without the disk. The backup refuses a repository on the vault's own filesystem, which is what an unmounted disk would leave behind, so a missing disk fails loudly instead of quietly filling the system disk.

**2. Off-site storage (recommended).** Without it, the backups share homeserver's fate (fire, theft, a power surge).

- **Backblaze B2:** create a **private** bucket with the lifecycle rule *Keep only the last version of the file*. Then create an application key limited to that bucket, with read and write access. Note the bucket's S3 endpoint (for example `s3.us-west-004.backblazeb2.com`), the *keyID* and the *applicationKey*.
- **Amazon S3:** a private bucket, and an IAM user whose policy allows only that bucket. Note its access key pair and the bucket's region.

restic uses the S3 API for both (for B2, restic recommends it over its native B2 backend).

**3. Secrets.** Two files in `deploy/secrets/`, which git ignores, readable only by you:

```sh
cd ~/notesapp/deploy
install -d -m 700 secrets
(umask 077 && openssl rand -base64 33 > secrets/restic-password)
install -m 600 /dev/null secrets/backup-offsite-credentials
nano secrets/backup-offsite-credentials          # leave it empty if you have no off-site bucket
```

The credentials file is in the AWS format, for B2 too:

```ini
[default]
aws_access_key_id = <keyID>
aws_secret_access_key = <applicationKey>
```

**Now put the content of `secrets/restic-password` into your password manager**, together with the bucket name, endpoint and keys. The snapshots are encrypted with that password, and its only other copy is on the disk the backups protect: without it, nothing can be restored.

**4. `.env`.** If your `.env` was made before backups existed, append the block from `.env.example`, then edit it:

```sh
grep -q '^COMPOSE_PROFILES=' .env || sed -n '/^# ---- Backups/,$p' .env.example >> .env
nano .env
```

| Variable | Value |
|---|---|
| `COMPOSE_PROFILES` | `backup`. Empty (the default) means no backups. |
| `NOTES_BACKUP_LOCAL_REPO` | The directory from step 1, `/mnt/backup/notes-restic`. |
| `NOTES_BACKUP_OFFSITE_REPO` | B2: `s3:https://s3.us-west-004.backblazeb2.com/<bucket>/notes`. S3: `s3:https://s3.<region>.amazonaws.com/<bucket>/notes`. Empty means the local disk only. |
| `NOTES_BACKUP_TIME` | `04:00` (local time in `TZ`). The app's own git housekeeping runs at 03:30. |
| `NOTES_BACKUP_NTFY_URL` | Your ntfy topic as an https URL, `https://ntfy.sh/notes-<hex>`: the same topic as Watchtower is fine. Failures are posted here. |
| `NOTES_BACKUP_HEARTBEAT_URL` | Optional, recommended: a dead man's switch (*Monitoring backups* below). |

**5. Start the sidecars and create the repositories:**

```sh
docker compose config --quiet && docker compose up -d      # starts backup and backup-scheduler
docker compose ps backup backup-scheduler                   # both Up
docker compose exec backup sh /backup/restic-job.sh init
docker compose logs backup-scheduler                        # "next backup run: ... 04:00 ..."
```

**6. The first run, by hand.** It reads every file, and NotesApp is down while it does. For a large vault (gigabytes of attachments), start it at a time that suits you:

```sh
docker compose exec backup-scheduler sh /backup/nightly.sh  # ends with "backup run finished"
docker compose exec backup sh /backup/restic-job.sh snapshots
docker compose exec backup sh /backup/restic-job.sh snapshots offsite
```

The first off-site upload can take hours on a slow uplink. NotesApp is already running again by then, because the copy reads the local repository, not the vault.

**7. Do the restore drill** (below) once, and again whenever the backup setup changes.

#### Monitoring backups

- **ntfy.** A failed run posts *NotesApp backup failed* (high priority) with the steps that failed. restic's output stays on homeserver, because its errors name your notes: the status page and the logs below have it. *NotesApp is down after the backup* (urgent) means the app could not be started again: run `docker compose up -d` at once. On Sundays, when the weekly repository check passes, a low-priority *NotesApp backups OK* arrives. **If that Sunday message stops coming, the backups have stopped**, for example because `backup-scheduler` is not running.
- **Heartbeat (recommended).** It catches what ntfy cannot: homeserver being off, or the scheduler being gone. Create a check at [healthchecks.io](https://healthchecks.io) (or an Uptime Kuma push monitor) with a period of 1 day and a grace time of 2 hours. Set `NOTES_BACKUP_HEARTBEAT_URL` to its ping URL (`https://hc-ping.com/<uuid>`), run `docker compose up -d`, and let the check notify you, for example through the same ntfy topic. Every successful run pings it.
- **Status:** the status page's *Backups* card shows the last run's time and result, the snapshot, the off-site result, the last success and the failures, and lists a failed run, or no success for 36 hours, among the problems at the top. The same file from the command line: `docker compose exec backup-scheduler cat /state/status.json`.
- **Logs:** `docker compose logs --since 48h backup-scheduler` (each run, with restic's output) and `docker compose logs backup`.

#### Run, pause or change the backups

- **Run now:** `docker compose exec backup-scheduler sh /backup/nightly.sh`. A run that is already in progress makes a second one skip.
- **Pause:** `docker compose stop backup-scheduler`. **Resume:** `docker compose start backup-scheduler`.
- **Another time:** change `NOTES_BACKUP_TIME` in `.env`, then `docker compose up -d`.
- **Turn off:** set `COMPOSE_PROFILES=` in `.env`, then `docker compose --profile backup rm -s -f backup backup-scheduler`. The repositories stay as they are.
- **List or check snapshots:** `docker compose exec backup sh /backup/restic-job.sh snapshots [offsite]`, `... check`.

#### Host cron instead of backup-scheduler

`backup-scheduler` holds the Docker socket, which is root-equivalent on homeserver. To avoid a second container with that access, let your own crontab start the runs; `nightly.sh` only needs the `docker` CLI, which your login user has (step 2).

```sh
cd ~/notesapp/deploy
install -d -m 755 ~/.local/state/notesapp-backup             # the runs' state, owned by you: create it FIRST (below)
sed -i 's/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=backup-host-cron/' .env
grep -q '^NOTES_BACKUP_STATE=' .env || echo 'NOTES_BACKUP_STATE=' >> .env
sed -i "s|^NOTES_BACKUP_STATE=.*|NOTES_BACKUP_STATE=$HOME/.local/state/notesapp-backup|" .env
docker compose --profile backup rm -s -f backup-scheduler   # if it ran before
docker compose up -d                                         # the backup sidecar only; notes now mounts that directory
crontab -e
```

```
0 4 * * * NOTES_BACKUP_NTFY_URL=https://ntfy.sh/notes-<hex> /bin/sh $HOME/notesapp/deploy/backup/nightly.sh >> $HOME/notesapp-backup.log 2>&1
@reboot sleep 120; /bin/sh $HOME/notesapp/deploy/backup/nightly.sh --recover >> $HOME/notesapp-backup.log 2>&1
```

The `@reboot` line starts NotesApp again if the server rebooted during a snapshot. Add `NOTES_BACKUP_HEARTBEAT_URL=<url>` before `/bin/sh` in the first line for a heartbeat. The state (`status.json`) is in `~/.local/state/notesapp-backup`, and the log grows by about a kilobyte a night. Monitoring is the same as above.

`NOTES_BACKUP_STATE` mounts that directory into the app instead of the scheduler's volume, so the status page sees the runs. It is an absolute path, since Compose does not expand `~`. **Create the directory before the `docker compose up -d` that mounts it**, as above: Docker creates a missing mount source as root, and the cron job, running as you, could then never write there. Each run would fail with *its state directory … cannot be written* (*"NotesApp backup failed"* in Part 3 has the fix). Finally, run `sh ~/notesapp/deploy/backup/nightly.sh` once by hand, as in step 6 of the setup.

#### Manual backups

A one-off copy, for example before a release that changes moving and renaming, the trash or the git integration (`MoveService`, `TrashService`, `GitStore`). Copy it to **another** disk or machine; `/mnt/backup` stands for that. With the nightly backups running, `docker compose exec backup-scheduler sh /backup/nightly.sh` is the simplest one.

**Git history only, no downtime.** Contains every committed note, every attachment up to the large-file threshold (25 MB, *Large files* below) and the settings, but not larger files, the trash or the last few minutes of uncommitted edits. Run **Commit pending changes now** from the command palette first, then:

```sh
docker run --rm -v notes-data:/data:ro -v /mnt/backup:/b alpine/git:2.54.0 \
  -c safe.directory='*' -C /data/vault bundle create /b/notes-$(date +%F).bundle --all
```

**Full: working tree, `.git`, trash and settings** (about a minute of downtime):

```sh
cd ~/notesapp/deploy
docker compose stop notes
sudo tar czf /mnt/backup/notes-$(date +%F).tgz -C /srv/notes/data vault
docker compose start notes
```

Keep the `alpine/git` tag current: pin the newest version from Docker Hub.

### Restore

For a single note, the history panel or the trash is quicker. The steps below replace the whole vault. The current vault is moved aside, never deleted.

#### From the nightly backups

restic restores into an **empty** scratch directory; `restic-job.sh` refuses any other target, so it can never write over the live vault. Use `offsite` instead of `local` when the second disk is gone; add a snapshot id at the end for an older snapshot than the latest.

```sh
cd ~/notesapp/deploy
docker compose exec backup sh /backup/restic-job.sh snapshots      # pick a snapshot, or take the latest
sudo install -d -m 700 /srv/notes/restore
docker compose run --rm --no-deps -v /srv/notes/restore:/target backup restore local notes-data /target
sudo ls -la /srv/notes/restore/vault                                # look before you swap
docker compose stop notes
sudo mv /srv/notes/data/vault /srv/notes/data/vault.before-restore
sudo mv /srv/notes/restore/vault /srv/notes/data/vault
sudo chown -R 1000:1000 /srv/notes/data/vault                       # restic keeps owners; this is a safety net
docker compose start notes
```

Check as below, then remove `/srv/notes/data/vault.before-restore` and `/srv/notes/restore`.

#### From a manual backup

```sh
cd ~/notesapp/deploy
docker compose stop notes
sudo mv /srv/notes/data/vault /srv/notes/data/vault.before-restore
```

From a **full backup:**

```sh
sudo tar xzf /mnt/backup/notes-YYYY-MM-DD.tgz -C /srv/notes/data
sudo chown -R 1000:1000 /srv/notes/data/vault
```

Or from a **bundle:**

```sh
docker run --rm --user 1000:1000 -e HOME=/tmp -v /mnt/backup:/b:ro -v /srv/notes/data:/r \
  alpine/git:2.54.0 clone --quiet /b/notes-YYYY-MM-DD.bundle /r/vault
docker run --rm --user 1000:1000 -e HOME=/tmp -v /srv/notes/data:/r \
  alpine/git:2.54.0 -C /r/vault remote remove origin
```

Then `docker compose start notes`.

#### Check a restored vault

```sh
docker run --rm -v notes-data:/data:ro alpine/git:2.54.0 -c safe.directory='*' -C /data/vault log --oneline -5
```

`/api/status` should show the expected `vault.notes` count and `git.head`, and the history panel the expected commits.

#### Rebuild homeserver from the off-site copy

When homeserver or its disks are lost, you need the deploy repository, your password manager (restic password, bucket keys, `.env` values, GHCR token) and the off-site bucket.

1. On the new machine, follow Part 1 steps 2, 3, 4, 7 and 8. In step 7, set the backup variables in `.env` as before, but leave `TS_AUTHKEY` out: the node identity comes back from the backup. **Stop before step 9.**
2. Recreate `deploy/secrets/` as in *Set up the nightly backups*, step 3, with the **old** password from your password manager (not a new one).
3. Restore both volumes. `/mnt/backup/notes-restic` must exist (step 1 of the setup, on a new second disk, or an empty directory for now):

   ```sh
   cd ~/notesapp/deploy
   sudo install -d -m 700 /srv/notes/restore
   docker compose run --rm --no-deps -v /srv/notes/restore:/target backup restore offsite notes-data /target
   sudo find /srv/notes/restore -mindepth 1 -maxdepth 1 -exec mv -t /srv/notes/data/ {} +   # replaces the empty folders of step 4
   sudo rmdir /srv/notes/restore
   docker compose run --rm --no-deps -v tailscale-state:/target backup restore offsite tailscale-state /target
   ```

   Restore `tailscale-state` only when the old server is gone for good. Two machines with the same node key fight over the name `notes`. Without the state, Part 1 step 5 makes a new node, which needs a new auth key and new certificates.
4. Part 1 steps 9 and 10. The app finds its vault and history, and `tailscale` comes back as `notes` with the old identity.
5. On the new second disk: `docker compose exec backup sh /backup/restic-job.sh init`. A new local repository takes its chunker parameters from the off-site one, so the nightly copies keep deduplicating. The old snapshots stay off site and age out under the usual retention.

### Restore drill

Do this once after setting up the backups, and again whenever the backup setup changes. It restores the latest snapshot from **both** repositories into scratch directories, checks git, and boots a throwaway copy of the app with no network at all; production keeps running.

```sh
cd ~/notesapp/deploy
D=/srv/notes/drill; O=/srv/notes/drill-offsite
sudo install -d -o 1000 -g 1000 "$D" "$O"

# Restore the latest snapshot from each repository; the two must be identical
docker compose run --rm --no-deps -v "$D":/target backup restore local notes-data /target
docker compose run --rm --no-deps -v "$O":/target backup restore offsite notes-data /target
sudo diff -r "$D" "$O" && echo "local and off-site agree"

# Git is complete: every object reachable, HEAD resolves (prints nothing on success, except dangling objects)
docker run --rm -v "$D":/data:ro alpine/git:2.54.0 -c safe.directory='*' -C /data/vault fsck --no-progress
docker run --rm -v "$D":/data:ro alpine/git:2.54.0 -c safe.directory='*' -C /data/vault log --oneline -3

# Boot it: no network, not even a bridge, so nothing can reach it
docker run -d --name notes-drill --network none -v "$D":/data \
  -e NOTES_ALLOWED_HOSTS=localhost -e NOTES_SECURITY_REQUIRE_TAILSCALE_INTERFACE=false \
  ghcr.io/rjgehan/notesapp:latest
for i in $(seq 60); do docker exec notes-drill curl -fsS http://127.0.0.1:8080/readyz && break; sleep 2; done; echo

# Compare with production's /api/status (it may have moved on since the snapshot): vault.notes, vault.files, git.head
docker exec notes-drill curl -fsS -H 'Host: localhost' -H 'Tailscale-User-Login: drill@localhost' \
  http://127.0.0.1:8080/api/status; echo

# Clean up
docker rm -f notes-drill
sudo rm -rf "$D" "$O"
```

If `readyz` never answers, `docker logs notes-drill` shows why. The drill container has no identity allowlist configured, so the made-up login header is accepted; it is reachable only through `docker exec`. To drill a **manual** backup instead, untar it into `$D` (`sudo tar xzf /mnt/backup/notes-YYYY-MM-DD.tgz -C "$D"`) or clone the bundle as in *From a manual backup* with `-v "$D":/r`, then continue from the git checks.

### Mirror to GitHub

Optionally, NotesApp pushes the vault's git history to a **private** GitHub repository (ROADMAP item 2, DESIGN §5.8 *Mirror*): about 10 minutes after you stop editing, and at least hourly while you keep editing. You can then browse every note and its history on github.com, and the history survives the loss of homeserver. **Your notes then also live on GitHub**, outside the tailnet; files over the large-file threshold (*Large files* below) are not in the history, so they are never pushed. It is off until you set it up.

NotesApp **never force-pushes**. If the GitHub repository gets commits from elsewhere, the mirror stops and says so instead of overwriting them.

**1. An empty private repository.** On GitHub: *New repository*, **Private**, and **no** README, licence or `.gitignore` (any initial commit would make the first push stop as diverged). Note its HTTPS URL, `https://github.com/<you>/<repo>.git`.

**2. A fine-grained token for that repository only.** GitHub → *Settings* → *Developer settings* → *Personal access tokens* → *Fine-grained tokens* → *Generate new token*:

- *Repository access*: **Only select repositories**, the new repository.
- *Permissions* → *Repository permissions* → **Contents: Read and write** (GitHub adds *Metadata: Read-only* by itself). Nothing else.
- An expiry date you will remember; put a reminder in your calendar a week before it.

**3. The token file**, readable by uid 1000 (the app's user), never in `.env`:

```sh
cd ~/notesapp/deploy
install -d -m 700 secrets
install -m 600 /dev/null secrets/mirror-token
nano secrets/mirror-token                      # paste the token (github_pat_...) and save
[ "$(id -u)" = 1000 ] || sudo chown 1000 secrets/mirror-token
```

**4. `.env`.** If your `.env` was made before the mirror existed, append the new blocks from `.env.example` (`grep -q '^NOTES_MIRROR_URL=' .env || sed -n '/^# ---- Git history/,$p' .env.example >> .env`), then set:

| Variable | Value |
|---|---|
| `NOTES_MIRROR_URL` | `https://github.com/<you>/<repo>.git`. Without a user name or token in it: a URL with credentials is refused. |
| `NOTES_MIRROR_TOKEN_SECRET` | `./secrets/mirror-token` |

**5. Start and check:**

```sh
docker compose up -d                            # recreates notes with the secret
docker compose logs notes | grep -i mirror      # "Git mirror: pushing to https://github.com/... about 10 min after each commit"
```

Run **Push history to the mirror now** from the command palette, then look at **Settings › About › Mirror** (or `mirror` in `/api/status`): it shows *last push just now*, and the repository on github.com has your history. From then on the status bar warns if pushes fail (*Mirror is not being updated*), the mirror has diverged (*Mirror stopped*) or its settings cannot be used (*Mirror is off: …*); failures are retried after 1, 5 and 15 minutes and then every 30 minutes, and logged once as `GIT_MIRROR_FAILED`.

**Rotate the token** before it expires: generate a new one as in step 2, replace the content of `secrets/mirror-token`, run `docker compose up -d --force-recreate notes` (the secret is mounted when the container is created), check **Push history to the mirror now** works, then delete the old token on GitHub.

**Turn it off:** set `NOTES_MIRROR_URL=` in `.env` and run `docker compose up -d`. Delete the token on GitHub and `secrets/mirror-token`; the GitHub repository keeps what was pushed until you delete it.

### Large files

Files larger than **25 MB** stay in the vault, the trash and the nightly backups, but out of git history (ROADMAP item 23, DESIGN §5.8 *Large files*), so `.git` stays small and the mirror stays under GitHub's 100 MB file limit. Hidden files count too: a large cache under `.obsidian/plugins/` or a half-finished `*.part` download is kept out like an attachment, though only the files the app shows are counted in **Settings › About** and on the status page. For such a file:

- its History panel says why it has no new versions; the versions from before it grew past 25 MB are kept;
- replacing it (an upload over it, or restoring an older version) first puts the current file in the **trash**, since history cannot bring it back;
- `.git/info/exclude` lists it in the section NotesApp manages (`git -C /srv/notes/data/vault check-ignore -v '<path>'` shows the line).

**Settings › About** shows the history size and how many files are kept out of it. To change the threshold, set `NOTES_GIT_LARGE_FILE_THRESHOLD` in `.env` (for example `50MB`; `0` versions every file) and run `docker compose up -d`. At the next start, files now over the threshold stop being versioned (`Stop versioning …` commits) and files now under it are committed. Lowering it does not shrink the history: versions already committed stay. Keep it below 100 MB while the mirror is on, and at 5 MB or more, the largest note NotesApp saves (`notes.limits.max-text-size`): a lower threshold would leave large notes without versions while every save overwrites them, so NotesApp refuses to start with it and says why in `docker compose logs notes`.

### Ask your vault

Optionally, NotesApp answers questions about your notes, summarizes a note, a folder, a selection or this week's daily notes, and suggests links, tags and tasks, with Claude (ROADMAP item 18, DESIGN §5.25). **When you use it, your question and the text of the notes it needs are sent to Anthropic**, outside the tailnet; notes in the folders you exclude (`Private` by default) never are, and nothing is sent until you ask. It is off until the server has a credential **and** you switch it on in Settings. Two providers, chosen in **Settings › Ask and summaries › Provider**:

| Provider | How | Credential | Cost |
|---|---|---|---|
| **Claude Code** (default) | The image's Claude Code CLI (`/opt/claude/bin/claude`) runs once per answer, headless, with every tool off, a fresh empty home and no session, so it sees only the notes NotesApp hands it | A token from `claude setup-token`, in `/srv/notes/data/secrets/claude-token` (`/data/secrets/claude-token` in the container) | Your Claude Pro or Max subscription: usage counts against your plan's usage limits, like your own Claude use; for your personal use under its terms |
| **Anthropic API** | The official Java SDK | An API key, as the `anthropic_key` compose secret | Billed per token |

**Claude Code: the token.** On any computer where Claude Code is logged in to your Claude account (`claude`, then `/login`), run `claude setup-token`; it prints a long-lived OAuth token (`sk-ant-oat01-…`). On homeserver:

```sh
sudo install -d -o 1000 -g 1000 -m 700 /srv/notes/data/secrets
sudo -u '#1000' sh -c 'umask 077 && cat > /srv/notes/data/secrets/claude-token'
# paste the token, press Enter, then Ctrl-D
```

No restart: the app reads the file again when it changes. The token is passed to the CLI in its environment only, never on its command line, in a log or in an error text.

**Switch it on.** **Settings › Ask and summaries**: read the notice, turn on **Use Claude**, check **Provider** (Claude Code), **Never send** (one folder or file per line), the model (Claude Sonnet 5.5 by default; Opus 5.5 for harder questions, Haiku 5.5 the lightest), the **context per request** (60,000 characters, about 15,000 tokens) and the **monthly budget** ($5). The section's status then says *Ready* and *Token found in claude-token*. Ask something in the **Ask** panel (the sparkles tab of the right sidebar; *Ask your vault* in the phone's drawer).

**The monthly budget** counts what each answer would cost through the API (Claude Code reports it; the API provider bills it) in `.notesapp/cache/ai-usage.json` (in the volume, not in git) and refuses requests once the month reaches it: with Claude Code it is a guard against using up your plan, not a charge. The log has one line per request with counts and that estimate, never the question, the answer or note text: `docker compose logs notes | grep ' AI '`.

**The image and Claude Code's licence.** The image contains Anthropic's Claude Code CLI (about 290 MB per architecture, 100 MB compressed; version pinned by `CLAUDE_CODE_VERSION` in the `Dockerfile`, downloaded from Anthropic's release bucket and checked against its SHA-256). Claude Code is proprietary ("all rights reserved"), so an image that contains it is for your own use: **keep the GHCR package private**. To build without it, set `--build-arg CLAUDE_CODE_VERSION=none`; you can then mount a Linux build of the CLI into the container and point `NOTES_AI_CLAUDE_COMMAND` at it (or use the API provider).

**Anthropic API instead.** Create a workspace with a monthly spend limit and an API key at [console.anthropic.com](https://console.anthropic.com), then:

```sh
cd ~/notesapp/deploy
install -d -m 700 secrets
install -m 600 /dev/null secrets/anthropic-key
nano secrets/anthropic-key                     # paste the key (sk-ant-...) on one line and save
[ "$(id -u)" = 1000 ] || sudo chown 1000 secrets/anthropic-key
grep -q '^NOTES_AI_KEY_SECRET=' .env || sed -n '/^# ---- Ask your vault/,/^NOTES_AI_KEY_SECRET=/p' .env.example >> .env
```

Set `NOTES_AI_KEY_SECRET=./secrets/anthropic-key` in `.env`, run `docker compose up -d`, and choose **Provider: Anthropic API**.

**Rotate:** run `claude setup-token` again (or create a new API key) and replace the file's content; with the compose secret, `docker compose up -d --force-recreate notes` if the change does not show. **Turn it off:** switch off **Use Claude** in Settings (nothing is sent from then on) and delete the token or key. Conversations are kept only in each device's browser (the panel's *Conversations on this device* deletes them).

### Voice notes

Recording works out of the box: **Record voice note** in the command palette, or the microphone on the iPhone's editing toolbar, records in the browser and saves the audio as an attachment (`Recording <date>.m4a`, or `.webm` from some browsers) embedded where the cursor was (ROADMAP item 33, DESIGN §6.30). Safari asks for the microphone once; the app's `Permissions-Policy` allows it for the app's own pages only.

**Transcription** is optional and off by default. With it, the transcript is added under the recording's embed as a quote, so search finds it like any other text. It runs on homeserver, in the `whisper` service ([whisper-asr-webservice](https://github.com/ahmetoner/whisper-asr-webservice), MIT, with faster-whisper on the CPU), which only the app can reach and which keeps no audio:

1. In `.env`, add `transcription` to `COMPOSE_PROFILES` (for example `COMPOSE_PROFILES=backup,transcription`) and set `NOTES_TRANSCRIPTION_URL=http://whisper:9000`. Optionally `NOTES_TRANSCRIPTION_LANGUAGE=en` (empty detects the language per recording) and `NOTES_WHISPER_MODEL` (`base` for a slow CPU, `small` by default, `medium` for better text with a strong CPU and about 2 GB of RAM).
2. `docker compose up -d`. The image is large (about 2.7 GB on amd64); the model is downloaded into the `whisper-models` volume on the first start (about 0.5 GB for `small`): `docker compose logs -f whisper`.
3. **Settings › This device** now says *New recordings are transcribed by whisper-asr at http://whisper:9000*. Record a few words: the embed appears, then *Transcribing…* in its place, then the text.

A transcription takes a fraction of the recording's length on a modern CPU with `small`, longer with `medium` or on arm64; one runs at a time, and the others wait their turn. Recordings over 25 MB (about 50 minutes) are not sent (`NOTES_TRANSCRIPTION_MAX_SIZE`). A recording can be transcribed again, or later, with **Transcribe recording on this line** in the palette, the cursor on its embed's line. Each device can turn transcripts off in **Settings › This device** or in the recording panel.

**Another engine.** `NOTES_TRANSCRIPTION_API=openai` talks to any server with OpenAI's `POST /v1/audio/transcriptions`: whisper.cpp's `whisper-server` (started with `--convert --inference-path /v1/audio/transcriptions`), speaches, LocalAI, or OpenAI itself. Set `NOTES_TRANSCRIPTION_URL` to its base URL and `NOTES_TRANSCRIPTION_MODEL` to its model name. A key goes in a file outside the vault, never in `.env`: `sudo -u '#1000' sh -c 'umask 077 && cat > /srv/notes/data/secrets/transcription-key'`, then `NOTES_TRANSCRIPTION_API_KEY_FILE=/data/secrets/transcription-key`; it is read for every request, so rotating it needs no restart. Sending recordings to a hosted API means your voice notes leave homeserver.

To turn transcription off, empty `NOTES_TRANSCRIPTION_URL`, remove `transcription` from `COMPOSE_PROFILES` and run `docker compose up -d --remove-orphans`.

### Public publishing

**Off as shipped; nothing is public.** Publishing (ROADMAP item 26, DESIGN §5.28) shares chosen notes as read-only web pages with people outside your tailnet, through [Tailscale Funnel](https://tailscale.com/kb/1223/funnel). The app itself never goes through Funnel: a second, separate server inside the container, which can serve nothing but the snapshots of the notes you published, listens on `127.0.0.1:8081`, and Funnel exposes that port alone, as `https://notes.<tailnet>.ts.net:8443`. The app on `:443` stays tailnet-only and refuses any request that came through Funnel (`403 funnel-request`). A published page is a snapshot made when you publish: later edits stay private until you republish. Frontmatter and comments are left out, links to notes you have not published show as plain text (no paths), and only the images, audio and video the note embeds are copied with it.

It takes **two** switches, and either one alone exposes nothing:

1. **Tailnet policy**: Funnel needs the `funnel` node attribute for `tag:notes`. In the policy file (step 6) add:

   ```jsonc
     "nodeAttrs": [
       { "target": ["tag:notes"], "attr": ["funnel"] },
     ],
   ```

   and, so that your own devices can open the public links too (from the tailnet the name resolves to the node, where the grants of step 6 allow only `:443`), extend the NotesApp grant to `"ip": ["tcp:443", "tcp:8443"]`.

2. **The publish server**, in `deploy/.env`:

   ```sh
   NOTES_PUBLISH_ENABLED=true
   NOTES_PUBLISH_BASE_URL=https://notes.<tailnet>.ts.net:8443   # only for the links the app copies
   ```

3. **The Funnel entry**: replace `deploy/tailscale/serve.json` with the shipped variant, which adds `:8443` → `127.0.0.1:8081` with `AllowFunnel` true for that port only (`:443` keeps `false`):

   ```sh
   cp deploy/tailscale/serve.json deploy/tailscale/serve.json.tailnet-only
   cp deploy/tailscale/serve.funnel.json.example deploy/tailscale/serve.json
   ```

   It reads:

   ```json
   {
     "TCP": { "443": { "HTTPS": true }, "8443": { "HTTPS": true } },
     "Web": {
       "${TS_CERT_DOMAIN}:443": {
         "Handlers": { "/": { "Proxy": "http://127.0.0.1:8080" } }
       },
       "${TS_CERT_DOMAIN}:8443": {
         "Handlers": { "/": { "Proxy": "http://127.0.0.1:8081" } }
       }
     },
     "AllowFunnel": { "${TS_CERT_DOMAIN}:443": false, "${TS_CERT_DOMAIN}:8443": true }
   }
   ```

4. `docker compose up -d` (recreates `notes` with the new environment; `tailscale` picks up `serve.json` by itself). `docker compose logs notes | grep "Publish server"` shows *Publish server listening on 127.0.0.1:8081*, and `docker compose exec tailscale tailscale funnel status` lists `https://notes.<tailnet>.ts.net:8443 (Funnel on)` proxying to `http://127.0.0.1:8081` and `:443` as tailnet only.

**Publishing a note**: the globe in the note's header, **Publish to the web** in the ⋯ menu, or the command palette. Choose the title and the address (`/p/<address>`) and publish; the dialog shows the public link and, later, whether the note changed since. **Settings › Publishing** lists every published note with Republish and Unpublish. Unpublishing deletes the page at once. The snapshots live in `/data/publish` (in the `notes-data` volume, outside the vault, so they are backed up); `.notesapp/publish.json` in the vault lists them.

**Check it from outside the tailnet** (a phone on mobile data): the page opens; `https://notes.<tailnet>.ts.net:8443/`, `/api/tree` and `/n/anything` answer `Not found`; `https://notes.<tailnet>.ts.net/` does not answer at all.

**Turning it off**: copy `serve.json.tailnet-only` back over `serve.json` (the internet loses access at once), set `NOTES_PUBLISH_ENABLED=false` and `docker compose up -d`. The published list and snapshots are kept; unpublish notes in Settings › Publishing (allowed while off) to delete them.

### Import an Obsidian vault

NotesApp reads an Obsidian vault as it is (ROADMAP item 24): the same Markdown, wikilinks, embeds, tags, properties, daily notes and templates. `.obsidian/` is read but never written, so the vault keeps working in Obsidian; it stays hidden in NotesApp and is versioned except `workspace*.json`.

**1. Get a copy of the vault to homeserver.** Close Obsidian on the device the copy comes from, or at least let its sync finish. From `rgpc` (an iCloud vault is under `iCloudDrive\iCloud~md~obsidian\` on Windows; make sure every file is downloaded, not just a placeholder):

```powershell
scp -r "C:\Users\<you>\Documents\MyVault" <you>@homeserver:/tmp/MyVault
```

`rsync -a /path/to/MyVault/ <you>@homeserver:/tmp/MyVault/` works too, from a Mac or Linux. Obsidian's own `.trash/` folder, when the vault has one, is the folder NotesApp uses for its trash: its files show up on the Trash page, to restore or empty there.

**2. Put it in place before the first start** (an empty data folder, step 4 of Part 1):

```sh
sudo cp -a /tmp/MyVault/. /srv/notes/data/vault/
sudo chown -R 1000:1000 /srv/notes/data/vault
docker compose up -d
```

The first start creates `.notesapp/settings.json` from `.obsidian/`: attachment folder, new note location, link format and style, excluded files, strict line breaks, readable line length, default view, the daily note format, folder, template and "open on startup", and the template folder and formats (`docker compose logs notes | grep Imported` shows how many). A vault that already has `.notesapp/settings.json` keeps it; the report below proposes Obsidian's values instead.

- **The vault has its own `.git`** (the obsidian-git plugin): it is kept and NotesApp commits on its current branch; turn the plugin off in Obsidian for this vault, NotesApp is now the only git writer. A detached `HEAD` turns history off until it is on a branch (`/api/status` says so).
- **A large vault** (thousands of files) is ready at once; its history commit runs in the background.
- **Names Windows cannot use** (`Meeting 10:30.md`) work in NotesApp; new names follow the rules of DESIGN §4.4.

**3. Check the compatibility report.** Open `https://notes.<tailnet>.ts.net/x/compat` (also the ribbon, the drawer, *Open Compatibility report* in the palette, and Settings › About). It lists:

- each Obsidian setting next to NotesApp's (*In effect* after a first start), with **Apply Obsidian's settings** for values that differ, for example after importing into an installation that already had settings;
- **Use them on this device** for the graph settings of `graph.json` (graph settings are per device);
- the core and community plugins the vault has turned on, and what NotesApp offers for each;
- what does not carry over, each place opening the note at its line: Dataview and Tasks queries, Templater commands, callouts, Mermaid and math (until they are rendered), links to missing files, headings or blocks, notes it cannot read, Excalidraw drawings and canvases.

**Into a running installation** with notes of its own: stop the app, copy the vault into a subfolder, remove the copy's own `.git` and `.obsidian` (a nested repository would hide the folder from the vault's history; Obsidian settings apply to the vault root only), fix the owner, and start again. The app commits the new files as `Changes made while NotesApp was stopped`. To take over the old vault's settings anyway, compare them with the report's rows by hand under Settings.

```sh
cd ~/notesapp/deploy
docker compose stop notes
sudo mkdir /srv/notes/data/vault/MyVault
sudo cp -a /path/to/MyVault/. /srv/notes/data/vault/MyVault/
sudo rm -rf /srv/notes/data/vault/MyVault/.git /srv/notes/data/vault/MyVault/.obsidian
sudo chown -R 1000:1000 /srv/notes/data/vault
docker compose start notes
```

### Editing the vault over SSH

Edit as uid 1000. Open notes update live, and an `External changes` commit appears in history about 30 s later:

```sh
vim "/srv/notes/data/vault/Some note.md"                   # if you are uid 1000
sudo -u '#1000' vim "/srv/notes/data/vault/Some note.md"   # from another account
```

Never create files or folders as root (`sudo vim` on a new file, `sudo cp` without a `chown`): the app cannot write them, saves there fail with `permission-denied`, and `/api/status` lists the folders under `vault.unwritableDirs`. Fix with `sudo chown -R 1000:1000 /srv/notes/data`. Do not run git commands in the vault yourself; the app is its only git writer.

### Rotate the GHCR token

Create a new token as in step 1.3, repeat the two logins of step 8, run `docker compose restart watchtower`, check `docker compose logs watchtower` after the next poll, then delete the old token on GitHub.

---

## Part 3: Troubleshooting

### 502 for more than a minute after Tailscale restarted

A `502` with an empty page for 10–30 s during startup or a deploy is normal. Longer than a minute after the `tailscale` container **restarted** (crash, OOM, `docker restart`) means `notes` is stuck in the old, dead network namespace. The app's watchdog notices within about a minute, exits, and Docker restarts it into the live namespace:

```sh
docker compose logs notes | grep TAILSCALE_WATCHDOG_EXIT
```

The watchdog stops exiting after 3 times in 10 minutes. If the `502` persists, run `docker compose restart notes`.

### `notes` does not start after `tailscale` was recreated outside Compose

If something other than Compose replaced the `tailscale` container (`docker rm`, `docker run`, a management UI), the `notes` container still points at the old container id, and Docker fails with an error like *joining network namespace of container: No such container*. Fix: `docker compose up -d` in `~/notesapp/deploy`, which recreates `notes` against the current `tailscale`.

### The node is called `notes-1`

A machine named `notes` already existed: an earlier attempt, or `tailscale-state` was lost. In [Machines](https://login.tailscale.com/admin/machines), remove the stale `notes`, then rename the new node to `notes` (its menu → *Edit machine name*). Alternatively keep `notes-1` and set `NOTES_ALLOWED_HOSTS=notes-1.<tailnet>.ts.net`, then `docker compose up -d notes`. Never delete `tailscale-state` to start over (next item).

### TLS errors after the Tailscale state was lost (Let's Encrypt lockout)

Every new node requests new certificates, and Let's Encrypt allows only a few duplicate certificates per week for the same name. After repeated rebuilds, issuance for `notes.<tailnet>.ts.net` is blocked for about 34 hours; the `tailscale` logs mention a rate limit. Wait it out and keep `tailscale-state` from now on. The only workaround is a different node name, which changes the URL.

### Watchtower authentication errors

Symptoms: no updates arrive, and `docker compose logs watchtower` shows `unauthorized`, `denied`, `401` or `403` for `ghcr.io`. Causes: the token was revoked or lacks `read:packages`, or the credentials were stored through a credential helper that Watchtower cannot use.

```sh
sudo grep -c '"auth"' /etc/watchtower/config.json     # must print 1
sudo grep credsStore /etc/watchtower/config.json      # must print nothing
docker pull ghcr.io/rjgehan/notesapp:latest           # tests your own login with the same token
```

Fix: if `credsStore` is present, delete `/etc/watchtower/config.json`; then repeat step 8 with a valid token and `docker compose restart watchtower`. While it is broken, update by hand: `docker compose pull notes && docker compose up -d notes`.

### Watchtower runs but never updates

- A rollback override is still in place: `ls ~/notesapp/deploy/docker-compose.override.yml`.
- Watchtower is paused: `docker compose ps watchtower`.
- The label is missing: `docker inspect --format '{{index .Config.Labels "com.centurylinklabs.watchtower.enable"}}' notes-notes-1` must print `true`.
- Nothing was published: the push was docs-only, or CI was red (`gh run list` on rgpc).

### The app refuses to start

`docker compose logs notes` names the reason:

- **No kernel Tailscale interface.** `TS_USERSPACE: "false"`, the `/dev/net/tun` device or the `NET_ADMIN`/`NET_RAW` capabilities are missing from the `tailscale` service, typically after copying Tailscale's example compose file. Restore the repository's file (`git -C ~/notesapp diff`). Never work around it by allowing userspace mode: userspace Tailscale forwards every tailnet port to the app's loopback port, with forgeable identity headers (DESIGN §2.4).
- **Vault not writable:** `sudo chown -R 1000:1000 /srv/notes/data`.
- **Out of memory:** `docker inspect --format '{{.State.OOMKilled}}' notes-notes-1`. The container limit is 1 GB; the JVM exits on `OutOfMemoryError` and is restarted.
- **A required variable is missing:** Compose itself stops with `set NOTES_ALLOWED_HOSTS in deploy/.env` (or the logins variable). Fill in `.env`.

### `421 unknown-host`

The `Host` the browser used is not in `NOTES_ALLOWED_HOSTS`: a typo, a renamed node or a wrong tailnet name. Fix `.env`, then `docker compose up -d notes`.

### `403 identity-not-allowed`

The request's Tailscale login is not in `NOTES_IDENTITY_ALLOWED_LOGINS`. Compare with the [Users](https://login.tailscale.com/admin/users) page exactly. Requests from tagged devices (they carry no identity) and from users the node is shared with are refused by design.

### `403 funnel-request`

The request reached the app through Tailscale Funnel, which the app always refuses: `serve.json` allows Funnel on `:443`. Only `:8443` (the publish server) may have `AllowFunnel` true; restore `serve.json` from `serve.funnel.json.example` or the tailnet-only original ("Public publishing").

### Published pages answer `Not found`

Check, in order: `NOTES_PUBLISH_ENABLED=true` reached the container (`docker compose logs notes | grep -i publish`: *Publish server listening*, not *Public publishing is off*); the note is in **Settings › Publishing** and not marked *Page missing* (republish it); `tailscale funnel status` shows `:8443` with Funnel on (otherwise the tailnet policy lacks the `funnel` attribute). Any path other than `/p/<address>` answers `Not found` by design.

### Changes made over SSH appear late

`/api/status` shows `watcher.mode: polling` and the log has `WATCHER_DEGRADED`: the inotify limit was reached, so changes are picked up by the 5-minute rescan only. Raise the limit as in step 2 (go higher if needed, for example `1048576`), then `docker compose restart notes`.

### Saves fail with `permission-denied`

Files or folders were created as root. `/api/status` lists them under `vault.unwritableDirs`. Fix: `sudo chown -R 1000:1000 /srv/notes/data`, and edit as uid 1000 from now on.

### "History is not being saved" (`GIT_COMMIT_FAILED`)

`/api/status` shows `git.state: failing` with `lastError`. Edits are still saved to disk; only the commits wait, and they are retried with backoff (30 s up to every 5 minutes). Common causes:

- The disk is full: `df -h /srv/notes`.
- Files under `.git` belong to root (someone ran git as root in the vault): `sudo chown -R 1000:1000 /srv/notes/data/vault/.git`.
- A lock file left behind by a crash: these are removed at startup, so `docker compose restart notes`.

The next retry after the fix succeeds and the warning clears.

`git.state: disabled` with a `reason` instead means the repository is in a state the app will not touch: `HEAD is detached`, a merge or rebase in progress, or git-lfs. Saves keep working. Repair the repository as uid 1000 (for example `sudo -u '#1000' git -C /srv/notes/data/vault switch main`), then `docker compose restart notes`.

### "Mirror is not being updated" (`GIT_MIRROR_FAILED`)

Pushes to the GitHub mirror fail. The tooltip of the status-bar warning, **Settings › About** and `mirror.lastError` in `/api/status` give the reason. Nothing is lost: the vault and its history are unaffected, and the next successful push sends every commit made meanwhile. Retries come after 1, 5 and 15 minutes, then every 30 minutes; clicking the warning (or **Push history to the mirror now**) retries at once.

- **`not authorized`, `Authentication is required`, `git-receive-pack not permitted`:** the token expired, was revoked, or lacks *Contents: Read and write* on that repository. Rotate it (*Mirror to GitHub*).
- **`cannot read the token file` (`AccessDeniedException`):** `secrets/mirror-token` is not readable by uid 1000. Run `sudo chown 1000 ~/notesapp/deploy/secrets/mirror-token`, then `docker compose up -d --force-recreate notes`.
- **`the token file ... is empty`:** `NOTES_MIRROR_TOKEN_SECRET` is not set in `.env`, so the empty placeholder `deploy/mirror/no-token` is mounted.
- **`not found`, `repository not found`:** the URL is wrong, or the token was made for another repository.
- **`connection failed`, timeouts:** homeserver cannot reach github.com (`curl -sI https://github.com` on homeserver). It recovers on its own.
- **`GH001: Large files detected`, or another refusal by GitHub:** a file over 100 MB is in the history from before the large-file threshold applied, or the threshold is above 100 MB. Lower `NOTES_GIT_LARGE_FILE_THRESHOLD`. Versions already committed stay in the history, so the push keeps failing until that history is rewritten by hand, which NotesApp never does; make a full backup before attempting it.

**"Mirror is off: …"** (`mirror.state: disabled` with a `reason` other than *not configured*) means the configuration is refused and nothing is pushed: for example the SSH clone URL `git@github.com:…` (*not a valid URL*), an `http://` URL, or a URL with a token in it. The app logs it as `GIT_MIRROR_FAILED` at startup, so it also raises an app alert. Set `NOTES_MIRROR_URL` to the repository's plain `https://github.com/<you>/<repo>.git` URL and run `docker compose up -d`.

### "Mirror stopped: it has commits this vault does not"

The GitHub repository got commits that are not in the vault's history: it was created with a README, someone pushed to it, or it is the mirror of another vault. NotesApp only fast-forwards, so it stopped instead of overwriting them; the vault is unaffected. Look at the repository's commits on github.com, then either:

- **keep the vault's history** (the usual case): delete the repository on GitHub and create it again, empty (*Mirror to GitHub*, step 1; give the token access to the new repository); or
- **use another repository**: change `NOTES_MIRROR_URL` and run `docker compose up -d`.

Then run **Push history to the mirror now**; the warning clears when the push succeeds.

### Low disk space (`STORAGE_LOW`)

Free space on the vault's filesystem fell below 1 GiB: uploads are refused with `507`, and `/actuator/health` reports `DOWN`. Free up space on `/srv/notes`; `/api/status` shows how much the git history takes (`disk.repoBytes`).

### Settings are read-only

After a rollback, the settings file was written by a newer build. The older build uses what it can and shows a banner instead of overwriting the file. It clears when you return to `latest`.

### `external volume "notes-data" not found`

Step 4 was skipped or used other names. Create the volumes as in step 4, then `docker compose up -d`.

### "NotesApp backup failed"

The ntfy message names the steps that failed, never restic's output (its errors name your notes, and the topic may be on ntfy.sh). The status page's *Backups* card shows the last lines of each failing step (characters other than plain ASCII as `?`), and `docker compose logs --since 24h backup-scheduler` (with host cron, `~/notesapp-backup.log`) has restic's full output. A failed run never leaves NotesApp stopped on purpose: it starts it again first, and it alerts as *NotesApp is down after the backup* (urgent) when it cannot. Then run `docker compose up -d` and read `docker compose logs notes`.

- **`the local repository ... is not initialized`:** run `docker compose exec backup sh /backup/restic-job.sh init` (setup step 5).
- **`on the same filesystem as the vault`:** the backup disk is not mounted at `NOTES_BACKUP_LOCAL_REPO`. Check with `findmnt /mnt/backup`, mount it (`sudo mount /mnt/backup`), then `docker compose up -d --force-recreate backup`: a container only sees a disk that was mounted before it started. Do the same after unplugging and re-plugging a USB disk.
- **`backup container notes-backup-1 is not running`** (and `docker compose up -d` cannot start it, with *bind source path does not exist*): the same cause, an unmounted disk.
- **`wrong password` (restic exit 12):** `deploy/secrets/restic-password` is not the password the repository was created with. Restore it from your password manager.
- **`was started or replaced during the snapshot`:** a Watchtower update, or someone started NotesApp, while restic was reading. That snapshot was discarded because it may hold a half-written state; the next night takes a new one. Nothing to do unless it repeats.
- **`snapshot (restic exit 3, snapshot ... kept)`:** restic could not read some files: files removed over SSH while it was reading, or read errors on the vault's disk (`sudo dmesg | grep -i error`). The snapshot is kept but incomplete; restic's message in the log names the files.
- **`the snapshot was cancelled after 1800 s`:** the first snapshot of a large vault, or a very slow disk, took longer than NotesApp may be down. Run it once by hand with more time: `docker compose exec -e NOTES_BACKUP_MAX_STOP_SECONDS=14400 backup-scheduler sh /backup/nightly.sh`.
- **`off-site copy`:** the bucket, its keys or the network. Test with `docker compose exec backup sh /backup/restic-job.sh snapshots offsite`. The next successful run copies every snapshot that is missing off site, so nothing is lost while it is broken.
- **`repository check`:** read restic's message in the log. If the local repository is damaged, move its directory aside, run `init` again (it takes the chunker parameters from the off-site repository) and let the next run fill it; the off-site copy keeps the history.
- **`could not start: its state directory ... cannot be written`:** with host cron, the state directory was created by Docker as root because `NOTES_BACKUP_STATE` was mounted before the first run. Give it back to your user: `sudo chown -R "$(id -u):$(id -g)" ~/.local/state/notesapp-backup` (and `~/.local/state` or `~/.local`, if `ls -ld` shows them owned by root too), then run `sh ~/notesapp/deploy/backup/nightly.sh` once by hand.
- **`NotesApp backup skipped`:** the previous run was still going, typically the first off-site upload. If no run is going (`docker compose exec backup-scheduler cat /state/run.lock/pid`), `docker compose restart backup-scheduler` clears the lock.
- **`NotesApp backup interrupted`:** homeserver rebooted or the scheduler was restarted during a snapshot. NotesApp was started again and that snapshot was cancelled; the next night takes a new one.

### App alerts do not arrive

Open the status page; its *App alerts* card says what the app sees:

- **"off: no ntfy.json":** there is no `/srv/notes/data/secrets/ntfy.json` (*App alerts*, step 2).
- **`ntfy.json …` in red** (not valid JSON, no topic, a token over plain `http://`, or `cannot be read (AccessDeniedException)`): fix the file; for the last one, `sudo chown -R 1000:1000 /srv/notes/data/secrets`. The card updates within 30 seconds, without a restart.
- **"Last error: IOException: ntfy answered HTTP 403"** (or 401): the token, or the topic's access rules. **HTTP 429:** ntfy.sh's rate limit for your IP address. A connection error: homeserver cannot reach the server (`curl -sI https://ntfy.sh`).
- **Sent, but nothing on the phone:** the phone subscribes to another topic (check `alerts.topic`), or a self-hosted server lacks `upstream-base-url` for iOS.
- **"held back by the rate limit":** more than 10 alerts in an hour; the next alert says how many were skipped, and the status page lists every problem logged since the start.

### Voice notes: no microphone, or no transcript

- **"Microphone access was refused":** Safari › Settings for this website (the **aA** menu on the iPhone) › Microphone › Allow; in Chrome, the site settings icon left of the address. **"Recording needs the app's HTTPS address":** the app was opened over plain HTTP; use `https://notes.<tailnet>.ts.net`.
- **"Transcription is off":** `NOTES_TRANSCRIPTION_URL` is empty in the running container: `docker compose exec notes printenv NOTES_TRANSCRIPTION_URL`, then `docker compose up -d`.
- **"The transcription service failed: cannot connect to http://whisper:9000":** the `whisper` service is not running (`COMPOSE_PROFILES` lacks `transcription`) or is still downloading its model: `docker compose ps whisper` and `docker compose logs whisper`.
- **"… answered HTTP 500 (…)"**, or **"no answer within 600 s":** the service's own error, or a recording too long for the CPU and model; `docker compose logs whisper` has the details. Choose a smaller `NOTES_WHISPER_MODEL`, or raise `NOTES_TRANSCRIPTION_TIMEOUT` (default `10m`). The toast's **Retry** sends the recording again.
- **"No speech was recognized":** the recording is silent or too short; nothing is added.

### The status page says "AOT cache: not used"

The JVM could not use the AOT cache built into the image (DESIGN §7.1), usually because the arm64 image's training run failed under emulation; the publish job's log says so. NotesApp works normally and only starts a little slower. The next image build tries again.

### The status page says "No backup has reported here yet"

The app sees no `status.json`. With `backup-scheduler`, no run has finished yet (run one: *Run, pause or change the backups*). With host cron, set `NOTES_BACKUP_STATE` (*Host cron instead of backup-scheduler*); if the runs then fail with *state directory ... cannot be written*, see *"NotesApp backup failed"* above. "No backup for 2 days" instead means the runs have stopped: `docker compose ps backup-scheduler` and its logs.

### Ask your vault says it is unavailable

The *Ask* panel and **Settings › Ask and summaries** say why:

| Message | Fix |
|---|---|
| *Ask and summaries are off* | Switch on **Use Claude** in Settings. |
| *no Claude Code token: claude-token does not exist* (or *is empty*) | Save a token from `claude setup-token` in `/srv/notes/data/secrets/claude-token` (*Ask your vault*). |
| *the Claude Code CLI (…) is not installed on the server* | The image was built with `CLAUDE_CODE_VERSION=none`, or `NOTES_AI_CLAUDE_COMMAND` points nowhere. Use the published image, or mount the CLI and point the variable at it. |
| *Claude Code refused the token* (in an answer) | The token expired or was revoked: run `claude setup-token` again and replace the file. |
| *Your Claude plan's usage limit is reached for now* | Your subscription's limit; it resets on its own (the message usually says when). |
| *no API key: anthropic_key is empty* (Provider: Anthropic API) | `NOTES_AI_KEY_SECRET` is empty or the file is missing or empty; after setting it, `docker compose up -d`. |
| *… is not readable by the app's user (uid 1000)* | `sudo chown 1000 <file> && sudo chmod 600 <file>`. |
| *… must hold just the …, on one line* | The file has extra text; paste only the token or key. |
| *The Claude API refused the API key* / *rate-limiting this key* | The API key was revoked, or the console's spend limit is reached. |
| *This month's budget is used up* | NotesApp's own estimate reached **Monthly budget**: raise it in Settings, or wait for the next month. |
| *That is in a folder excluded from Ask and summaries* | The note is under **Never send** or the excluded files of **Files and links**, which is the point; remove it from there to allow it. |
