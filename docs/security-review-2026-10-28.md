# Manual security review — 28 October 2026

Reviewed revision: `ce9ce5cabed1d00de48b78e607b42b1cb4f8e29a`.

This is a manual source review and bounded local validation, explicitly performed without the Codex Security workflow. No production server was tested. Application source and deployment configuration were not changed. Severity assumes an attacker can reach the HTTP listener; a properly configured private boundary or reverse proxy reduces exposure.

## Confirmed findings

### M1 — Unauthenticated stalled requests retain unbounded server workers (Medium)

**Evidence:** `app.py:1868` starts the standard `ThreadingHTTPServer` directly. No handler socket timeout, worker limit, or request deadline is configured. `app.py:1763` reads the declared JSON body before authenticating the request; the standard handler also waits for headers before dispatch. The one-megabyte body limit bounds bytes, but does not bound how long reading them takes.

**Attack path:** A reachable unauthenticated client opens connections and sends incomplete headers or a partial body with an allowed Content-Length. Each accepted connection can retain a thread and file descriptor indefinitely. Repetition can exhaust resources and deny access to legitimate users. No exploit at exhaustion scale was attempted.

**Validation:** Three partial-body connections were opened against a temporary local instance; worker count increased while the bodies remained incomplete. Socket default timeout was `None`, consistent with the source. Test sockets were closed afterward.

**Recommended fix:** Set per-connection read timeouts and cap concurrent connections/workers, with predictable rejection under load. Put a reverse proxy in front with header/body deadlines, connection limits, and request-size limits, and prevent clients from reaching the backend directly. Test incomplete headers and bodies as well as worker-cap recovery. Socket inactivity timeouts alone do not stop clients that continuously trickle bytes; apply an overall request deadline at the proxy or server.

### M2 — Shared source-IP failures lock unrelated users out of login (Medium)

**Evidence:** `app.py:1400–1409` keys failed-login throttling solely by `self.client_address[0]`. After ten failures from that address, the handler returns 429 before checking the submitted credentials. It applies the same block to every username. Expiry is five minutes from the stored window start.

**Attack path:** An unauthenticated attacker behind the same NAT, or using the same reverse proxy as legitimate users, submits ten bad logins, including for a nonexistent username. Other users arriving through that address cannot sign in with valid credentials during the window. Behind a conventional reverse proxy, all callers commonly share its backend source address. The attacker can repeat this after each window. Existing authenticated sessions are not revoked.

**Validation:** Against a temporary database, ten attempts for nonexistent user `unknown` returned 401. A subsequent login for an unrelated existing Admin using its correct password returned 429.

**Recommended fix:** Combine bounded per-account/source throttling with a broader source abuse budget and proxy-level controls, so a small number of failures for an unrelated username does not blanket-block other users. Preserve username-enumeration resistance and cap rate-limit record growth. If real client IPs are used, accept them only from explicitly trusted proxies and block direct backend access; never trust arbitrary forwarded headers. Include regression tests for unrelated accounts behind one proxy and repeated attacks against one account.

## Conditional deployment exposure

**Cleartext HTTP in the default LXC installation:** `deploy/vsm-toolbox.service:10` binds all interfaces, and the installer directs users to HTTP port 8080 without configuring TLS or a firewall. `app.py:1329` marks session cookies Secure only when `VSM_COOKIE_SECURE=1`. An attacker able to observe or alter that network path can capture passwords and session cookies. This is a deployment-dependent confidentiality/integrity risk, not evidence of interception on the user's server. The README already documents that HTTPS must be supplied externally. Use an HTTPS reverse proxy, enable Secure cookies, and restrict the application listener to loopback or a protected backend network. Compose already publishes on host loopback by default.

## Reviewed controls and trust boundaries

- Account password storage uses salted PBKDF2-SHA256 with 600,000 iterations; session tokens and CSRF tokens use cryptographic randomness. Account changes revoke sessions. Bootstrap closes after the first account is created.
- Mutations check JSON content type, origin/fetch metadata, roles, and CSRF where required. Application roles and environment roles remain distinct. Content IDs and relationship IDs are checked against the authorized environment; SQLite triggers reinforce relationship isolation.
- SQL request values are parameterized; dynamic SQL identifiers are selected from registered resource fields and tables.
- Content/branding labels are escaped before HTML rendering. Branding colors and logo MIME/data are constrained. BPMN renders normalized numbers and escaped labels rather than XML markup. This review found no confirmed stored-XSS path in those renderers.
- BPMN input is size/count bounded, rejects DTD/entity declarations and null bytes, and validates numeric coordinates. CSV imports enforce hierarchy and size limits and apply atomically. No confirmed external-entity or SQL-injection path was identified.
- Updates use a fixed GitHub source, verified HTTPS, restricted redirects, pinned commit IDs, and allowlisted regular archive files. Backups constrain names, paths, size, hashes, and schema. Update and restore paths retain safety backups and rollback behavior.
- **Important trust boundary:** Application Admins may restore uploaded backups containing executable application code. Embedded SHA-256 values detect corruption, not provenance: someone can edit the code and recompute hashes. This is a consequence of full code-and-data restore, not a demonstrated role bypass. Treat application Admin accounts and uploaded backup producers as trusted to run code with the service account's privileges. If that trust is not intended, redesign browser restore as data-only or require separately authenticated backup provenance.
- First-account registration intentionally grants Admin privileges. Complete bootstrap before exposing an empty installation to untrusted clients.

## Coverage and limitations

Reviewed `app.py`, `updater.py`, frontend rendering/request paths in `web/app.js`, the fixed static asset boundary, Debian installer/service configuration, Dockerfile, and Compose. Checked authentication/session handling, role enforcement, environment ownership, content relationships, CSV/BPMN parsing, archive handling, backup restoration, and update activation/recovery.

Validation used disposable local databases and servers. No production credentials or data were used, no external service was attacked, and no destructive resource-exhaustion test was performed. This is not an exhaustive penetration test, dependency-advisory feed scan, OS/container image scan, or assessment of the deployed reverse proxy, firewall, TLS, or installed Python/SQLite patch levels. No confirmed critical/high-severity issue was found in the reviewed paths; that is not a guarantee that none exist.

Application fixes and publication are outside this review. Recommended priority: protect the listener with HTTPS and proxy limits, fix shared-IP login lockout, then add bounded backend request handling as defense in depth.

## Remediation implemented after the review

M1 and M2 are fixed in the working tree following the request to implement recommendations. The findings above describe the pre-fix revision; the initial review itself made no application changes.

- **M1:** The executable entry point now uses `BoundedHTTPServer`: at most 32 request workers, 15-second idle socket timeout, and a 120-second absolute connection deadline. Excess connections close before worker creation; slots release after timeout/disconnect/error. Local tests verified rejection when capacity is full, absolute expiry of partial headers, idle expiry of a partial JSON body, and successful requests after slot recovery.
- **M2:** Failed attempts are keyed by hashed source plus ASCII-case-insensitive username. Ten failures for an unknown username no longer block a correct Admin login from the same address. Case variants cannot bypass the per-account limit. A broader source failure counter does not reject valid unrelated credentials; failed attempts still consume the account-specific budget when that counter is exhausted. Rate-limit rows expire and are capped at 10,000. Existing database/backup schema remains compatible.
- **Deployment exposure:** The Debian unit defaults to loopback. A documented Nginx HTTPS template supplies TLS, HSTS, redirect, proxy buffering, and connection/rate limits. Existing service overrides may still expose HTTP and require operator review. UI updates do not replace systemd or Nginx configuration. No production deployment or certificate configuration was performed.

Validation completed: `python3 -m unittest discover -s tests -q` passed **77 tests**; focused security/account/boot checks passed **11 tests**. Frontend helper/maintenance checks, JavaScript syntax, installer shell syntax, Python compilation, and diff whitespace checks passed. The BPMN browser workflow passed against the actual bounded application server. Nginx configuration validation passed using the unpacked Debian Nginx binary, temporary unprivileged ports, and a temporary self-signed certificate; no system service was installed or changed. A real hostname/trusted certificate and the deployed network boundary remain operator configuration, not validated production state.

New regression coverage is in `tests/test_security_fixes.py`; the old account test was updated to reject the throttled username while allowing an unrelated account. The fixed runtime file set and update protocol remain unchanged. The 120-second connection deadline also applies to large backup transfers; use a sufficiently fast connection. Application Admins and backup producers retain their documented code-restore trust, which was not a privilege-bypass finding.
