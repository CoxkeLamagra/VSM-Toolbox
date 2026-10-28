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
HTTPS_IP=
TLS_ACTIVATED=0
NGINX_WAS_ACTIVE=0
NGINX_WAS_ENABLED=0
HTTPS_FILES=(/etc/vsm-toolbox/tls/certificate.pem /etc/vsm-toolbox/tls/private-key.pem /etc/vsm-toolbox/https.env /etc/systemd/system/vsm-toolbox.service.d/https.conf /etc/nginx/conf.d/vsm-toolbox-https.conf)

usage() {
    cat <<'HELP'
Usage: bash install-debian13.sh [--ref TAG_OR_COMMIT] [--source-dir DIRECTORY] [--https-ip IPV4]

Run as root inside a Debian 13 LXC with systemd and Internet access.
By default fetches main from CoxkeLamagra/VSM-Toolbox over HTTPS.
--ref selects a branch, tag, or commit; --source-dir installs a local checkout
instead (mutually exclusive with --ref). Existing database data is preserved.
Installs HTTPS on the main IPv4 address at port 443 with a self-signed certificate.
--https-ip selects a specific local IPv4 address instead of detecting it.
HTTP redirects to HTTPS. The application backend remains on loopback port 8080.
HELP
}
REF_SET=0
while (($#)); do
    case "$1" in
        --ref|--source-dir)
            (($# >= 2)) || { usage >&2; exit 2; }
            if [[ $1 == --ref ]]; then REF=$2; REF_SET=1; else SOURCE=$2; fi
            shift 2 ;;
        --https-ip)
            (($# >= 2)) || { usage >&2; exit 2; }
            HTTPS_IP=$2; shift 2 ;;
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
        if ((TLS_ACTIVATED)); then
            for index in "${!HTTPS_FILES[@]}"; do
                if [[ -e $TEMP/https-backup/$index ]]; then
                    cp -p "$TEMP/https-backup/$index" "${HTTPS_FILES[$index]}"
                else
                    rm -f -- "${HTTPS_FILES[$index]}"
                fi
            done
        fi
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
    if ((status != 0 && TLS_ACTIVATED)); then
        if ((NGINX_WAS_ENABLED)); then systemctl enable nginx || true; else systemctl disable nginx || true; fi
        if ((NGINX_WAS_ACTIVE)); then nginx -t && systemctl reload-or-restart nginx || true; else systemctl stop nginx || true; fi
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
apt-get install -y --no-install-recommends python3 git ca-certificates curl passwd nginx openssl iproute2
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
# The selected revision must provide the modular delivery profile.
[[ -f $SOURCE/vsm/runtime.py && ! -L $SOURCE/vsm/runtime.py ]] || {
    echo 'This installer requires the modular application revision; use its matching installer for older releases.' >&2; exit 1;
}
PYTHONDONTWRITEBYTECODE=1 python3 - "$SOURCE" > "$TEMP/runtime-files" <<'PYCODE'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root))
from vsm.runtime import release_files
files = release_files(json.loads((root / 'update-manifest.json').read_text()), allow_legacy=False)
for name in files:
    path = root / name
    if path.is_symlink() or not path.is_file():
        raise ValueError('Missing or linked runtime file: ' + name)
    print(name)
PYCODE
mapfile -t RUNTIME_FILES < "$TEMP/runtime-files"
for file in deploy/vsm-toolbox.service scripts/prepare-https.py; do
    [[ -f $SOURCE/$file && ! -L $SOURCE/$file ]] || { echo "Required source file missing or symlinked: $file" >&2; exit 1; }
done
# Select a specific local IPv4 address. Route lookup does not send traffic.
if [[ -z $HTTPS_IP ]]; then
    HTTPS_IP=$(ip -j -4 route get 1.1.1.1 | python3 -c 'import json,sys; rows=json.load(sys.stdin); print(rows[0].get("prefsrc", ""))')
fi
ip -j -4 address show | python3 -c 'import ipaddress,json,sys; requested=str(ipaddress.IPv4Address(sys.argv[1])); local={a["local"] for interface in json.load(sys.stdin) for a in interface.get("addr_info",[]) if a.get("family")=="inet"}; assert requested in local, "HTTPS IP must be assigned to this machine"' "$HTTPS_IP"
if [[ -e /etc/nginx/conf.d/vsm-toolbox-https.conf ]]; then
    head -1 /etc/nginx/conf.d/vsm-toolbox-https.conf | grep -q '^# VSM Toolbox managed HTTPS' || {
        echo 'Existing Nginx VSM configuration is unmanaged; refusing to overwrite it.' >&2; exit 1;
    }
fi
for file in "${HTTPS_FILES[@]}"; do
    [[ ! -L $file ]] || { echo "Refusing symlinked HTTPS configuration: $file" >&2; exit 1; }
done
python3 "$SOURCE/scripts/prepare-https.py" --ip "$HTTPS_IP" --output "$TEMP/https" --certificate-dir /etc/vsm-toolbox/tls
install -d -m 0700 "$TEMP/https-backup"
for index in "${!HTTPS_FILES[@]}"; do
    if [[ -f ${HTTPS_FILES[$index]} ]]; then cp -p "${HTTPS_FILES[$index]}" "$TEMP/https-backup/$index"; fi
done
if systemctl is-active --quiet nginx; then NGINX_WAS_ACTIVE=1; fi
if systemctl is-enabled --quiet nginx; then NGINX_WAS_ENABLED=1; fi
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
for file in "${RUNTIME_FILES[@]}"; do
    install -D -m 0644 "$SOURCE/$file" "$NEW/$file"
done
REVISION=local
if git -C "$SOURCE" diff --quiet HEAD -- app.py updater.py vsm web update-manifest.json 2>/dev/null && \
   [[ -z $(git -C "$SOURCE" ls-files --others --exclude-standard -- app.py updater.py vsm web update-manifest.json) ]]; then
    REVISION=$(git -C "$SOURCE" rev-parse HEAD)
fi
printf '%s\n' "$REVISION" > "$NEW/REVISION"
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
TLS_ACTIVATED=1
install -d -m 0700 /etc/vsm-toolbox /etc/vsm-toolbox/tls
install -d -m 0755 /etc/systemd/system/vsm-toolbox.service.d /etc/nginx/conf.d
install -m 0644 "$TEMP/https/certificate.pem" /etc/vsm-toolbox/tls/certificate.pem
install -m 0600 "$TEMP/https/private-key.pem" /etc/vsm-toolbox/tls/private-key.pem
install -m 0600 "$TEMP/https/https.env" /etc/vsm-toolbox/https.env
install -m 0644 "$TEMP/https/https.conf" /etc/systemd/system/vsm-toolbox.service.d/https.conf
install -m 0644 "$TEMP/https/nginx.conf" /etc/nginx/conf.d/vsm-toolbox-https.conf
nginx -t
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
systemctl enable nginx
systemctl is-enabled --quiet nginx
systemctl reload-or-restart nginx
# Wait for asynchronous Nginx reload to activate both listeners.
HTTPS_READY=0
echo "Waiting for HTTPS on $HTTPS_IP:443..."
for ((attempt=0; attempt<30; attempt++)); do
    if systemctl is-active --quiet nginx && \
       curl --noproxy '*' --fail --silent --show-error --connect-timeout 2 --max-time 2 \
         --cacert /etc/vsm-toolbox/tls/certificate.pem "https://$HTTPS_IP/api/health" 2>>"$TEMP/https-health.log" | \
       python3 -c 'import json,sys; assert json.load(sys.stdin)["status"] == "ok"' 2>>"$TEMP/https-health.log"; then
        REDIRECT=$(curl --noproxy '*' --silent --show-error --output /dev/null --write-out '%{http_code}' \
            --connect-timeout 2 --max-time 2 "http://$HTTPS_IP/" 2>>"$TEMP/https-health.log") || REDIRECT=unavailable
        if [[ $REDIRECT == 301 ]]; then
            HTTPS_READY=1
            break
        fi
        echo "HTTP redirect not ready (status $REDIRECT)." >>"$TEMP/https-health.log"
    fi
    sleep 1
done
if ((HTTPS_READY == 0)); then
    echo "HTTPS did not become healthy at https://$HTTPS_IP/; restoring the previous configuration." >&2
    tail -20 "$TEMP/https-health.log" >&2 || true
    journalctl -u nginx -n 40 --no-pager >&2 || true
    exit 1
fi
# HTTPS activation succeeded.
ACTIVATED=0
TLS_ACTIVATED=0
printf '\nVSM Toolbox installed and healthy.\nOpen https://%s/\n' "$HTTPS_IP"
echo "Database: $DATA/vsm.sqlite3"
echo 'Boot startup: application and nginx enabled'
echo 'The self-signed certificate causes a browser warning until trusted on your devices.'
echo 'Public certificate: /etc/vsm-toolbox/tls/certificate.pem (never distribute the private key).'
echo 'Backend: 127.0.0.1:8080. Managed HTTPS settings override conflicting /etc/default/vsm-toolbox values.'
echo 'Rerun the installer before certificate expiry (365 days), or after changing the server IP.'
