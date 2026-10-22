# VSM Toolbox

A local web application for mapping IT service value streams and documenting the processes that deliver them. Python 3.11+ and SQLite are the only runtime requirements; there are no third-party Python packages, external databases, or CDNs. Normal application use stays local; optional Admin updates contact GitHub.

## Features

- Create value streams with a customer, desired outcome, and description.
- Build a visual sequence of delivery steps; drag cards to reorder them.
- Assign responsible teams and record active work and waiting time in minutes.
- See total lead time, work time, and flow efficiency for each map.
- Maintain a shared process library with owners, descriptions, and work instructions.
- Link multiple processes to each step and reuse processes across streams.
- Read, create, update, and delete data through an authenticated JSON API.
- Create local accounts and assign Admin, Editor, or Viewer access.
- Check and install the latest GitHub main revision from the Administrator menu.

For example, map **Restore customer service**: report incident → triage → investigate → restore service → confirm resolution. Link incident classification, escalation, and service restoration procedures to the appropriate steps. Maps currently represent a linear current-state journey; branching, parallel flows, version history, and collaborative editing are future extensions.

## Development

```sh
python3 updater.py
# In another terminal:
python3 -m unittest discover -s tests -v
```

Open port 8080 in your browser. The default bind address is `127.0.0.1`. The application creates `data/vsm.sqlite3` on first launch. Create the first Admin account in the browser. `python3 app.py` also supports development without the update supervisor; web updates will be unavailable in that mode. No initial example data is inserted. Set `VSM_HOST`, `VSM_PORT`, and `VSM_DATABASE` to override defaults.

## Primary installation: Debian 13 LXC

Create a Debian 13 LXC using your container host's standard template, assign a stable address, and enable networking. No privileged container, Docker nesting, or external database is required. A small container with 1 CPU and 512 MB RAM is a reasonable starting allocation; size storage for your database and backups.

The installer installs Python 3, Git, CA certificates, curl, and account-management tools; creates an unprivileged `vsm` account; installs the application; enables the systemd service at boot; and waits for a successful API health check. It does not require pip, Docker, or an external database.

Run as root **inside the LXC**. From a checkout containing this installer:

```sh
bash scripts/install-debian13.sh --source-dir "$PWD"
```

Alternatively, once the installer is available on GitHub, download it for inspection and then run it:

```sh
apt-get update
apt-get install -y ca-certificates curl
curl --fail --show-error --location \
  https://raw.githubusercontent.com/CoxkeLamagra/VSM-Toolbox/main/scripts/install-debian13.sh \
  --output /root/install-vsm-toolbox.sh
# Inspect /root/install-vsm-toolbox.sh before running it.
bash /root/install-vsm-toolbox.sh
```

The default downloads `main` from GitHub over verified HTTPS. Use `--ref <tag-or-commit>` to select a reviewed version **that contains the application and service files**. This installer requires a revision containing `updater.py` and `update-manifest.json`; the older `v0.1.0` tag predates this update protocol and requires its original installer instructions. `--source-dir` and `--ref` cannot be combined. Internet access to Debian package mirrors and, unless using local source, GitHub is required. Run `bash scripts/install-debian13.sh --help` for usage.

Open `http://<LXC-IP>:8080` from your trusted network. Installation paths:

| Path | Purpose |
|---|---|
| `/opt/vsm-toolbox` | Symlink to the active application release |
| `/opt/vsm-toolbox-releases/` | Root-owned application releases retained for recovery |
| `/var/lib/vsm-toolbox/vsm.sqlite3` | Persistent local database, owned by `vsm` |
| `/etc/systemd/system/vsm-toolbox.service` | Service definition |
| `/var/backups/vsm-toolbox/` | Root-only database backups made before reinstalls/updates |

Run the same installer again to update or reinstall. It preserves the database, backs it up before changing the running application, installs code in a new release directory, and switches the active symlink. If startup fails it restores the previous application and service state; database backups remain available, but the database is not automatically reverted. Package installations are not rolled back. Old code releases and backups are retained; review disk usage periodically.

The installer refuses to overwrite an existing `/opt/vsm-toolbox` installation that it did not create. To migrate the earlier manual installation, stop `vsm-toolbox`, back up `/var/lib/vsm-toolbox/vsm.sqlite3`, and move the old `/opt/vsm-toolbox` directory to a safe archive path before running the installer. The existing `vsm` account must be non-root and belong only to its private `vsm` group. Existing systemd drop-ins are preserved; incompatible custom overrides can cause the health check to fail.

The installer starts the unprivileged update supervisor, which manages the web process.

Diagnose startup with `systemctl status vsm-toolbox` and `journalctl -u vsm-toolbox`. The installer uses port 8080 and binds on all container interfaces; it does not modify your firewall or install a reverse proxy. No privileged LXC features or Docker nesting are needed.

## Local accounts and permissions

On an empty accounts database, the sign-in page offers **Create your Admin account**. The first successful registration becomes Admin, and public registration then closes. Registration is serialized so simultaneous requests cannot create multiple first accounts. Existing value streams and processes remain intact when upgrading from a version without accounts. Complete initial registration before opening access to other users.

Open **Administrator → Account administration** to create accounts or use **Account Overview** to edit usernames, reset passwords, assign a role, and remove accounts. Each account has one of these predefined roles:

| Role | Access |
|---|---|
| Admin | All content, local account management, and application updates |
| Editor | Read, create, edit and remove streams, steps and processes |
| Viewer | Read streams and process documentation only |

Usernames are case-insensitive and contain 3–64 letters, numbers, dots, underscores or hyphens. Passwords contain 12–128 characters and are stored as individually salted PBKDF2-SHA256 hashes (600,000 iterations). Passwords are never returned by the API. There are no external identity providers or default credentials. Admins reset passwords locally; automated email recovery is not included. The last Admin cannot be removed or demoted.

Sessions last up to 12 hours and use opaque HttpOnly, SameSite=Strict cookies. Password, username or role changes revoke that account's sessions; removal immediately revokes access. Sign-in attempts are limited to ten failures per client IP per five-minute window. Application mutations require both an authenticated session and its CSRF token; read-only controls are also enforced by the API.

Use a trusted private network and HTTPS when carrying credentials beyond the local machine. TLS is provided by your reverse proxy. When serving exclusively over HTTPS, set `VSM_COOKIE_SECURE=1` in the service environment or Docker configuration so browsers only send session cookies over HTTPS. The application does not trust forwarding headers to change cookie security automatically. Keep the Python HTTP service behind your private-network boundary or reverse proxy.

## Updates from the Administrator menu

Open **Administrator → Application updates**, select **Check for updates**, then **Update from main**. This targets the latest commit published to the repository's `main` branch, rather than the latest GitHub Release tag. Only Admins can request or view updates; the source repository and branch cannot be overridden through the API.

The supervisor checks the GitHub commit, downloads that exact revision over verified HTTPS, validates the supported update manifest and Python syntax, stops the web process, and makes an integrity-checked SQLite backup. It starts the new application, checks its revision and health, and revokes existing sessions after success. Sign in again after installation. If startup fails, it restores the previous application **and database**. A persistent recovery record also allows the supervisor to recover an interrupted installation on its next start. Writes pause during installation; checking and downloading leave the application available.

Update code, activation state and backups live under `updates/` beside the database (`/var/lib/vsm-toolbox/updates` in LXC; `/data/updates` in Docker). Retain this directory along with the database. Applied code and activation state survive service/container restarts and container recreation with the same data volume. No root access, Docker socket, package manager, or privileged container is used for web updates. Old releases and backups are retained; monitor storage usage and keep external backups as well.

GitHub access to `api.github.com` and `codeload.github.com` is required for checking/downloading updates. Normal local use does not need these destinations. Public repositories use anonymous GitHub access by default. For a private repository or higher API rate limits, optionally configure `VSM_GITHUB_TOKEN` with repository contents read permission before starting the service. In LXC, systemd reads optional settings from `/etc/default/vsm-toolbox` (keep it root-owned with mode `0600`); Compose forwards this variable from its host environment. The token is used only on the initial GitHub API request, never exposed in the UI or API and never forwarded to redirected download hosts. Rate limits, access denials and network failures are reported on the update page without changing the installed application. Releases that require a different Python version, dependencies or update protocol are rejected and require the Debian installer or a new Docker image. The updater engine and base OS/image are maintained through the installer/image; web updates replace the application code and assets.

**One-time upgrade from v0.1.0:** install this version using the updated Debian installer, or rebuild/recreate the Docker container once. That enables the supervisor and Admin menu. Subsequent compatible application updates need only the web UI. A deliberate installer rerun clears the previous web-update activation and selects the newly installed code. Docker retains web-update activation in its volume; to deliberately replace it with the image's bundled code, stop the container, archive `/data/updates/active.json`, then recreate it with the selected image. Back up the database before any downgrade.

## Docker alternative

```sh
docker compose up -d --build
docker compose exec vsm python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8080/api/health').read().decode())"
```

The named `vsm-data` volume persists the database. Compose publishes on host loopback by default; use a private-network binding or a reverse proxy if remote access is needed. Do not remove the volume when updating. The image runs as UID 10001; bind-mounted data directories must be writable by that UID.

## API

All requests and responses use JSON. IDs are integers; updates accept a subset of the documented fields. Successful creation returns 201, reads/updates/deletes return 200, update requests return 202, invalid requests return 400, unauthenticated requests return 401, insufficient permissions return 403, missing resources return 404, account/update conflicts return 409, and throttled sign-ins return 429. Send `Content-Type: application/json` for every POST, PUT or DELETE (an empty body can be `{}`).

First sign in with `POST /api/auth/login`, retain the returned session cookie, and pass the response's `csrf_token` in `X-CSRF-Token` on each mutation. `GET /api/session` retrieves the current user and CSRF token. Except for health and session status, all data reads require a session; all content writes require Admin or Editor. Account and update operations require Admin.

| Route | Methods | Fields / purpose |
|---|---|---|
| `/api/health` | GET | Public health, running revision and update protocol |
| `/api/session` | GET | Current account, CSRF token, and whether first registration is required |
| `/api/auth/register` | POST | First account only: `username`, `password`; always creates Admin |
| `/api/auth/login` | POST | `username`, `password`; sets cookie and returns CSRF token |
| `/api/auth/logout` | POST | Revokes current session |
| `/api/users` | GET, POST | Admin account list/create: `username`, `password`, `role` (defaults to Viewer) |
| `/api/users/{id}` | GET, PUT, DELETE | Admin account read/edit/remove; omit password on edit to keep it |
| `/api/roles` | GET | Admin-only list of assignable roles |
| `/api/updates` | GET | Admin-only installed/latest revision, operation status and availability |
| `/api/updates/check` | POST | Admin-only queue a GitHub check; empty object |
| `/api/updates/install` | POST | Admin-only queue update from main; empty object |
| `/api/data` | GET | Complete workspace including links |
| `/api/streams` | GET, POST | `name` (required), `customer`, `outcome`, `description` |
| `/api/streams/{id}` | GET, PUT, DELETE | Read/update/delete a stream; deletion cascades to steps |
| `/api/steps` | GET, POST | `name`, `stream_id` (required), `owner`, `position`, `work_minutes`, `wait_minutes` |
| `/api/steps/{id}` | GET, PUT, DELETE | Read/update/delete a step |
| `/api/processes` | GET, POST | `name` (required), `owner`, `description`, `procedure` |
| `/api/processes/{id}` | GET, PUT, DELETE | Read/update/delete a process |
| `/api/steps/{id}/processes` | PUT | Replace links with `{"process_ids": [1, 2]}`; empty list unlinks all |

```sh
# After logging in and saving its cookie in session.cookies and CSRF token in CSRF_TOKEN:
curl -X POST http://127.0.0.1:8080/api/streams \
  --cookie session.cookies \
  -H "X-CSRF-Token: $CSRF_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Restore customer service","customer":"Managed service customer","outcome":"Service restored"}'
```

Work/wait times must be finite nonnegative numbers in minutes. Flow efficiency is work time divided by work plus waiting time. A process can link to many steps; deleting a stream preserves its processes. Reordering saves positions through step updates. This version assumes one editor at a time; simultaneous edits are not conflict managed.

## Backups

Use SQLite's backup API to obtain a consistent live backup (choose a protected destination outside the checkout):

```sh
python3 - <<'PY'
import sqlite3
with sqlite3.connect('/var/lib/vsm-toolbox/vsm.sqlite3') as source:
    with sqlite3.connect('/var/backups/vsm-toolbox.sqlite3') as target:
        source.backup(target)
PY
```

Run with permission to read the source and write the destination; restrict backup file permissions and keep copies off the LXC. To restore, stop the service, replace the database with a backup, ensure `vsm:vsm` ownership, and restart. Docker backups can use the same Python API against `/data/vsm.sqlite3` inside the container, writing to an attached backup mount.
