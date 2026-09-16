#!/usr/bin/env bash
# Local Git fixtures; no root, network, packages or real services required.
set -Eeuo pipefail
source "$(dirname "$0")/../install/purethink-bridge-install.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export PB_APP="$work/app" PB_NODE="$work/node" PB_DATA="$work/data"
export EVENTS="$work/events"
repo_url="$work/origin"
mkdir -p "$PB_NODE/bin" "$PB_DATA" "$repo_url"
printf '#!/bin/sh\nexit 0\n' > "$PB_NODE/bin/node"
chmod +x "$PB_NODE/bin/node"
git -C "$repo_url" init -q -b main
git -C "$repo_url" config user.name Test
git -C "$repo_url" config user.email test@example.invalid
mkdir -p "$repo_url/install"
printf 'pb_main() { echo refreshed >> "$EVENTS"; }\n' > "$repo_url/install/purethink-bridge-install.sh"
echo '{}' > "$repo_url/package-lock.json"
git -C "$repo_url" add .
git -C "$repo_url" commit -qm initial
git clone -q "$repo_url" "$PB_APP"
echo next > "$repo_url/version"
git -C "$repo_url" add .
git -C "$repo_url" commit -qm next
id() { return 0; }
systemctl() { echo "systemctl $*" >> "$EVENTS"; }
chown() { echo "chown $*" >> "$EVENTS"; }
runuser() { echo "runuser $*" >> "$EVENTS"; return "${NPM_FAILURE:-0}"; }
(pb_update)
[[ $(git -C "$PB_APP" rev-parse HEAD) == "$(git -C "$repo_url" rev-parse HEAD)" ]]
grep -q 'npm ci --omit=dev' "$EVENTS"
grep -q 'chown -R root:root' "$EVENTS"
grep -q refreshed "$EVENTS"
# Dirty work and detached checkouts must fail before services stop.
echo dirty >> "$PB_APP/package-lock.json"
: > "$EVENTS"
if (pb_update); then exit 1; fi
[[ ! -s $EVENTS ]]
git -C "$PB_APP" checkout -- package-lock.json
git -C "$PB_APP" checkout -q --detach
if (pb_update); then exit 1; fi
[[ ! -s $EVENTS ]]
git -C "$PB_APP" checkout -q main
# Missing upstream and local commits must also fail before downtime.
git -C "$PB_APP" branch --unset-upstream
if (pb_update); then exit 1; fi
[[ ! -s $EVENTS ]]
git -C "$PB_APP" branch --set-upstream-to=origin/main >/dev/null
echo local > "$PB_APP/local"
git -C "$PB_APP" add local
git -C "$PB_APP" -c user.name=Test -c user.email=test@example.invalid commit -qm local
if (pb_update); then exit 1; fi
[[ ! -s $EVENTS ]]
git -C "$PB_APP" reset --hard origin/main >/dev/null
# Dependency failure restores ownership and does not refresh/start services.
set +e
(set -e; NPM_FAILURE=1; pb_update)
status=$?
set -e
[[ $status != 0 ]]
grep -q 'chown -R root:root' "$EVENTS"
if grep -q refreshed "$EVENTS"; then exit 1; fi
echo 'Update fast-forward, dirty/detached rejection and failure cleanup: PASS'
