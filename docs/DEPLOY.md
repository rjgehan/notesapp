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

**Optional: import an existing Obsidian vault** now, before the first start:

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
6. **Backups:** take the first full backup and do the restore drill once (Part 2).

---

## Part 2: Operations

### Where things are

| What | Where |
|---|---|
| Deploy files | `~/notesapp/deploy` (a git checkout; update with `git pull`) |
| Secrets | `~/notesapp/deploy/.env` (mode 600) and `/etc/watchtower/config.json` (root, mode 600) |
| Vault: notes, attachments, `.git`, `.trash`, `.notesapp` | `/srv/notes/data/vault` (volume `notes-data`, mounted at `/data`) |
| Tailscale identity and certificates | volume `tailscale-state` |
| Containers | `notes-tailscale-1`, `notes-notes-1`, `notes-watchtower-1` |

### Updates

- **The app updates itself.** Watchtower checks GHCR every 5 minutes, so a green push to `main` is live a few minutes after its publish job finishes; the weekly scheduled rebuild arrives the same way. Each update session is reported to ntfy if configured. During the 10–30 s restart the app answers `502`; open tabs show *Reconnecting* and recover on their own.
- **Which build is running:** `buildSha` in `https://notes.<tailnet>.ts.net/api/status`, or
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

### Monthly: update Tailscale and Watchtower

Neither is updated automatically: a Tailscale restart briefly cuts the app off (Part 3), and Watchtower is pinned by digest because it holds the Docker socket. Dependabot proposes the Watchtower bump as a PR; merge it first.

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

Stable ERROR markers to search for (DESIGN §5.18): `GIT_COMMIT_FAILED`, `WATCHER_DEGRADED`, `TAILSCALE_WATCHDOG_EXIT`, `STORAGE_LOW`, `SETTINGS_READ_ONLY`. Logs are rotated at 5 × 10 MB per container. Note content and search queries are never logged; paths are.

### Monitoring

Three signals: Watchtower's ntfy reports, an external `/readyz` probe, and the ERROR markers above.

**Probe from `beach`** (any always-on tailnet machine with cron), every 5 minutes, posting to the same ntfy topic on failure. The retries ride out the restart of a normal deploy:

```sh
crontab -e
```

```
*/5 * * * * curl -fsS -m 10 --retry 4 --retry-delay 15 --retry-all-errors -o /dev/null https://notes.<tailnet>.ts.net/readyz || curl -fsS -m 20 -H 'Title: NotesApp is down' -d 'readyz failed from beach' https://ntfy.sh/notes-<hex>
```

`/readyz` is exempt from the identity allowlist, so the probe also works from a tagged machine; with the step 6 policy, that machine's tag then needs `{ "src": ["tag:<its tag>"], "dst": ["tag:notes"], "ip": ["tcp:443"] }`.

**Disk:** `/api/status` shows `disk.freeBytes` and the size of the git repository (`disk.repoBytes`). Uploads are refused below 1 GiB free.

### Backups

v1 has no automatic backups (ROADMAP item 1). Everything lives on one disk, so copy backups to **another** disk or machine; `/mnt/backup` below stands for that.

**Git history only, no downtime.** Contains every committed note and attachment and the settings, but not the trash or the last few minutes of uncommitted edits. Run **Commit pending changes now** from the command palette first, then:

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

Take a full backup before releases that change moving and renaming, the trash or the git integration (`MoveService`, `TrashService`, `GitStore`). Keep the `alpine/git` tag current: pin the newest version from Docker Hub.

### Restore

Replace the vault with a backup. The current vault is moved aside, not deleted.

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

Then start and check:

```sh
docker compose start notes
docker run --rm -v notes-data:/data:ro alpine/git:2.54.0 -c safe.directory='*' -C /data/vault log --oneline -5
```

`/api/status` should show the expected `vault.notes` count and `git.head`, and the history panel the expected commits. Once you are satisfied, `sudo rm -rf /srv/notes/data/vault.before-restore`.

### Restore drill

Do this once after the first deploy, and again whenever the backup routine changes. It restores the backups into a scratch directory and boots a throwaway copy of the app there, with no network at all; production keeps running.

```sh
B=/mnt/backup/notes-$(date +%F)          # backups taken today, as above
D=/srv/notes/drill
sudo install -d -o 1000 -g 1000 "$D" "$D/.config"

# Restore the full backup (or, to test the bundle instead, the clone command from Restore with -v "$D":/r)
sudo tar xzf "$B.tgz" -C "$D"

# Boot it: no network, not even a bridge, so nothing can reach it
docker run -d --name notes-drill --network none -v "$D":/data \
  -e NOTES_ALLOWED_HOSTS=localhost -e NOTES_SECURITY_REQUIRE_TAILSCALE_INTERFACE=false \
  ghcr.io/rjgehan/notesapp:latest
for i in $(seq 60); do docker exec notes-drill curl -fsS http://127.0.0.1:8080/readyz && break; sleep 2; done; echo

# Compare with production's /api/status at backup time: vault.notes, vault.files, git.head
docker exec notes-drill curl -fsS -H 'Host: localhost' -H 'Tailscale-User-Login: drill@localhost' \
  http://127.0.0.1:8080/api/status; echo
docker run --rm -v "$D":/data:ro alpine/git:2.54.0 -c safe.directory='*' -C /data/vault log --oneline -3

# Clean up
docker rm -f notes-drill
sudo rm -rf "$D"
```

If `readyz` never answers, `docker logs notes-drill` shows why. The drill container has no identity allowlist configured, so the made-up login header is accepted; it is reachable only through `docker exec`.

### Import an existing Obsidian vault later

Before the first start, use step 4. Into a running installation: stop the app, copy the vault into a subfolder, remove the copy's own `.git` and `.obsidian` (a nested repository would hide the folder from the vault's history), fix the owner, and start again. The app commits the new files as `Changes made while NotesApp was stopped`.

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

### Low disk space (`STORAGE_LOW`)

Free space on the vault's filesystem fell below 1 GiB: uploads are refused with `507`, and `/actuator/health` reports `DOWN`. Free up space on `/srv/notes`; `/api/status` shows how much the git history takes (`disk.repoBytes`).

### Settings are read-only

After a rollback, the settings file was written by a newer build. The older build uses what it can and shows a banner instead of overwriting the file. It clears when you return to `latest`.

### `external volume "notes-data" not found`

Step 4 was skipped or used other names. Create the volumes as in step 4, then `docker compose up -d`.
