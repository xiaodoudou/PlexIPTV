#!/bin/sh
# Hands the folders PlexIPTV writes to over to PUID:PGID, then runs it as that
# user. The container starts as root only so it can do this: a host folder that
# Docker creates for a bind mount belongs to root, and the app could not write
# its settings there.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" != "0" ]; then
  # Started with --user: nothing to hand over, and no way to.
  exec "$@"
fi

for id in "$PUID" "$PGID"; do
  case "$id" in
    ''|*[!0-9]*)
      echo "PUID and PGID must be numeric ids, got PUID=$PUID PGID=$PGID" >&2
      exit 1
      ;;
  esac
done

# -h changes a symbolic link itself, never what it points at.
chown -R -h "$PUID:$PGID" /opt/PlexIPTV/config /opt/PlexIPTV/logs

exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups --no-new-privs -- "$@"
