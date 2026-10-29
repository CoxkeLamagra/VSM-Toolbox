# Application architecture

VSM Toolbox uses Python 3.11+ standard-library modules, SQLite, and browser ES modules. No database service, frontend bundler, Node runtime, or third-party Python package is required in production. Debian 13 LXC remains the primary deployment; Docker runs the same application/supervisor.

## Backend

`app.py` is the executable entry point and a small compatibility facade for Python consumers/tests. The implementation lives in `vsm/`:

| Module | Responsibility |
|---|---|
| `config.py` | Version, application root, role/session/password constants |
| `storage.py` | Database configuration, transaction ownership, schema and migrations |
| `auth.py` | Account validation, password hashing/checking, public user projection, API errors |
| `branding.py` | Branding validation, colors, generated theme stylesheet |
| `resources.py` | Resource fields, write roles, nullable fields, text limits, PCF types |
| `repository.py` | Environment-scoped content reads/writes, relationship validation and serialization |
| `bpmn.py` | Bounded XML parsing into normalized diagram data |
| `pcf.py` | CSV parsing, preview/fingerprint, duplicate decisions and atomic import |
| `environments.py` | Membership, environment lifecycle, session selection and last-Admin rules |
| `http.py` | Bounded HTTP serving, routes, sessions/CSRF, transport and maintenance authorization |
| `workshops.py` | Shared workshop boards, bounded block validation, presence and per-item optimistic concurrency |
| `runtime.py` | Delivery profiles, manifest validation and static asset allowlist |

Storage owns the `DB` setting and `connect()` transaction context. Repository/domain operations receive a caller-owned connection and do not commit independently. Environment relationships are validated both in repositories and SQLite triggers. Application Admin privileges remain separate from environment roles.

`updater.py` remains the unprivileged Linux supervisor. It owns application processes, pinned-source GitHub updates, backup archives, recovery records, health checks, and maintenance serialization. It uses the same delivery-profile validator as installation and static serving.

## Frontend

`web/app.js` owns the application session, page registry/navigation, request/polling lifecycle, forms and administration orchestration. It imports:

- `lib/core.js`: escaping, form serialization, service timing, ratings, and workspace indexes.
- `features/bpmn.js`: measured wrapping, route construction, collision-aware labels and SVG rendering.
- `features/stream-diagram.js`: interactive diagram controller and private layout cache, with explicit callbacks for session/content access and editing.
- `features/workshop.js`: environment-scoped shared SVG canvas, block palette/inspector, per-item revision saves, presence and two-second polling. Lifecycle generations discard stale responses after navigation.
- `features/pcf.js`: PCF views, CSV preview/apply, forms and feature-local navigation/import state. The controller resets that state through the feature API when sessions/environments change.

Feature factories receive explicit dependencies; they do not depend on undeclared page globals. ES module imports are served from a manifest-derived allowlist with JavaScript MIME types and the existing same-origin CSP. There is no bundle-generation step. `package.json` marks development JavaScript as modules; Node is only needed for checks, not installation.

`web/style.css` remains the shared theme/layout stylesheet. Its visual refinements and current screen coverage are described in the dated visual-review document; historical references there to the six-file runtime apply to the earlier delivery protocol.

## Delivery protocol 2 and reinstall transition

This refactor deliberately replaces the six-file delivery restriction with a bounded manifest. **Install it by rerunning the matching Debian installer or rebuilding/recreating the Docker image and selecting its bundled code. Older web-update engines reject protocol 2 safely.** Existing database migrations remain additive; the initial modular refactor added no schema changes. Collaborative workshops add separate environment-owned board, item, and presence tables.

`update-manifest.json` is the authoritative runtime inventory. Protocol 2 requires the bootstrap files, accepts at most 128 unique files, and constrains paths to root entry points, Python modules under `vsm/`, and JS/CSS/HTML assets under `web/`. Traversal, absolute paths, duplicate names, and other extensions are rejected. Archives copy only declared regular files into a release directory; links are never extracted. All declared Python files are compiled before activation. Static asset routes use the same declared web inventory.

The new supervisor can install later protocol-2 releases that add valid declared modules; no hardcoded per-release file tuple limits expansion. Application health must report the protocol and revision of the active release. The old exact protocol-1 profile remains accepted **for backup restoration**, including code/data recovery and safety backups of restored legacy releases. Legacy and modular archive contents must match their embedded profile and hashes exactly. Trusted full-code backup restoration retains its existing Admin/service-code trust boundary.

The Debian installer stages every validated runtime file, checks the schema using that staged payload, backs up the existing database, and activates the new supervisor with existing systemd/HTTPS rollback checks. Installer-only TLS helpers, database files, logs, and local secrets are not runtime payload files. Docker copies `vsm/` and `web/` and retains non-root/read-only operation with writable data storage.

For Docker, an existing `updates/active.json` intentionally selects a prior web-installed release. Archive that activation file while the container is stopped when deliberately switching to a rebuilt image's bundled code; keep the data volume and backups. Rebuilding alone does not override that stored selection.

## Verification

Run backend, module, and helper checks:

```sh
python3 -m unittest discover -s tests -v
node tests/frontend.cjs
node tests/maintenance.cjs
node --check web/app.js
bash -n scripts/install-debian13.sh
git diff --check
```

Browser checks are in `tests/*.cjs`, including the visual review, diagrams, PCF/CSV, tags, environments, ratings/service times, branding, backups and data management. They use disposable databases/servers. Set `NODE_PATH`/`VSM_CHROMIUM` for Playwright/Chromium when installed outside the checkout. HTTPS integration additionally accepts `VSM_TEST_NGINX` for a Nginx binary.

Delivery tests cover inventory completeness, unsafe paths, staged installation without source-tree dependencies, future module extraction, and actual supervisor transitions from modular to legacy backups and back. Existing tests cover rollback, migrations, role isolation, request bounds, boot enablement and TLS.
