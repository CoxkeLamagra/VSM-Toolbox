# Modular refactor — reinstall-based transition

This refactor uses the authorized full-reinstall path to remove the previous six-runtime-file restriction. Application features and SQLite contents are preserved; this is not a database reset.

## Implementation

The executable `app.py` is now a small entry point/facade. Backend responsibilities live in `vsm/`: configuration, storage/migrations, authentication, branding, resource contracts, content repository, BPMN, PCF import, environments, HTTP transport, and delivery profiles. Domain operations retain caller-owned transactions. Database configuration is owned by `vsm.storage` and still reads `VSM_DATABASE`.

The browser uses native ES modules. Shared helpers live in `web/lib/core.js`; PCF/CSV, BPMN, and the interactive stream diagram have their own feature modules. Feature state and the diagram layout cache live with their features. Explicit callbacks provide current session/environment/content and editing actions. The main controller retains page navigation, session/request lifecycle, and administration orchestration. No build pipeline or production JavaScript dependency is required.

Delivery protocol 2 uses a bounded, validated manifest instead of a fixed six-file tuple. The installer stages every declared runtime file. The supervisor can download later protocol-2 module additions, compiles every Python module, and requires matching protocol/revision health. The HTTP server serves only declared web assets and sends revalidation headers to reduce mixed-version module caches. Docker includes both package and feature directories and excludes bytecode caches.

New backup archives contain the declared modular payload and database. The new supervisor still accepts the exact protocol-1 legacy profile for restoring older archives and taking safety snapshots of restored legacy code. Filename, entry type, size, hash, schema, and manifest checks remain enforced. Admin code-restore privileges retain their existing trust boundary.

## Verification

- Full suite: **90 tests passed**, with the real Nginx integration enabled.
- Delivery module: **five targeted checks passed**, including the additional frontend import-graph check added after the full suite. These cover staged install isolation, complete file inventory, unsafe paths/duplicates, future module extraction, and modular/legacy recovery.
- All **12 browser workflows passed**: visual review, service times, ratings, BPMN, stream diagram, environments, PCF, CSV, tags, branding, backups and data clearing.
- The actual currently published protocol-1 updater was run offline against the modular archive and rejected it with the expected installer/image-upgrade message.
- The actual previous-main monolithic source was backed up/restored under the new supervisor, then returned to modular code; original test data survived both transitions.
- Final Docker image built successfully and ran as UID 10001 with a read-only root filesystem and writable data volume. Module-serving and browser smoke tests passed for registration, stream diagrams, PCF and BPMN. The disposable container was removed afterward.
- Python 3.11 syntax, compilation, frontend helper/polling checks, JavaScript syntax/formatting, installer shell syntax and diff whitespace checks passed.

All executable checks used disposable data/services. The installer payload was staged and initialized independently of the source checkout. A real Debian LXC systemd/apt reinstall was not performed against a user's server; existing offline boot and real TLS proxy tests cover those components separately.

## Upgrade requirements

1. Keep an external backup of the existing installation/data.
2. Obtain the **new installer from this modular revision**, rather than using an older cached script or the old UI updater. Use a complete matching checkout with `bash scripts/install-debian13.sh --source-dir "$PWD"`, optionally adding `--https-ip`.
3. The installer retains the SQLite data, stages all modules, selects the newly installed supervisor, and applies the existing HTTPS/health/rollback flow. Open the existing HTTPS URL and hard-refresh the browser if it retained old assets.
4. For Docker, retain the volume/backups. Stop the old container and archive its `updates/active.json` selection if present before deliberately selecting the rebuilt image's bundled code. Do not delete the volume or database.

Older update engines cannot install this release; they reject it before switching application code. Older supervisors cannot restore modular backups. The new supervisor supports legacy restore and subsequent recovery. Publishing this refactor does not deploy it to an existing server; use the installation steps above.

See `docs/architecture.md` for the current module boundaries and protocol rules. The earlier dated visual-review report describes the previous implementation; its six-file constraint has now been superseded.
