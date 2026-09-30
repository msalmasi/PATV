#!/usr/bin/env bash
# PATV pull-based deploy. Run every 2 minutes by patv-update@<instance>.timer:
#
#   fetch origin/$BRANCH -> check it in a scratch worktree -> fast-forward ->
#   npm ci where a lockfile changed -> restart only the pm2 apps whose files
#   changed -> health check -> roll back and mark the commit bad if it fails.
#
# Config: /etc/patv-deploy/<instance>.env (see deploy/prod.env.example).
# A commit that failed is never retried; push a new commit to move on.
set -uo pipefail

INSTANCE="${1:?usage: patv-update.sh <instance>}"
CONF="/etc/patv-deploy/$INSTANCE.env"
[ -r "$CONF" ] || { echo "no config at $CONF" >&2; exit 2; }
# shellcheck disable=SC1090
. "$CONF"
: "${APP_DIR:?}" "${BRANCH:?}" "${HEALTH_URL:?}"
ONLY_APP="${ONLY_APP:-}"          # staging: every change restarts this one app
STABLE_SECS="${STABLE_SECS:-30}"  # how long restarted apps must stay up
HEALTH_SECS="${HEALTH_SECS:-60}"  # how long the website gets to answer /healthz
DISCORD_WEBHOOK="${DISCORD_WEBHOOK:-}"

STATE="/var/lib/patv-deploy/$INSTANCE"
LOG="/var/log/patv-deploy-$INSTANCE.log"
BAD="$STATE/bad-commits"
mkdir -p "$STATE"; touch "$BAD"

exec 9>"$STATE/lock"
flock -n 9 || exit 0

# systemd gives services no HOME; nvm and pm2 need it.
export HOME="${HOME:-/root}" PM2_HOME="${PM2_HOME:-/root/.pm2}"
export NVM_DIR="${NVM_DIR:-/root/.nvm}"
set +u  # nvm.sh isn't nounset-clean
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh" >/dev/null
nvm use --silent "${NODE_VERSION:-20}" >/dev/null || { echo "nvm: node ${NODE_VERSION:-20} missing" >&2; exit 2; }
set -u

log() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }

notify() {
  [ -n "$DISCORD_WEBHOOK" ] || return 0
  local msg
  msg=$(printf '%s' "[$INSTANCE] $*" | python3 -c 'import json,sys; print(json.dumps({"content": sys.stdin.read()[:1900]}))')
  curl -fsS -m 10 -H 'Content-Type: application/json' -d "$msg" "$DISCORD_WEBHOOK" >/dev/null 2>&1 || true
}

# Log a blocking condition once, not every 2 minutes.
note_once() {
  local key="$1"; shift
  if [ "$(cat "$STATE/last-note" 2>/dev/null)" != "$key" ]; then
    echo "$key" > "$STATE/last-note"; log "$*"; notify "$*"
  fi
}

short() { git -C "$APP_DIR" rev-parse --short "$1"; }
subject() { git -C "$APP_DIR" log -1 --format=%s "$1"; }

pm2_field() {  # pm2_field <app> <status|restarts>
  pm2 jlist 2>/dev/null | python3 -c '
import json, sys
name, field = sys.argv[1], sys.argv[2]
for p in json.load(sys.stdin):
    if p["name"] == name:
        e = p["pm2_env"]
        print(e.get("status") if field == "status" else e.get("restart_time", 0))
        break
else:
    print("missing")' "$1" "$2"
}

# Which pm2 apps a changed path affects. Unknown paths restart the website,
# which is the safe default. Static files are served live and need nothing.
apps_for() {
  if [ -n "$ONLY_APP" ]; then
    case "$1" in
      *.md|docs/*|deploy/*|.github/*|.gitignore|.gitattributes|public/*|uploads/*) ;;
      discord-bot/*|discordself/*|twitchbot/*|blackjack/*|server.js) ;;  # bots don't run on staging
      *) echo "$ONLY_APP" ;;
    esac
    return
  fi
  case "$1" in
    *.md|docs/*|deploy/*|.github/*|.gitignore|.gitattributes|public/*|uploads/*) ;;
    discord-bot/userUtils.js)          echo discord blackjack ;;
    discord-bot/*)                     echo discord ;;
    discordself/*)                     echo discordbot ;;
    twitchbot/*)                       echo twitch server ;;   # server.js requires twitchbot/twitch
    blackjack/*)                       echo blackjack ;;
    server.js)                         echo server ;;
    dbUtils.js|user.controller.js)     echo index twitch server ;;
    package.json|package-lock.json)    echo index server ;;
    *)                                 echo index ;;
  esac
}

# Syntax-check a commit without touching the live checkout.
check_commit() {
  local sha="$1" wt="$STATE/check" rc=0
  git -C "$APP_DIR" worktree remove --force "$wt" >/dev/null 2>&1; rm -rf "$wt"
  git -C "$APP_DIR" worktree prune
  git -C "$APP_DIR" worktree add -q --detach "$wt" "$sha" || return 1
  (
    cd "$wt" || exit 1
    fail=0
    while IFS= read -r f; do
      out=$(node --check "$f" 2>&1) || { echo "syntax error: $f"; echo "$out" | head -5; fail=1; }
    done < <(git ls-files '*.js' | grep -Ev '^(public|views|uploads)/')
    while IFS= read -r f; do
      node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$f" 2>/dev/null \
        || { echo "bad JSON: $f"; fail=1; }
    done < <(git ls-files '*package.json' '*package-lock.json')
    if git grep -nE '^(<<<<<<<|>>>>>>>) ' -- '*.js' '*.ejs' '*.json' >/dev/null; then
      echo "merge conflict markers:"; git grep -nlE '^(<<<<<<<|>>>>>>>) ' -- '*.js' '*.ejs' '*.json'; fail=1
    fi
    exit $fail
  ) >"$STATE/check.out" 2>&1 || rc=1
  git -C "$APP_DIR" worktree remove --force "$wt" >/dev/null 2>&1
  return $rc
}

npm_install() {  # npm_install <dir...>
  local d
  for d in "$@"; do
    log "npm ci in ${d}"
    (cd "$APP_DIR/$d" && npm ci --no-audit --no-fund --loglevel=error) >>"$LOG" 2>&1 || return 1
  done
}

RESTARTED=()
restart_apps() {  # restarts the given apps that are running; stopped apps stay stopped
  local a st
  RESTARTED=()
  for a in "$@"; do
    st=$(pm2_field "$a" status)
    if [ "$st" = "online" ]; then
      pm2 restart "$a" --update-env >/dev/null 2>&1 && RESTARTED+=("$a")
    else
      log "  $a is $st - left alone"
    fi
  done
}

healthy() {  # healthy <apps...>: they stay up and the website answers
  local a base=() i=0 t
  for a in "$@"; do base+=("$(pm2_field "$a" restarts)"); done
  if [[ " $* " == *" index "* || ( -n "$ONLY_APP" && " $* " == *" $ONLY_APP "* ) ]]; then
    for ((t = 0; t < HEALTH_SECS; t += 3)); do
      curl -fsS -m 5 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true' && break
      sleep 3
    done
    [ "$t" -lt "$HEALTH_SECS" ] || { HEALTH_WHY="website didn't answer $HEALTH_URL within ${HEALTH_SECS}s"; return 1; }
  fi
  sleep "$STABLE_SECS"
  for a in "$@"; do
    if [ "$(pm2_field "$a" status)" != "online" ] || [ "$(pm2_field "$a" restarts)" != "${base[$i]}" ]; then
      HEALTH_WHY="$a crashed after the restart (pm2 status $(pm2_field "$a" status))"; return 1
    fi
    i=$((i + 1))
  done
}

# ---------------------------------------------------------------------------
cd "$APP_DIR" || exit 1
git fetch -q origin "$BRANCH" 2>>"$LOG" || { note_once fetch "git fetch failed"; exit 1; }
CUR=$(git rev-parse HEAD)
NEW=$(git rev-parse "origin/$BRANCH")
[ "$CUR" = "$NEW" ] && { rm -f "$STATE/last-note"; exit 0; }
grep -qx "$NEW" "$BAD" && exit 0

if ! git merge-base --is-ancestor "$CUR" "$NEW"; then
  note_once "noff-$NEW" "origin/$BRANCH $(short "$NEW") isn't a fast-forward of the live $(short "$CUR") (force-push?) - not deploying; fix by hand"
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  note_once "dirty-$NEW" "tracked files were edited on the server - not deploying $(short "$NEW") until they're committed or reverted: $(git status --porcelain --untracked-files=no | head -5 | tr '\n' ' ')"
  exit 1
fi

log "new commit $(short "$NEW"): $(subject "$NEW") - checking"
if ! check_commit "$NEW"; then
  echo "$NEW" >> "$BAD"
  log "check failed for $(short "$NEW") - not deploying:"; sed 's/^/    /' "$STATE/check.out" | tee -a "$LOG" >/dev/null
  notify "deploy of $(short "$NEW") ($(subject "$NEW")) failed its check - not deployed: $(head -3 "$STATE/check.out" | tr '\n' ' ')"
  exit 1
fi

CHANGED=$(git diff --name-only "$CUR" "$NEW")
declare -A APPSET=() NPMSET=()
while IFS= read -r f; do
  [ -n "$f" ] || continue
  for a in $(apps_for "$f"); do APPSET[$a]=1; done
  case "$f" in
    package-lock.json|package.json)                   NPMSET[.]=1 ;;
    */package-lock.json|*/package.json)
      d="${f%/*}"; [ -n "$ONLY_APP" ] || NPMSET[$d]=1 ;;
  esac
done <<< "$CHANGED"
APPS=("${!APPSET[@]}"); DIRS=("${!NPMSET[@]}")

git merge -q --ff-only "$NEW" || { log "fast-forward failed"; exit 1; }
log "applied $(short "$CUR") -> $(short "$NEW") ($(echo "$CHANGED" | wc -l) files)"

WHY=""
if [ ${#DIRS[@]} -gt 0 ] && ! npm_install "${DIRS[@]}"; then
  WHY="npm ci failed"
fi
if [ -z "$WHY" ] && [ ${#APPS[@]} -gt 0 ]; then
  restart_apps "${APPS[@]}"
  if [ ${#RESTARTED[@]} -gt 0 ]; then
    log "restarted: ${RESTARTED[*]}"
    HEALTH_WHY=""
    healthy "${RESTARTED[@]}" || WHY="$HEALTH_WHY"
  fi
elif [ -z "$WHY" ]; then
  log "no app affected - nothing restarted"
fi

if [ -z "$WHY" ]; then
  log "deployed $(short "$NEW")"
  notify "deployed $(short "$NEW"): $(subject "$NEW")${RESTARTED[*]:+ (restarted ${RESTARTED[*]})}"
  if echo "$CHANGED" | grep -q '^deploy/'; then
    # Replace the running copy by rename so this bash process keeps its inode.
    if bash -n "$APP_DIR/deploy/patv-update.sh"; then
      cp "$APP_DIR/deploy/patv-update.sh" /opt/patv-deploy/patv-update.sh.new \
        && chmod 755 /opt/patv-deploy/patv-update.sh.new \
        && mv -f /opt/patv-deploy/patv-update.sh.new /opt/patv-deploy/patv-update.sh \
        && log "updater script updated"
    fi
  fi
  exit 0
fi

# --- roll back --------------------------------------------------------------
echo "$NEW" >> "$BAD"
log "ROLLING BACK $(short "$NEW"): $WHY"
git reset -q --hard "$CUR"
[ ${#DIRS[@]} -gt 0 ] && npm_install "${DIRS[@]}"
RB_OK=1
if [ ${#RESTARTED[@]} -gt 0 ]; then
  for a in "${RESTARTED[@]}"; do pm2 restart "$a" --update-env >/dev/null 2>&1; done
  HEALTH_WHY=""
  healthy "${RESTARTED[@]}" || RB_OK=0
fi
if [ $RB_OK = 1 ]; then
  log "rolled back to $(short "$CUR"); $(short "$NEW") is marked bad"
  notify "deploy of $(short "$NEW") ($(subject "$NEW")) failed - $WHY. Rolled back to $(short "$CUR")."
else
  log "ROLLBACK ALSO UNHEALTHY: $HEALTH_WHY - needs a human"
  notify "deploy of $(short "$NEW") failed ($WHY) AND the rollback to $(short "$CUR") is unhealthy ($HEALTH_WHY). Needs a human."
fi
exit 1
