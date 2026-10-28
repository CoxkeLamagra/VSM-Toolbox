# Application architecture and refactor notes

VSM Toolbox is a local Python/SQLite application with a vanilla JavaScript interface. Its runtime requires Python 3.11 or newer and no third-party packages. Debian 13 LXC remains the primary deployment; Docker uses the same application and supervisor.

## Findings from the v0.6.0 review

Feature additions had placed resource validation, SQL writes, tag assignment, permissions, and HTTP handling in the same mutation method. Read handlers authenticated on one connection and loaded content on another. Workspace serialization issued an additional assignment query for every stream, step, and process.

The frontend repeated page names, access checks, navigation bindings, and rendering branches as each Admin page was added. It updated the branding stylesheet more than once during a refresh, and the cache key embedded the complete list of tag colors in the URL. The diagram repeatedly scanned all process links to count links for each process. Large portions of the Python, JavaScript, HTML, and CSS were compressed into long lines.

## Backend responsibilities

- `app.py` owns configuration, idempotent schema initialization, authentication, branding, resource contracts, the content repository, and HTTP transport.
- `ResourceSpec` and `RESOURCES` define supported content fields, write roles, tagging capability, and workspace ordering. SQL identifiers come from these fixed definitions; request values are parameterized.
- `ContentRepository` validates and reads/writes streams, steps, processes, tags, categories, and links. It does not open connections or commit transactions. Its caller owns the transaction so content and assignments succeed or roll back together. Input dictionaries are copied before normalization.
- Workspace reads batch tag assignments once for each populated resource type rather than once per entity. The aggregate and individual resource endpoints use the same serialization rules.
- `Handler` owns HTTP parsing, sessions, role/CSRF enforcement, response headers, route dispatch, downloads, and uploads. Maintenance request validation is separate from ordinary content mutations.
- Authenticated reads use one database snapshot for the session, content, and tag assignments. The read transaction closes before the response is sent, including before backup streaming, so slow clients do not hold database read locks.
- `updater.py` owns Linux process supervision, fixed-source GitHub updates, the maintenance queue, local backup archives, health checks, and recovery. Its logic is unchanged by this refactor; its source is formatted for readability.

`initialize()` remains safe to run on existing databases and after restoring older archives. Admins manage the tag catalog and branding; Admins and Editors change content and tag assignments; Viewers read content. Authentication and account administration retain their existing behavior.

## Frontend responsibilities

`web/app.js` remains one delivered script, organized into request/polling helpers, a page registry, shared forms, content rendering, Admin pages, and the diagram controller.

- `VIEWS` defines page renderers, Admin access requirements, and optional data loaders. One navigation binding and active-state loop use that registry.
- Shared action and maintenance-state sets replace repeated lists.
- `formValues()` serializes tag selectors consistently for streams, steps, and processes.
- `syncThemeStylesheet()` updates the CSS link only when its inputs change. Its bounded hash key avoids oversized request URLs with large tag catalogs. `/branding.css` remains local and uncached; the hash is a cache key, not a security primitive.
- Process-link counts are computed once while building a diagram.
- `StreamDiagram` continues to own geometry, input gestures, and personal layout persistence. Diagram movement never writes content to the server.

The CSS and HTML templates are formatted into readable blocks. Existing layout, branding tokens, and selectors are preserved.

## Deployment and compatibility boundaries

This refactor preserves API paths and response fields, SQLite schema, authentication, backup format, the six runtime files, and update protocol 1. It does not add runtime dependencies, migrate stored data, or change the Debian service, installer, Docker image definition, or restart policy.

The supervisor, installer, and backup validator intentionally allow a fixed runtime file set. Simply splitting the application into new Python modules or JavaScript files would make older installed supervisors reject the update. A future physical module split needs an explicit compatible delivery/upgrade design; logical boundaries are kept within the existing files here.

The supervisor remains Linux-specific (`fcntl`, process/service lifecycle). Native Windows support would be a separate deployment project.

## Verification and development tools

The baseline regression suite had 34 tests. The refactor adds repository tests for query growth and transaction rollback, plus JavaScript helper tests for form encoding and stylesheet refresh behavior.

Run the backend and dependency-free frontend checks:

```sh
python3 -m unittest discover -s tests -v
node --check web/app.js
node tests/maintenance.cjs
node tests/frontend.cjs
git diff --check
```

With Playwright and Chromium available, run each isolated browser workflow:

```sh
node tests/diagram.cjs
node tests/branding.cjs
node tests/backups.cjs
node tests/tags.cjs
```

Browser tests accept `VSM_CHROMIUM` and `PYTHON`; configure `NODE_PATH` if Playwright is installed outside the repository. Each test starts its own temporary database/server and cleans it up.

Black 25.9.0 and Prettier 3.6.2 were used as development-only formatters. Their configuration is in `pyproject.toml` and `.prettierrc.json`. They are not installed by the application installer or included in backups. With these tools installed in a development environment:

```sh
python3 -m black app.py updater.py tests/test_repository.py
prettier --write web/app.js web/style.css web/index.html tests/frontend.cjs
```

## Remaining boundaries

HTML templates still use the existing escaped-string rendering approach. A component framework or build pipeline has not been introduced. The CSS retains its existing cascade, including branding overrides, to avoid changing presentation during a structural refactor. Future changes should use the resource/page registries and repository boundary instead of adding parallel validation or navigation branches.

## PCF hierarchy extension

`pcf_entries` is a normal registered content resource with a strict five-level parent model. Each entry stores its local sibling number and a stable ID; serialization computes full indexes from the ancestor chain. Root and sibling numbers are constrained in SQLite. Repository validation enforces compatible parent/child types and rejects deletions that would discard a subtree. The `stream_pcf` join table supports explicit many-to-many stream classifications and cascades leaf/stream link cleanup. Resource serialization batches these links, and stream mutations save content, tags, and classifications together.

The frontend's registered `pcf` page offers a numbered, expandable index and a tile drill-down view. Shared stream forms serialize a separate PCF selector; selectors never change tag assignments. PCF entries are classifications, independent of process-library execution documentation. The runtime manifest remains unchanged.

### PCF CSV import

`parse_pcf_csv()` validates the bounded, UTF-8 CSV and derives types and parent indexes from dotted hierarchy IDs. `PCFImporter` previews duplicate reference IDs and fingerprints the existing PCF records. Apply requires an explicit choice for every duplicate and an unchanged fingerprint. It builds and validates the complete final hierarchy before writing; temporary unused sibling numbers allow valid number swaps without weakening database uniqueness. Existing IDs and stream links survive overwrites. CSV descriptions replace existing descriptions only when the optional Description column is present; omitting it preserves existing descriptions. The HTTP mutation transaction commits or rolls back the complete import. No uploaded CSV file, new runtime dependency, or runtime manifest entry is added.

## Administrator data management

The `maintenance` Admin page uses a separate `data_reset_protocol` capability exported by the updated supervisor. Clearing is rejected by the API and disabled by the UI when that engine capability is missing. The request requires an exact typed confirmation, passes Admin/CSRF checks, and enters the existing serialized maintenance queue.

The supervisor's `clear-data` operation stops the child, captures a full `pre-data-clear` backup, writes the normal recovery record, then runs `clear_business_data()` in a transaction with foreign keys enabled. Stream/process relationships cascade; PCF entries are deleted from Task upward because their parent constraint is RESTRICT. Accounts, settings, sessions, tag catalogs, and backup archives are untouched. A health check precedes removal of the recovery record, so failure or interruption can recover the complete snapshot. Runtime files and backup format remain unchanged; existing installations need an updated supervisor once.

## Environment ownership and roles

`environments`, `environment_members`, and `session_environments` live in the same SQLite database as content and accounts. An atomic migration assigns existing content to environment 1, rebuilds legacy tag/category uniqueness per environment, and preserves IDs/joins. A retained schema marker prevents recreating a deliberately deleted final environment. Environment IDs use AUTOINCREMENT.

All business tables carry `environment_id`. Repository reads/writes require an explicit authorized environment from the handler; cross-environment stream, process, PCF, tag, and category references are rejected by validation and SQLite relationship triggers. CSV import snapshots, duplicate-reference matching, fingerprints, and inserts are scoped to the same environment. New PCF IDs are allocated globally to preserve uniqueness. Dashboard counts use grouped queries rather than queries per environment.

Application roles still guard account administration and whole-database operations. Environment roles guard content and catalog access. Legacy/initial memberships inherit the account role through a nullable membership role; explicit roles, including creator Admin status, override inheritance. Account and membership mutations protect the last effective environment Admin. Active selection is stored per session, and the browser's environment header rejects stale context. SQL read transactions close before responding.

Session selections live in a separate table to preserve the session-table layout. A session-delete trigger cleans selections even when an older installed supervisor deletes sessions with foreign keys disabled. Existing supervisors and the fixed runtime manifest remain compatible. Full database backups include every environment; global data clearing retains environment metadata while deleting business content across all environments. Environment deletion clears its PCF hierarchy from leaves upward before cascading the remaining owned data.

## Refactor after environments, PCF imports, and administration expansion

The review found that environment lifecycle rules had accumulated in the HTTP handler, while page access was separately interpreted by refresh, navigation, and sidebar rendering. The existing content repository, PCF importer, and supervisor already provide separate boundaries for their responsibilities and remain in place.

`EnvironmentRepository` now owns environment selection, overview counts, membership lookup, lifecycle mutations, and last-Admin protection. Its mutation dispatcher delegates to focused create, switch, add-member, change-member, delete, and update methods. The handler authenticates requests, checks CSRF, and supplies the connection, actor, and hashed session token. Repository methods never commit or open connections: creation, creator membership, and session selection remain one transaction. Callers use `mutate()` for mutations so its membership authorization precedes the operation helpers.

On the frontend, `canAccessView()` interprets the page registry for refresh, navigation, sidebar visibility, and disabled states. `navigationButton()` provides the single mapping between page names and existing DOM IDs. Application administration remains independent from environment membership: an application Admin can use accounts, branding, backups, updates, and global data management even when there are no environments. Environment catalog permissions remain separate.

The database schema, API contracts, backup contents, runtime manifest, update protocol, installer, and service startup behavior are unchanged. No runtime dependencies or additional delivered modules are introduced. The collapsible Administration menu remains closed by default; browser workflows explicitly expand it before selecting administration entries.

Additional verification covers transaction rollback of environment creation and selection, last-Admin rejection without membership changes, and the frontend role matrix including application Admins with no environment. The existing API and browser suites exercise migrations, isolation, PCF imports/descriptions, tag catalogs, diagrams, branding, updates, backups/restore, and backup-first data clearing.

## BPMN process import

Processes gain an additive `bpmn_xml` column with an empty default; existing databases and restored older archives migrate during initialization. Process POST/PUT accepts this optional UTF-8 text field; omission preserves the existing diagram, and an empty string clears it. The existing content repository enforces environment ownership, write roles, and transaction boundaries. Serialization adds a normalized `bpmn` model (or null) alongside the stored XML. `parse_bpmn()` validates namespace, size, element/node/flow counts, duplicate IDs, and finite bounded diagram coordinates; it rejects DTDs/entities and never fetches resources. Namespace-qualified BPMN DI shapes/waypoints are read as numeric data. Unknown graphics are not converted into markup.

The frontend renders only normalized data into escaped SVG primitives. Import creates or updates an ordinary process, so its links, tags, backup inclusion, and data-clear lifecycle follow existing behavior. The viewer has local zoom and pointer/scroll panning and works for environment Viewers. No external viewer, network service, runtime dependency, or runtime file is added. Regression checks are in `tests/test_bpmn.py`, `tests/bpmn.cjs`, and the backup restore suite.


## Bounded HTTP serving and login isolation

`BoundedHTTPServer` replaces the direct standard-library server at the executable entry point. A semaphore limits worker admission before allocating a thread; excess connections close immediately. Accepted sockets receive a 15-second idle timeout and a watchdog closes the connection after a 120-second total deadline. Worker slots release in `finally`, including parse failures and client disconnects. The supervisor launches this same entry point, so installed engines do not need a protocol upgrade. The six delivered runtime files remain unchanged.

The existing `login_attempts` table stores namespaced hashed account/source and source-only keys without schema changes. Account keys fold ASCII case to match SQLite NOCASE account lookup. Per-account/source throttling cannot blanket-block unrelated usernames behind one proxy. Source-level failure signaling never rejects a valid unrelated login, and failed attempts still increment the account counter when the source counter is exhausted. Global request bounds and proxy controls remain necessary for CPU/connection abuse; these counters do not replace edge rate limiting.


## Installer-managed self-signed HTTPS

`scripts/prepare-https.py` stages certificates, a specific-IP Nginx site, and systemd environment settings. It validates the IP, checks certificate lifetime and IP verification, and compares certificate/key public keys before reusing an existing pair. OpenSSL performs certificate operations; no Python runtime dependency is added. The Debian installer detects or accepts an explicitly assigned IPv4 address, installs Nginx/OpenSSL/iproute2, snapshots managed files, and activates them with rollback on failure. A final environment file keeps the backend on loopback and enables Secure cookies even when older service overrides specified otherwise. Backend, TLS health, redirect, and boot enablement checks precede success. The self-signed site deliberately does not enable HSTS before client trust has been established.

The HTTPS helper is installer-only and is not part of the six-file web update payload. Existing web updaters, databases, backups, and the application API remain unchanged. Certificate renewal occurs on installer reruns (within 30 days of expiry or after an address/key change), not via an automatic timer. Tests cover real certificate lifecycle, trusted-certificate HTTPS, redirect behavior, and account creation with a Secure cookie through Nginx.

## Service time calculations

Streams gain nullable positive `takt_available_minutes`/`takt_demand` columns and a constrained `takt_period` with default `day`, using additive idempotent migration. The existing resource/environment/role boundary owns validation and writes. Empty form inputs serialize as null; optional numeric fields do not prevent editing existing streams without takt settings. Backup/update delivery contracts remain unchanged.

`serviceTimeMetrics()` derives active processing cycle time, sequential lead time (active plus waiting), takt (matching-period availability divided by demand), and active-work flow efficiency. Step previews, flow cards, and diagram nodes expose processing/lead time without duplicating stored calculated fields. The UI explicitly distinguishes this processing convention from observed completion-interval cycle time and labels sequential totals as mapping estimates.

## Consolidation after service timing and BPMN display changes

The latest review is recorded in `docs/refactor-visual-review-2026-10-28.md`. `migrate_optional_fields()` owns additive feature columns; `ResourceSpec.nullable` and `text_limits` own scalar contract exceptions. Repeated workspace lookups use indexes built from each refreshed API snapshot. BPMN route construction and collision placement are separate from the screen renderer. Shared stream/step fieldsets and a scrollable modal body keep long forms usable at desktop/mobile widths without changing submitted fields or Viewer restrictions.

`tests/visual-review.cjs` captures the full main-screen set and checks horizontal containment using disposable data and the actual supervisor. Runtime delivery, API paths, backup format, role separation, and stored schema values remain compatible.
