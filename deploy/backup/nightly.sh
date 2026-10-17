#!/bin/sh
# One NotesApp backup run (ROADMAP item 1, DESIGN §7.10, DEPLOY.md "Backups"). backup-scheduler runs it every
# night; run it by hand with `docker compose exec backup-scheduler sh /backup/nightly.sh`, or from host cron
# (DEPLOY.md). The restic work happens in the backup container (restic-job.sh, through docker exec).
#
#   1. Preflight in the backup container. When it fails, nothing is stopped.
#   2. Stop the app (it commits its pending history on the way out), snapshot, start the app again. A
#      snapshot during which anything started or replaced the app is discarded.
#   3. Retention and prune, the off-site copy, and on NOTES_BACKUP_CHECK_DAY a check of both repositories.
#
# Failures are posted to NOTES_BACKUP_NTFY_URL; a run without failures pings NOTES_BACKUP_HEARTBEAT_URL.
# `nightly.sh --recover` (backup-scheduler's start, or @reboot with host cron) starts the app again when a
# run died while the app was stopped.
set -u

APP=${NOTES_BACKUP_APP_CONTAINER:-notes-notes-1}
BACKUP=${NOTES_BACKUP_CONTAINER:-notes-backup-1}
STATE=${NOTES_BACKUP_STATE_DIR:-${XDG_STATE_HOME:-${HOME:-/tmp}/.local/state}/notesapp-backup}
MAX_STOP=${NOTES_BACKUP_MAX_STOP_SECONDS:-1800} # longest snapshot while the app is down
STOP_TIMEOUT=${NOTES_BACKUP_APP_STOP_TIMEOUT:-45} # the notes service's stop_grace_period
HEALTH_WAIT=${NOTES_BACKUP_HEALTH_WAIT_SECONDS:-300}
CHECK_DAY=${NOTES_BACKUP_CHECK_DAY:-7} # ISO weekday of the repository check (date +%u), 7 = Sunday
NTFY=${NOTES_BACKUP_NTFY_URL:-}
HEARTBEAT=${NOTES_BACKUP_HEARTBEAT_URL:-}
HOST_LABEL=${NOTES_BACKUP_HOST:-homeserver}
START_RETRY=${NOTES_BACKUP_START_RETRY_SECONDS:-10}
HTTP_CLIENT=${NOTES_BACKUP_HTTP_CLIENT:-} # curl or wget; by default curl where installed (docker:cli has wget only)
if [ -z "$HTTP_CLIENT" ]; then
	if command -v curl >/dev/null 2>&1; then HTTP_CLIENT=curl; else HTTP_CLIENT=wget; fi
fi

MARKER=$STATE/app-stopped # exists while this script has the app stopped
LOCK=$STATE/run.lock
OUT=$STATE/step.out
ERR=$STATE/step.err

CHILD=
IN_RUN=
LOCKED=
FAILED=
URGENT=
SNAPSHOT=
OFFSITE_RESULT=
CHECKED=
STARTED=$(date +%s)

log() {
	printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

# Records a failure for the alert. $1 = what failed, $2 = optional detail.
fail() {
	log "ERROR $1${2:+: $2}"
	FAILED="$FAILED- $1${2:+: $2}
"
}

last_error() {
	tail -n 3 "$ERR" 2>/dev/null | tr '\n' ' ' | cut -c 1-300
}

# Posts to the ntfy topic and never fails the run. $1 title, $2 priority, $3 tags, $4 message.
notify() {
	[ -n "$NTFY" ] || return 0
	case "$NTFY" in
	ntfy://*) url="https://${NTFY#ntfy://}" ;; # the form Watchtower uses
	*) url=$NTFY ;;
	esac
	if [ "$HTTP_CLIENT" = curl ]; then
		curl -fsS -m 20 --retry 2 -o /dev/null -H "Title: $1" -H "Priority: $2" -H "Tags: $3" -d "$4" "$url"
	else
		wget -q -T 20 -O /dev/null --header "Title: $1" --header "Priority: $2" --header "Tags: $3" \
			--post-data "$4" "$url"
	fi || log "WARN could not post to ntfy"
}

ping_heartbeat() {
	[ -n "$HEARTBEAT" ] || return 0
	if [ "$HTTP_CLIENT" = curl ]; then
		curl -fsS -m 20 --retry 2 -o /dev/null "$HEARTBEAT"
	else
		wget -q -T 20 -O /dev/null "$HEARTBEAT"
	fi || log "WARN could not ping the heartbeat URL"
}

# Runs restic-job.sh <args> in the backup container: its stdout lands in $OUT, its stderr in the log (and in
# $ERR for the alert). In the background, so a TERM to this script is handled at once; a foreground child
# would hold the trap back until it returns.
step() {
	docker exec -e NOTES_BACKUP_MAX_STOP_SECONDS="$MAX_STOP" "$BACKUP" sh /backup/restic-job.sh "$@" \
		>"$OUT" 2>"$ERR" &
	CHILD=$!
	wait "$CHILD"
	step_status=$?
	CHILD=
	cat "$ERR" >&2
	return "$step_status"
}

# "<id> <running> <started at>" of the app container, or nothing when it does not exist.
app_state() {
	docker inspect -f '{{.Id}} {{.State.Running}} {{.State.StartedAt}}' "$APP" 2>/dev/null || :
}

# Starts the app and clears the marker. $1 = attempts, START_RETRY seconds apart: after a reboot the tailscale
# container, whose network namespace the app joins, may not be up yet.
start_app() {
	attempt=1
	until docker start "$APP" >/dev/null; do
		[ "$attempt" -lt "${1:-1}" ] || return 1
		attempt=$((attempt + 1))
		sleep "$START_RETRY" &
		wait $!
	done
	rm -f "$MARKER"
}

wait_healthy() {
	deadline=$(($(date +%s) + HEALTH_WAIT))
	while :; do
		health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
			"$APP" 2>/dev/null)
		case "$health" in
		healthy | running) return 0 ;; # running: the image has no health check
		esac
		[ "$(date +%s)" -lt "$deadline" ] || return 1
		sleep 5 &
		wait $!
	done
}

# Cancels a snapshot that may still be reading, so it cannot complete against a running app.
stop_restic() {
	docker exec "$BACKUP" pkill -x restic >/dev/null 2>&1 || return 0
	waited=0
	while [ "$waited" -lt 30 ] && docker exec "$BACKUP" pgrep -x restic >/dev/null 2>&1; do
		waited=$((waited + 1))
		sleep 1
	done
}

# The app was stopped by a run that did not finish: start it again. $1 = what happened.
recover() {
	[ -e "$MARKER" ] || return 0
	log "WARN $1 while $APP was stopped; starting it again"
	stop_restic
	if start_app 30; then
		notify "NotesApp backup interrupted" high warning \
			"$1 while NotesApp was stopped for the snapshot. NotesApp is running again; the next run takes a new snapshot."
	else
		log "ERROR could not start $APP"
		notify "NotesApp is down" urgent rotating_light \
			"$1 while NotesApp was stopped for the snapshot, and it could not be started again. On homeserver: cd ~/notesapp/deploy && docker compose up -d"
	fi
}

lock() {
	if mkdir "$LOCK" 2>/dev/null; then
		echo $$ >"$LOCK/pid"
		return 0
	fi
	holder=$(cat "$LOCK/pid" 2>/dev/null || :)
	# No pid yet means a run is just starting; a pid that is gone means a run died (killed, or a reboot).
	if [ -z "$holder" ] || kill -0 "$holder" 2>/dev/null; then
		return 1
	fi
	log "WARN removing the lock of a run that no longer exists (pid $holder)"
	rm -rf "$LOCK"
	mkdir "$LOCK" 2>/dev/null && echo $$ >"$LOCK/pid"
}

json_string() {
	if [ -n "$1" ]; then
		printf '"%s"' "$(printf '%s' "$1" | tr '\n\r\t' '   ' | sed 's/\\/\\\\/g; s/"/\\"/g')"
	else
		printf 'null'
	fi
}

# status.json in the state directory: the last run at a glance (DEPLOY.md "Monitoring backups").
write_status() {
	{
		printf '{"lastRun":%s,"result":%s,' "$(json_string "$1")" "$(json_string "$2")"
		printf '"snapshot":%s,"offsite":%s,' "$(json_string "$SNAPSHOT")" "$(json_string "$OFFSITE_RESULT")"
		printf '"lastSuccess":%s,"failures":%s}\n' "$(json_string "$(cat "$STATE/last-success" 2>/dev/null)")" \
			"$(json_string "$FAILED")"
	} >"$STATE/status.json.tmp" && mv "$STATE/status.json.tmp" "$STATE/status.json"
}

finish() {
	# The outcome is reported here. If the app could not be started again, the marker stays for the next
	# run or --recover to retry, but the exit trap does not try again and send a second, different alert.
	IN_RUN=
	now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
	if [ -n "$FAILED" ]; then
		write_status "$now" failed
		log "backup run FAILED after $(($(date +%s) - STARTED)) s"
		if [ -n "$URGENT" ]; then
			notify "NotesApp is down after the backup" urgent rotating_light \
				"$(printf 'The backup run on %s failed:\n%s' "$HOST_LABEL" "$FAILED")"
		else
			notify "NotesApp backup failed" high warning \
				"$(printf 'The backup run on %s failed:\n%s' "$HOST_LABEL" "$FAILED")"
		fi
		exit 1
	fi
	echo "$now" >"$STATE/last-success"
	write_status "$now" ok
	log "backup run finished in $(($(date +%s) - STARTED)) s: snapshot ${SNAPSHOT:-none}, off-site ${OFFSITE_RESULT:-?}"
	ping_heartbeat
	if [ "$CHECKED" = ok ]; then
		notify "NotesApp backups OK" low white_check_mark \
			"Weekly report from $HOST_LABEL: last snapshot $SNAPSHOT, off-site copy $OFFSITE_RESULT, repository check passed."
	fi
	exit 0
}

# Step 2: the app is down only from here to start_app.
snapshot_phase() {
	before=$(app_state)
	stopped=
	case "$before" in
	*" true "*)
		: >"$MARKER" # first, so that a run that dies from here on still gets the app back up
		log "stopping $APP; it commits its pending history on the way out"
		docker stop -t "$STOP_TIMEOUT" "$APP" >/dev/null &
		CHILD=$!
		wait "$CHILD"
		stop_status=$?
		CHILD=
		before=$(app_state)
		if [ "$stop_status" -ne 0 ]; then
			fail "stopping $APP failed (docker exit $stop_status)"
		fi
		case "$before" in
		*" false "*) ;;
		*)
			[ "$stop_status" -ne 0 ] || fail "$APP was running again right after it was stopped (a Watchtower update?)"
			start_app 6 || {
				URGENT=1
				fail "$APP could not be started again" "run: cd ~/notesapp/deploy && docker compose up -d"
			}
			return 1
			;;
		esac
		stopped=$(date +%s)
		;;
	"") log "WARN there is no container $APP; backing up without stopping anything" ;;
	*) log "$APP is not running, so nothing writes to the vault; it stays stopped" ;;
	esac

	step snapshot
	snapshot_status=$?
	snapshot_error=$(last_error)
	SNAPSHOT=$(sed -n 's/^snapshot=//p' "$OUT" | tail -n 1)
	after=$(app_state)

	if [ -n "$stopped" ]; then
		if start_app 6; then
			log "$APP started again; it was down for $(($(date +%s) - stopped)) s"
		else
			URGENT=1
			fail "$APP could not be started again after the snapshot" "run: cd ~/notesapp/deploy && docker compose up -d"
		fi
	fi

	if [ "$after" != "$before" ]; then
		# Started, restarted or replaced while restic was reading: the snapshot may hold a half-written state.
		if [ -n "$SNAPSHOT" ] && ! step discard "$SNAPSHOT"; then
			fail "discarding snapshot $SNAPSHOT" "$(last_error)"
		fi
		fail "$APP was started or replaced during the snapshot (a Watchtower update, or a manual start?), so snapshot ${SNAPSHOT:-none} was discarded"
		SNAPSHOT=
	elif [ "$snapshot_status" -ne 0 ]; then
		# Exit 3: some files could not be read; the snapshot exists (and is consistent) but is incomplete.
		fail "snapshot (restic exit $snapshot_status${SNAPSHOT:+, snapshot $SNAPSHOT kept})" "$snapshot_error"
	else
		log "snapshot $SNAPSHOT saved"
	fi

	if [ -n "$stopped" ] && [ -z "$URGENT" ] && ! wait_healthy; then
		fail "$APP did not become healthy within $HEALTH_WAIT s after the backup" \
			"check: docker compose ps; docker compose logs notes"
	fi
	return 0
}

run() {
	if ! lock; then
		log "ERROR another backup run is in progress (lock $LOCK)"
		notify "NotesApp backup skipped" high warning \
			"Another backup run on $HOST_LABEL was still in progress, so this one was skipped."
		exit 1
	fi
	LOCKED=1
	IN_RUN=1
	recover "A previous backup run did not finish"
	log "backup run started"

	if [ "$(docker inspect -f '{{.State.Running}}' "$BACKUP" 2>/dev/null)" != true ]; then
		fail "the backup container $BACKUP is not running" "start it with: cd ~/notesapp/deploy && docker compose up -d"
		finish
	fi
	if ! step preflight; then
		fail "preflight" "$(last_error)"
		finish
	fi

	snapshot_phase

	# Step 3: the app is running again; none of this reads the live vault.
	if ! step forget; then
		fail "retention on the local repository" "$(last_error)"
	fi
	if step offsite; then
		OFFSITE_RESULT=$(sed -n 's/^offsite=//p' "$OUT" | tail -n 1)
		[ "$OFFSITE_RESULT" != off ] ||
			log "WARN no off-site repository is configured, so these backups exist on homeserver only"
	else
		OFFSITE_RESULT=failed
		fail "off-site copy" "$(last_error)"
	fi
	if [ "$(date +%u)" = "$CHECK_DAY" ]; then
		if step check; then
			CHECKED=ok
		else
			CHECKED=failed
			fail "repository check" "$(last_error)"
		fi
	fi
	finish
}

on_signal() {
	trap '' TERM INT HUP
	log "WARN backup run interrupted"
	[ -z "$CHILD" ] || kill "$CHILD" 2>/dev/null
	recover "The backup run was interrupted"
	exit 143
}

on_exit() {
	[ -z "$IN_RUN" ] || recover "The backup run ended unexpectedly"
	[ -z "$LOCKED" ] || rm -rf "$LOCK"
}

mkdir -p "$STATE" || exit 1
trap on_signal TERM INT HUP
trap on_exit EXIT
case "${1:-}" in
'') run ;;
--recover)
	rm -rf "$LOCK" # called when no run can be alive: the scheduler just started, or the host just booted
	recover "A backup run was cut short (container restart or reboot)"
	;;
*)
	echo "usage: nightly.sh [--recover]" >&2
	exit 2
	;;
esac
