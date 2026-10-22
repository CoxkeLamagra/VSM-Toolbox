#!/bin/bash
# Install inside a Debian 13 LXC as root. No Docker or pip required.
set -Eeuo pipefail
umask 022
REPOSITORY=https://github.com/CoxkeLamagra/VSM-Toolbox.git
REF=main
SOURCE=
APP=/opt/vsm-toolbox
RELEASES=/opt/vsm-toolbox-releases
UNIT=/etc/systemd/system/vsm-toolbox.service
DATA=/var/lib/vsm-toolbox
TEMP=
NEW=
PREVIOUS=
ACTIVATED=0
HAD_UNIT=0
WAS_ACTIVE=0
WAS_ENABLED=0

usage() {
    cat <<'HELP'
Usage: bash install-debian13.sh [--ref TAG_OR_COMMIT] [--source-dir DIRECTORY]

Run as root inside a Debian 13 LXC with systemd and Internet access.
By default fetches main from CoxkeLamagra/VSM-Toolbox over HTTPS.
--ref selects a branch, tag, or commit; --source-dir installs a local checkout
instead (mutually exclusive with --ref). Existing database data is preserved.
Installs on port 8080, accessible on the container's private network.
HELP
}
REF_SET=0
while (($#)); do
    case "$1" in
        --ref|--source-dir)
            (($# >= 2)) || { usage >&2; exit 2; }
            if [[ $1 == --ref ]]; then REF=$2; REF_SET=1; else SOURCE=$2; fi
            shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
    esac
done
[[ -z $SOURCE || $REF_SET == 0 ]] || { echo '--ref and --source-dir cannot be combined.' >&2; exit 2; }
[[ $EUID == 0 ]] || { echo 'Run as root inside the LXC.' >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/os-release
[[ $ID == debian && $VERSION_ID == 13 ]] || { echo 'Debian 13 is required.' >&2; exit 1; }
[[ -d /run/systemd/system && $(cat /proc/1/comm) == systemd ]] || {
    echo 'A running systemd instance is required. Run inside the LXC, not a Docker build.' >&2; exit 1;
}
command -v flock >/dev/null || { echo 'flock (util-linux) is required.' >&2; exit 1; }
exec 9>/run/lock/vsm-toolbox-install.lock
flock -n 9 || { echo 'Another VSM installer is running.' >&2; exit 1; }
if [[ -e $APP || -L $APP ]]; then
    [[ -L $APP && -f $RELEASES/.installer-managed && $(readlink -f "$APP") == "$RELEASES/"* ]] || {
        echo "$APP already exists and was not created by this installer. Back up and relocate it first; no application files were changed." >&2; exit 1;
    }
    PREVIOUS=$(readlink -f "$APP")
fi
if [[ -e $RELEASES && ! -f $RELEASES/.installer-managed ]]; then
    echo "$RELEASES already exists and is not installer-managed." >&2; exit 1;
fi

cleanup() {
    local status=$?
    trap - EXIT
    if ((status != 0)); then
        echo 'Installation failed.' >&2
        if ((ACTIVATED)); then
            systemctl stop vsm-toolbox || true
            if [[ -n $PREVIOUS ]]; then
                ln -s "$PREVIOUS" "$TEMP/rollback-link"
                mv -Tf "$TEMP/rollback-link" "$APP"
            else
                rm -f "$APP"
            fi
            if ((HAD_UNIT)); then cp -p "$TEMP/previous.service" "$UNIT"; else rm -f "$UNIT"; fi
            if [[ -f $TEMP/previous-active.json ]]; then
                cp -p "$TEMP/previous-active.json" "$DATA/updates/active.json"
                chown vsm:vsm "$DATA/updates/active.json"
            fi
            systemctl daemon-reload || true
            if ((WAS_ENABLED)); then systemctl enable vsm-toolbox || true; else systemctl disable vsm-toolbox || true; fi
            if ((WAS_ACTIVE)); then systemctl start vsm-toolbox || true; fi
            echo 'Previous application/service restored. Database and backups were retained.' >&2
        fi
    fi
    [[ -z $TEMP ]] || rm -rf -- "$TEMP"
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
export DEBIAN_FRONTEND=noninteractive
echo 'Installing Debian runtime components...'
apt-get -o APT::Update::Error-Mode=any update
apt-get install -y --no-install-recommends python3 git ca-certificates curl passwd
python3 -c 'import sqlite3; assert sqlite3.sqlite_version_info >= (3, 24)'
TEMP=$(mktemp -d /opt/.vsm-install.XXXXXXXX)
if [[ -n $SOURCE ]]; then
    SOURCE=$(realpath "$SOURCE")
else
    git init -q "$TEMP/source"
    git -C "$TEMP/source" remote add origin "$REPOSITORY"
    git -C "$TEMP/source" fetch --depth=1 origin "$REF"
    git -C "$TEMP/source" checkout -q --detach FETCH_HEAD
    SOURCE=$TEMP/source
fi
for file in app.py updater.py update-manifest.json web/index.html web/app.js web/style.css deploy/vsm-toolbox.service; do
    [[ -f $SOURCE/$file && ! -L $SOURCE/$file ]] || { echo "Required source file missing or symlinked: $file" >&2; exit 1; }
done
# Do not adopt an existing account with unexpected privileges.
if getent passwd vsm >/dev/null; then
    [[ $(id -u vsm) != 0 && $(id -gn vsm) == vsm && $(id -G vsm | wc -w) == 1 ]] || {
        echo 'Existing vsm account must be non-root, with only its private vsm group.' >&2; exit 1;
    }
else
    getent group vsm >/dev/null || groupadd --system vsm
    useradd --system --gid vsm --home-dir "$DATA" --shell /usr/sbin/nologin vsm
fi
install -d -m 0755 "$RELEASES"
touch "$RELEASES/.installer-managed"
NEW=$(mktemp -d "$RELEASES/release-XXXXXXXX")
chmod 0755 "$NEW"
for file in app.py updater.py update-manifest.json; do install -m 0644 "$SOURCE/$file" "$NEW/$file"; done
REVISION=local
if git -C "$SOURCE" diff --quiet HEAD -- app.py updater.py web update-manifest.json 2>/dev/null && \
   [[ -z $(git -C "$SOURCE" ls-files --others --exclude-standard -- app.py updater.py web update-manifest.json) ]]; then
    REVISION=$(git -C "$SOURCE" rev-parse HEAD)
fi
printf '%s\n' "$REVISION" > "$NEW/REVISION"
install -d -m 0755 "$NEW/web"
for file in index.html app.js style.css; do install -m 0644 "$SOURCE/web/$file" "$NEW/web/$file"; done
install -d -o vsm -g vsm -m 0700 "$DATA"
# Verify Python/SQLite and creation of a new schema before stopping the live service.
VSM_DATABASE="$TEMP/check.sqlite3" PYTHONDONTWRITEBYTECODE=1 python3 - "$NEW" <<'PY'
import sys
sys.path.insert(0, sys.argv[1])
import app
app.initialize()
with app.connect() as db:
    assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
PY
if [[ -f $UNIT ]]; then cp -p "$UNIT" "$TEMP/previous.service"; HAD_UNIT=1; fi
if systemctl is-active --quiet vsm-toolbox; then WAS_ACTIVE=1; fi
if systemctl is-enabled --quiet vsm-toolbox; then WAS_ENABLED=1; fi
# Enable rollback before changing any live service state.
ACTIVATED=1
systemctl stop vsm-toolbox 2>/dev/null || { ((WAS_ACTIVE == 0)) || exit 1; }
if [[ -f $DATA/vsm.sqlite3 ]]; then
    install -d -m 0700 /var/backups/vsm-toolbox
    BACKUP=$(mktemp /var/backups/vsm-toolbox/pre-install-XXXXXXXX.sqlite3)
    python3 - "$DATA/vsm.sqlite3" "$BACKUP" <<'PY'
import sqlite3, sys
with sqlite3.connect('file:' + sys.argv[1] + '?mode=ro', uri=True) as source:
    if source.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise RuntimeError('Existing database failed integrity check')
    with sqlite3.connect(sys.argv[2]) as target:
        source.backup(target)
PY
    chmod 0600 "$BACKUP"
    echo "Database backup: $BACKUP"
fi
# Preserve web-update activation metadata for installer rollback, then select the installed code.
UPDATE_ACTIVE=$DATA/updates/active.json
if [[ -f $UPDATE_ACTIVE ]]; then cp -p "$UPDATE_ACTIVE" "$TEMP/previous-active.json"; fi
rm -f "$UPDATE_ACTIVE"
# Atomically switch code; old releases remain available for recovery.
ln -s "$NEW" "$TEMP/new-link"
mv -Tf "$TEMP/new-link" "$APP"
install -m 0644 "$SOURCE/deploy/vsm-toolbox.service" "$UNIT"
systemctl daemon-reload
systemctl enable vsm-toolbox
systemctl is-enabled --quiet vsm-toolbox || { echo 'Service was not enabled for boot.' >&2; exit 1; }
systemctl restart vsm-toolbox
READY=0
for ((attempt=0; attempt<30; attempt++)); do
    if systemctl is-active --quiet vsm-toolbox && \
       curl --noproxy '*' --fail --silent --max-time 2 http://127.0.0.1:8080/api/health | \
       python3 -c 'import json,sys; assert json.load(sys.stdin)["status"] == "ok"' 2>/dev/null; then
        READY=1; break
    fi
    sleep 1
done
if ((READY == 0)); then
    journalctl -u vsm-toolbox -n 40 --no-pager >&2 || true
    echo 'Service did not become healthy on port 8080.' >&2
    exit 1
fi
curl --noproxy '*' --fail --silent --max-time 5 http://127.0.0.1:8080/api/session | \
    python3 -c 'import json,sys; data=json.load(sys.stdin); assert "setup_required" in data and "user" in data'
ACTIVATED=0
printf '\nVSM Toolbox installed and healthy.\nOpen http://<LXC-IP>:8080 on your trusted private network.\n'
echo "Database: $DATA/vsm.sqlite3"
echo 'Boot startup: enabled (systemd vsm-toolbox.service)'
echo 'Logs: journalctl -u vsm-toolbox -f'
echo 'Create the first Admin account in the browser. Use HTTPS for access beyond a trusted local connection.'
