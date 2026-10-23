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
