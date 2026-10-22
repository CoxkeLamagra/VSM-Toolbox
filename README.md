# VSM Toolbox

A local web application for mapping IT service value streams and documenting the processes that deliver them. Python 3.11+ and SQLite are the only runtime requirements; there are no third-party Python packages, external databases, CDNs, or cloud services.

## Features

- Create value streams with a customer, desired outcome, and description.
- Build a visual sequence of delivery steps; drag cards to reorder them.
- Assign responsible teams and record active work and waiting time in minutes.
- See total lead time, work time, and flow efficiency for each map.
- Maintain a shared process library with owners, descriptions, and work instructions.
- Link multiple processes to each step and reuse processes across streams.
- Read, create, update, and delete data through a JSON API.

For example, map **Restore customer service**: report incident → triage → investigate → restore service → confirm resolution. Link incident classification, escalation, and service restoration procedures to the appropriate steps. Maps currently represent a linear current-state journey; branching, parallel flows, version history, and collaborative editing are future extensions.

## Development

```sh
python3 app.py
# In another terminal:
python3 -m unittest discover -s tests -v
```

Open port 8080 in your browser. The default bind address is `127.0.0.1`. The application creates `data/vsm.sqlite3` on first launch. No initial example data is inserted. Set `VSM_HOST`, `VSM_PORT`, and `VSM_DATABASE` to override defaults.

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

The default downloads `main` from GitHub over verified HTTPS. Use `--ref <tag-or-commit>` to select a reviewed version **that contains the application and service files**. The initial `v0.1.0` can be installed using a newer copy of the installer even though that tag does not itself include the installer. `--source-dir` and `--ref` cannot be combined. Internet access to Debian package mirrors and, unless using local source, GitHub is required. Run `bash scripts/install-debian13.sh --help` for usage.

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

Diagnose startup with `systemctl status vsm-toolbox` and `journalctl -u vsm-toolbox`. The installer uses port 8080 and binds on all container interfaces; it does not modify your firewall or install a reverse proxy. No privileged LXC features or Docker nesting are needed.

**Access boundary:** this initial release has no user authentication or authorization. Anyone who can reach it can read and change all data. Keep it on a trusted private network or behind an authenticated TLS reverse proxy; restrict the LXC's port 8080 accordingly. The built-in Python HTTP server is intended for this small private deployment, not direct Internet exposure. No external services are needed during runtime.

## Docker alternative

```sh
docker compose up -d --build
docker compose exec vsm python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8080/api/health').read().decode())"
```

The named `vsm-data` volume persists the database. Compose publishes on host loopback by default; use a private-network binding or a reverse proxy if remote access is needed. Do not remove the volume when updating. The image runs as UID 10001; bind-mounted data directories must be writable by that UID.

## API

All requests and responses use JSON. IDs are integers; updates accept a subset of the documented fields. Successful creation returns 201, reads/updates/deletes return 200, invalid requests return 400, and missing resources return 404. There is no API authentication; the same private-network boundary applies.

| Route | Methods | Fields / purpose |
|---|---|---|
| `/api/health` | GET | Server and database connectivity |
| `/api/data` | GET | Complete workspace including links |
| `/api/streams` | GET, POST | `name` (required), `customer`, `outcome`, `description` |
| `/api/streams/{id}` | GET, PUT, DELETE | Read/update/delete a stream; deletion cascades to steps |
| `/api/steps` | GET, POST | `name`, `stream_id` (required), `owner`, `position`, `work_minutes`, `wait_minutes` |
| `/api/steps/{id}` | GET, PUT, DELETE | Read/update/delete a step |
| `/api/processes` | GET, POST | `name` (required), `owner`, `description`, `procedure` |
| `/api/processes/{id}` | GET, PUT, DELETE | Read/update/delete a process |
| `/api/steps/{id}/processes` | PUT | Replace links with `{"process_ids": [1, 2]}`; empty list unlinks all |

```sh
curl -X POST http://127.0.0.1:8080/api/streams \
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
