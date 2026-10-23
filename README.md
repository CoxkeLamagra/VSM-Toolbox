# VSM Toolbox

A local web application for mapping IT service value streams and documenting the processes that deliver them. Python 3.11+ and SQLite are the only runtime requirements; there are no third-party Python packages, external databases, or CDNs. Normal application use stays local; optional Admin updates contact GitHub.

## Features

- Create value streams with a customer, desired outcome, and description.
- Explore an interactive diagram with delivery steps, customer outcomes, and all linked processes. Pan, drag cards, zoom with the mouse wheel or touch pinch, and fit the whole map to the screen.
- Use Edit flow to manage delivery steps and reorder their sequence.
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

## Interactive value stream diagrams

Open a value stream and select **Diagram**. Solid green arrows show the delivery sequence, and dashed blue connectors link steps to their supporting processes. Every process linked to a step in the selected stream is included. A shared process appears once with connectors to all relevant steps.

- Drag empty background to pan; drag a card to arrange the visual. Connectors follow the cards.
- Use **+**, **−**, the mouse wheel, or a two-finger pinch to zoom. Zoom follows the pointer or pinch center.
- Use **Fit to screen** to see the complete map, or **Reset layout** to restore the automatic arrangement.
- Double-click a step or process, or focus it and press Enter, to open its details. Existing Admin/Editor/Viewer permissions still apply.
- With the diagram focused, arrow keys pan, **+ / −** zoom, and **0** fits. With a card focused, arrow keys move it; Shift moves it farther.

Visual layout and zoom are saved per account and stream in the current browser. They do not change shared data, process links, or delivery order. Viewers can explore and arrange their own visual without gaining editing access. Use **Edit flow** to change the actual step sequence and manage process links. Layouts are personal to a browser, rather than shared server layouts.

Optional browser integration checks run against a temporary database and server, never your existing workspace. With Playwright and its Chromium browser installed in your development environment, run `node tests/diagram.cjs`. `VSM_CHROMIUM` can select an existing Chromium binary, and `PYTHON` can select the Python executable. This checks pan, drag, zoom, fit/reset, keyboard access, process connectors, layout persistence, Viewer restrictions, and touch pinch. Playwright is a development check only; the deployed application still has no third-party runtime dependencies.

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

## Automatic startup after reboot

For the primary Debian 13 LXC installation, the installer enables `vsm-toolbox.service` for `multi-user.target` and verifies that it is enabled before reporting success. The supervisor and application start automatically when the LXC boots, using the existing database and any activated web update. The service also restarts automatically if its supervisor exits, with a five-second retry delay. Local startup does not require GitHub connectivity.

To enable startup for an existing installation or inspect the setting, run inside the LXC:

```sh
systemctl enable --now vsm-toolbox.service
systemctl is-enabled vsm-toolbox.service
systemctl status vsm-toolbox.service
# After a normal reboot:
journalctl -b -u vsm-toolbox.service
curl --fail http://127.0.0.1:8080/api/health
```

The LXC host must also start the container itself after a physical host reboot. For Proxmox, enable **Start at boot** for the container (or run `pct set <CTID> -onboot 1` on the Proxmox host). For other LXC hosts, enable the equivalent container autostart option. The application installer runs inside the container and cannot configure its host.

For Docker, Compose specifies `restart: always`. After running `docker compose up -d --build` once, Docker restores the existing container after its daemon starts; the named volume preserves accounts, data, and web updates. On a Debian Docker host, enable the daemon with `systemctl enable --now docker.service`. A manual container stop suppresses restarts until it is started again or the daemon restarts; `docker compose down` removes the container and requires `docker compose up -d` to recreate it. The container host's own boot policy remains a host setting.

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

The supervisor checks the GitHub commit, downloads that exact revision over verified HTTPS, validates the supported update manifest and Python syntax, stops the web process, and creates a self-contained, integrity-checked application-and-database backup before switching code. Failure to create the backup cancels installation. It starts the new application, checks its revision and health, and revokes existing sessions after success. Sign in again after installation. If startup fails, it reconstructs the previous application **and database from the backup archive**, even when the original code directory is missing. A persistent recovery record also allows the supervisor to recover an interrupted installation on its next start. Writes pause during installation; checking and downloading leave the application available.

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

## Backups and restore from the Admin interface

Open **Administrator → Backups & restore**. Only Admin accounts can list or download backups, create manual backups, upload, restore, or delete backup files. All write actions require the session's CSRF token. Manual backup and restore work offline, without GitHub access.

- **Create manual backup** keeps the web server running and uses SQLite’s online backup API to produce a `.vsm-backup.zip` containing the six application runtime files, the SQLite database (including local accounts), revision metadata, and checksums. Writes pause during capture; reads remain available.
- **Download** saves a server backup to your computer. Keep copies on another system to protect against disk failure.
- **Restore** beside a saved backup restores that application's code, accounts, and database. The selected archive is validated before the application stops. A full **pre-restore safety backup** captures the current state before any replacement; failed startup restores that safety snapshot.
- **Upload and restore** accepts a trusted `.vsm-backup.zip` (maximum 128 MiB compressed and unpacked). Archive paths, regular-file types, exact file membership, checksums, Python syntax, runtime compatibility, SQLite integrity/schema and the presence of an Admin account are checked. Arbitrary archive paths and symlinks are never extracted. Invalid uploads are rejected without changing the running workspace.
- **Delete selected backups** permanently removes only explicitly selected files after confirmation. Backups referenced by an active recovery record are protected. Legacy database-only files in the application's backup directory can be downloaded or deleted, but are not offered as full application restore points.

A successful restore revokes sessions. Sign in using an account and password contained in the restored backup; newer accounts and data are replaced by the selected snapshot. Full backups contain executable application code and local account hashes: restore only trusted backups and protect downloaded files. Checksums detect corruption, not maliciously modified archives. The service remains unprivileged throughout.

Archives are retained under `/var/lib/vsm-toolbox/updates/backups` in LXC or `/data/updates/backups` in Docker. Files use mode `0600` and the directory uses `0700`. No automatic retention deletion is applied; use selective cleanup to manage disk usage. Installer-created, root-owned database backups under `/var/backups/vsm-toolbox` are separate and are not deleted by the web interface. Backups do not include the base OS, systemd/Compose settings, external TLS certificates, environment secrets, browser-only diagram layouts, or other backup archives.

Every UI update which proceeds to installation first creates a full **pre-update** snapshot. Download/validation failures leave the current application running; backup failures prevent code activation. Failed activation, and recovery after an interrupted activation, restore code and data from the snapshot. For both updates and restores, the recovery record remains until the new application passes its health check. This protects data even if the previous source directory has been removed.

**Upgrade existing supervisors once:** rerun this version's Debian installer or rebuild/recreate the Docker container to install the enhanced supervisor. New backup controls and UI installation requests reject an older supervisor that cannot guarantee a full application backup. A web-only application update does not replace the long-running supervisor engine. Subsequent compatible updates and backup operations use the Admin interface.

Additional API routes:

| Route | Method | Purpose |
|---|---|---|
| `/api/backups` | GET | Admin-only backup list, supervisor capability and operation status |
| `/api/backups/create` | POST | Queue a full manual snapshot; `{}` |
| `/api/backups/{id}/download` | GET | Download a saved backup |
| `/api/backups/upload` | POST | Validate and retain a raw archive; `Content-Type: application/octet-stream`, returns its `id` |
| `/api/backups/restore` | POST | Queue restoration; `{"id":"...vsm-backup.zip"}` |
| `/api/backups/cleanup` | POST | Queue deletion of selected IDs; `{"ids":["..."]}` |

Queued operations return 202. Concurrent maintenance requests are refused, and mutations pause during capture, installation and restoration. Uploaded archives can be retained even if the subsequent restore request is cancelled or fails; they remain visible for later selection or cleanup.

Browser integration checks for the complete backup workflow run with `node tests/backups.cjs` when Playwright/Chromium are installed (same `VSM_CHROMIUM` and `PYTHON` options as the diagram test). They start their own supervisor, database and backup storage, leaving the development workspace unchanged. Run `node tests/maintenance.cjs` to check HTML gateway error handling and repeated restart polling without browser dependencies.

### Advanced database-only backups

SQLite's backup API remains available for external database-only backup jobs. These files do not contain application code and cannot be uploaded as complete application backups:

```sh
python3 - <<'PY'
import sqlite3
with sqlite3.connect('/var/lib/vsm-toolbox/vsm.sqlite3') as source:
    with sqlite3.connect('/var/backups/vsm-toolbox.sqlite3') as target:
        source.backup(target)
PY
```

Run with permission to read/write those paths and restrict backup permissions. Restore database-only files while the service is stopped and ensure the application version matches the database schema.
