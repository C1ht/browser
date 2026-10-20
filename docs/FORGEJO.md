# Self-hosted CI with Forgejo

Builds and tests run on the home Proxmox server instead of GitHub Actions. There are three guests:

```
internet ── VPS reverse proxy ── Forgejo (LXC)  ← git, web UI, Actions scheduler
                                    │
                    LAN ────────────┼───────────────────────────┐
                                    │                           │
                   Linux build VM (forgejo-runner, host mode)  Windows test VM
                   builds Linux and Windows, runs Linux tests   (Server 2025, OpenSSH)
                   ──────────────── SSH ─────────────────────▶ runs Windows tests
```

- Forgejo's runner only ships for Linux (v13.2.0 has linux-amd64 and linux-arm64 builds only). The Windows test VM is therefore not a runner: the Linux runner copies each Windows build to it and runs the checks there over SSH (`tools/ci/windows-smoke.sh`).
- The build VM keeps the Gecko checkouts, build directories and toolchains in `/srv/gecko-ci` between runs, so a rebuild only redoes what changed.

Expected times, from GitHub's runners and the hardware (not yet measured here):

| Build | Time |
|---|---|
| First full build | about 35–50 minutes per platform |
| After an app C++ change | a few minutes |
| After a JS, CSS or string change | about a minute plus packaging |

Workflows live in `.forgejo/workflows/`:

| Workflow | What it runs |
|---|---|
| `release.yml` | Builds both platforms and runs the smoke tests. Optionally publishes a Forgejo release. |
| `adblock.yml` | The network blocker's reference and stress checks. |

`.github/workflows/` stays for GitHub. Remove it if Forgejo shows those workflows too: no runner has GitHub's labels, so their jobs would wait forever.

## 1. Forgejo (LXC container)

**Container:** Debian 12 template, 2 cores, 2–4 GB RAM, 20 GB disk. Give it a fixed LAN address, called `FORGEJO_LAN` below.

**Install** Forgejo 17.0.0, as root in the container:

```sh
apt install -y git git-lfs curl gnupg
adduser --system --shell /bin/bash --group --disabled-password --home /home/git git
curl -fLo /usr/local/bin/forgejo https://codeberg.org/forgejo/forgejo/releases/download/v17.0.0/forgejo-17.0.0-linux-amd64
curl -fLo /tmp/forgejo.asc https://codeberg.org/forgejo/forgejo/releases/download/v17.0.0/forgejo-17.0.0-linux-amd64.asc
gpg --keyserver keys.openpgp.org --recv EB114F5E6C0DC2BCDD183550A4B61A2DC5923710
gpg --verify /tmp/forgejo.asc /usr/local/bin/forgejo
chmod 755 /usr/local/bin/forgejo
mkdir -p /var/lib/forgejo /etc/forgejo
chown git:git /var/lib/forgejo && chmod 750 /var/lib/forgejo
chown root:git /etc/forgejo && chmod 770 /etc/forgejo
curl -fLo /etc/systemd/system/forgejo.service https://codeberg.org/forgejo/forgejo/raw/branch/forgejo/contrib/systemd/forgejo.service
systemctl enable --now forgejo
```

**First-run page:** open `http://FORGEJO_LAN:3000` and set:
- the database to SQLite;
- the server domain to `git.example.com` (your domain);
- the base URL to `https://git.example.com/`.

Create your admin account there.

**Settings** in `/etc/forgejo/app.ini`. Restart Forgejo afterwards; once it's set up, make the directory and file read-only for `git`.

```ini
[service]
DISABLE_REGISTRATION = true        ; only you; add users by hand if ever needed

[actions]
ENABLED = true
DEFAULT_ACTIONS_URL = https://data.forgejo.org
; Forgejo stops jobs after 3 h by default. A first build with bootstrap fits,
; but leave room.
ENDLESS_TASK_TIMEOUT = 6h

[attachment]
MAX_SIZE = 1024                    ; MB per file; release assets are ~120 MB
```

Turn on two-factor authentication for your account under Settings → Security.

## 2. The VPS reverse proxy

Point `https://git.example.com` at `http://FORGEJO_LAN:3000` the way your other services are set up.

**Body size and timeouts.** Release assets (~120 MB each) and build artifacts go through the proxy, so raise its body limit and timeouts. For nginx:

```nginx
client_max_body_size 1g;
proxy_read_timeout 600s;
proxy_send_timeout 600s;
proxy_request_buffering off;
```

Caddy needs nothing extra.

**Git over SSH.** Either use HTTPS only, which is the simplest, or forward a TCP port from the VPS (for example 2222) to `FORGEJO_LAN:22`. Then set `SSH_PORT = 2222` under `[server]`.

**Traffic.** The runner talks to Forgejo through the public URL, so checkouts and artifacts make a round trip through the VPS. That's fine at these sizes.

If it ever matters, give the build VM a hosts entry so `git.example.com` resolves to the LAN address. It then needs a valid certificate for that name on the LAN side too.

## 3. Linux build VM (the runner)

**Proxmox settings:**
- Debian 13, which brings Node 20 for the JavaScript actions and Python 3.13.
- CPU: **48 vCPUs, type `host`**, NUMA on.
- Memory: **96 GB**.
- Disk: **200 GB** on SSD storage, VirtIO SCSI single, with discard, IO thread and `cache=none`.

**Packages and the runner user**, as root:

```sh
apt install -y git curl rsync python3 python3-venv nodejs strace msitools sudo gnupg openssh-client
useradd --create-home --shell /bin/bash runner
mkdir -p /srv/gecko-ci && chown runner:runner /srv/gecko-ci
```

**One-time bootstrap.** This step installs the system packages Gecko's build needs, so it needs sudo. Run it from a scratch checkout as `runner`, with temporary sudo rights:

```sh
usermod -aG sudo runner      # for this step only
su - runner
git clone https://git.example.com/YOU/browser.git /tmp/browser
GECKO_DIR=/srv/gecko-ci/linux-x86_64/mozilla-central /tmp/browser/tools/fetch-gecko.sh
cd /srv/gecko-ci/linux-x86_64/mozilla-central
MOZBUILD_STATE_PATH=/srv/gecko-ci/mozbuild MOZCONFIG=/tmp/browser/mozconfigs/ci-linux \
  ./mach bootstrap --application-choice "Firefox for Desktop"
exit
deluser runner sudo          # the workflows bootstrap with --no-system-changes
```

**forgejo-runner 13.2.0:**

```sh
curl -fLo /usr/local/bin/forgejo-runner https://code.forgejo.org/forgejo/runner/releases/download/v13.2.0/forgejo-runner-13.2.0-linux-amd64
curl -fLo /tmp/runner.asc https://code.forgejo.org/forgejo/runner/releases/download/v13.2.0/forgejo-runner-13.2.0-linux-amd64.asc
gpg --keyserver hkps://keys.openpgp.org --recv EB114F5E6C0DC2BCDD183550A4B61A2DC5923710
gpg --verify /tmp/runner.asc /usr/local/bin/forgejo-runner && chmod 755 /usr/local/bin/forgejo-runner
su - runner -c 'forgejo-runner generate-config > ~/runner-config.yml'
```

**Configuration.** In the repository on Forgejo, go to Settings → Actions → Runners → **Create new runner** and copy the UUID and token it shows. Then edit `/home/runner/runner-config.yml`:

```yaml
runner:
  capacity: 1          # one job at a time: a Gecko build uses every core
  timeout: 6h
  shutdown_timeout: 6h
  labels: ["gecko-linux:host"]
host:
  workdir_parent: /srv/gecko-ci/jobs
server:
  connections:
    forgejo:
      url: https://git.example.com/
      uuid: <uuid>
      token: <token>
```

**Service:** install the runner's systemd unit, which runs as `runner` from `/home/runner`, and start it:

```sh
curl -fLo /etc/systemd/system/forgejo-runner.service https://code.forgejo.org/forgejo/runner/raw/branch/main/contrib/forgejo-runner.service
systemctl enable --now forgejo-runner
```

**Isolation.** In host mode a job runs as `runner` with no isolation. That's acceptable because only you can push and trigger workflows (section 6). Never let pull requests from forks run on this runner.

## 4. Windows test VM

**Proxmox settings:**
- OS: Windows Server 2025, Desktop Experience. The free 180-day evaluation from Microsoft's Evaluation Center is enough. `slmgr /rearm` extends it, and `DISM /online /Set-Edition` converts it to a paid edition in place.
- Firmware: OVMF (UEFI), with an EFI disk and a **vTPM 2.0**.
- CPU: 8 vCPUs, type `host`. Memory: 16 GB. Disk: 80 GB, VirtIO SCSI.
- Attach the VirtIO drivers ISO during installation.

**Software:**
- **Python 3**, installed for all users with "Add python.exe to PATH" ticked.
- **OpenSSH server.** In an administrator PowerShell:

  ```powershell
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
  Set-Service sshd -StartupType Automatic; Start-Service sshd
  New-LocalUser ci -Password (Read-Host -AsSecureString "Password for ci")
  Add-LocalGroupMember Users ci
  New-Item -ItemType Directory C:\ci; icacls C:\ci /grant "ci:(OI)(CI)M"
  ```

**SSH access from the runner:**

1. On the build VM, as `runner`, create a key: `ssh-keygen -t ed25519 -N ""`.
2. Put the public key in `C:\Users\ci\.ssh\authorized_keys` on the Windows VM. Log in once as `ci` first so the profile exists.
3. Make sure only `ci` and SYSTEM can read that file.
4. Test it from the build VM: `ssh ci@WINDOWS_VM python --version`.

## 5. Moving the repository

1. In Forgejo, choose **+ → New migration → GitHub**:
   - URL: `https://github.com/C1ht/browser`.
   - Tick releases.
   - No token is needed while the GitHub repo is public.
2. Under the repository's Settings → Actions:
   - Enable Actions.
   - Add the **variable** `WINDOWS_TEST_HOST` = `ci@WINDOWS_VM`.
   - Add the **secret** `RELEASE_TOKEN`: an access token with `write:repository`, made under your user settings → Applications. Only the publish step uses it.
3. Decide what happens to GitHub. Either keep it as a public mirror (Forgejo: Settings → Repository → Mirror settings → push mirror to GitHub), or archive it there.

## 6. Security, since Forgejo is reachable from the internet

- **Accounts:** registration is off, and your account has two-factor authentication.
- **Runner scope:** the runner is registered to this repository only, not instance-wide.
- **Workflow triggers:**
  - The workflows run on `workflow_dispatch` (Actions → Run workflow) and on pushes. Only accounts with write access can push.
  - If the repository is public on Forgejo, others can fork it but cannot push. In Settings → Actions, keep "require approval" for workflows from forks, and never approve them on this runner.
- **SSH to the Windows VM:** the runner's key reaches only the unprivileged `ci` user.

## 7. First run

1. Go to Actions → Release → Run workflow. Set the tag to e.g. `v0.0.0-forgejo.1`, turn publish off, and choose both platforms.
2. The first run fetches Gecko for each platform, bootstraps the Windows toolchains (`/srv/gecko-ci/mozbuild`) and builds from scratch. Later runs reuse all of that.
3. To force a full rebuild, run the workflow with **clobber** ticked.
4. Disk use settles around 100–120 GB:
   - per platform, a Gecko checkout (~6 GB) and its build directory (~35–45 GB);
   - toolchains (~15 GB);
   - job workspaces, which the runner deletes.

The password-manager branch has its own workflow (`passwords.yml`). It moves to `.forgejo/workflows/` when that work continues.
