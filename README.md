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

Run these commands as root **inside the LXC**, starting with a fresh `/opt/vsm-toolbox` path:

```sh
apt-get update
apt-get install -y python3 git ca-certificates
git clone https://github.com/CoxkeLamagra/VSM-Toolbox.git /opt/vsm-toolbox
useradd --system --user-group --home-dir /var/lib/vsm-toolbox --shell /usr/sbin/nologin vsm
install -m 0644 /opt/vsm-toolbox/deploy/vsm-toolbox.service /etc/systemd/system/vsm-toolbox.service
systemctl daemon-reload
systemctl enable --now vsm-toolbox
python3 -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8080/api/health').read().decode())"
```

These instructions require this implementation to be present in the cloned revision. Alternatively copy your reviewed checkout into `/opt/vsm-toolbox` before installing the unit. Access the application using the LXC's address on port 8080. The unit stores data under `/var/lib/vsm-toolbox`, runs as an unprivileged user, and restarts after failure. Diagnose startup with `journalctl -u vsm-toolbox`. For updates, stop the unit, back up the database, update the checkout to a reviewed revision, and restart the unit.

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
