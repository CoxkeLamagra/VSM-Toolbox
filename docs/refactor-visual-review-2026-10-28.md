# Application refactor and visual review — 28 October 2026

Reviewed main at `11e588d`, including environments, PCF/CSV, BPMN, tagging, branding, administration/maintenance, CVA/BVA, and service timing. The changes preserve API paths, database values/constraints, role boundaries, local backup format, and the six-file runtime update contract.

## Refactor results

- **Schema lifecycle:** `migrate_optional_fields()` consolidates the additive feature-column migrations. Existing/restored databases retain values; fresh and repeated initialization use the same definitions.
- **Resource contracts:** `ResourceSpec` now declares nullable fields and resource-specific text limits. Generic scalar validation uses those contracts instead of a growing list of special cases. BPMN length errors now report the actual configured character limit. Domain validation and environment relationship checks remain in the repository.
- **Workspace rendering:** `buildWorkspaceIndex()` groups steps and process links and indexes catalogs once per API snapshot. Step ordering, process-link counts, and tag resolution reuse these indexes. Refresh/environment switching replaces the snapshot and rebuilds indexes; callers receive a separate step array so they cannot reorder the cached groups.
- **BPMN rendering:** route construction and label collision placement have separate helpers. Collision placement owns one render's occupied label boxes independently of the canvas/DOM. Existing escaping, measured wrapping, tooltips, and viewport bounds remain intact.
- **Shared forms:** stream forms group identity/outcome, classifications, takt settings, VOC, tags, and PCF. Step editing and Viewer details share the same field builder and calculation labels. Domain writes and permission enforcement remain server-side.

## Visual changes and review

Captured 26 screenshots at 1440px desktop and 390px mobile widths. The repeatable `tests/visual-review.cjs` uses a temporary database and real supervisor, seeds representative linked/tagged content, checks page-level horizontal overflow, and captures the main screens plus diagrams/forms. Screenshots are generated under `/tmp/vsm-visual-review`; they contain disposable test data.

| Area | Review and resulting behavior |
|---|---|
| Environments | Dashboard/member table remain readable; cards adapt to available width |
| Value-stream overview | Compact desktop cards, wrapped titles and classification badges; single-column mobile cards |
| Stream map and delivery flow | Service metrics wrap independently; diagram retains its own pan/zoom surface and tagged/rated step cards |
| Stream/step forms | Clear fieldsets; scrollable fields with persistent Save/Cancel; shared editable/read-only step content |
| Process library and BPMN | Compact process cards, wrapping actions, contained scroll/pan/zoom, external BPMN labels retained |
| PCF | Tile/index navigation and header actions fit mobile width; long titles can wrap |
| Tags/categories | Catalog cards, assignment labels and action groups retain environment scope |
| Accounts | Role guidance and table stay inside the page; wide tables retain local horizontal scrolling |
| Branding | Identity/color controls and actions fit narrow screens; configured colors remain supported |
| Backups, updates, data management | Status, controls and warnings remain legible; destructive confirmations and backup-first behavior retained |
| Navigation/footer | Collapsible Administration preserved; version link also remains visible in the mobile icon sidebar |

Dialog width, scrolling, and footer positioning are shared, rather than individually patched into each newer form. Modified base CSS rules were consolidated where practical; the established branding cascade remains in place. Responsive grids retain compact desktop tiles instead of stretching a single item across the full row.

## Verification

- Backend suite: **86 tests**, **85 passed and one Nginx integration check skipped** because Nginx was not on PATH. Re-ran the HTTPS module with the available temporary Nginx binary: **both certificate/TLS tests passed**, including the skipped integration path.
- All **12 browser workflows passed**: visual review, service times, value ratings, BPMN, interactive diagram, environments, PCF, CSV import, tags, branding, backups/restore, and data management.
- Frontend helper checks passed, including new grouping/index tests proving deterministic ordering, correct relationship counts, empty-state handling, and unchanged source snapshot ordering.
- Python compilation, JavaScript syntax, formatter and whitespace checks passed.
- Existing regression suites cover legacy migrations, environment roles/isolation, rollback, backups, security fixes, boot startup, and HTTPS. No real installation's data or services were changed.

## Deployment and remaining boundaries

The refactor adds no runtime dependency, runtime file, schema field, installer setting, or update-protocol change. It can be delivered through the current UI updater after publication. No live deployment or GitHub publication was performed as part of the refactor.

Physical Python/JavaScript module splitting remains constrained by installed supervisors and backup validators that allow exactly six runtime files. A future physical split requires a compatible delivery migration. This change provides logical boundaries within those files. BPMN pools/lanes, extension graphics, execution, and collaborative diagram layout remain outside the existing viewer's supported scope. Visual checks cover Chromium at the recorded sizes; other browsers and unusually large/custom data sets may need additional review.
