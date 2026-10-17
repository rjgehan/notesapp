#!/bin/sh
# backup-scheduler's main process (ROADMAP item 1, DESIGN §7.10): runs nightly.sh once a day at
# NOTES_BACKUP_TIME (HH:MM, local time in TZ). On start it first runs `nightly.sh --recover`, which starts the
# app again if a run died while the app was stopped (a reboot, or this container being recreated mid-run).
#   scheduler.sh            run until stopped
#   scheduler.sh next-run   print the next run time in epoch seconds (tests; NOTES_BACKUP_NOW sets "now")
set -u

DIR=$(dirname "$0")
TIME=${NOTES_BACKUP_TIME:-04:00}
JOB=
WAITER=

log() {
	printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

# The first TIME after $1 (epoch seconds). Built from the calendar date, so DST changes need no special case.
next_run() {
	day=$(date -d "@$1" +%Y-%m-%d)
	at=$(date -d "$day $TIME" +%s)
	if [ "$at" -le "$1" ]; then
		day=$(date -d "@$(($1 + 86400))" +%Y-%m-%d)
		at=$(date -d "$day $TIME" +%s)
	fi
	echo "$at"
}

on_term() {
	log "stopping"
	[ -z "$WAITER" ] || kill "$WAITER" 2>/dev/null
	if [ -n "$JOB" ]; then
		kill -TERM "$JOB" 2>/dev/null # nightly.sh starts the app again if it had stopped it
		wait "$JOB"
	fi
	exit 0
}

case "$TIME" in
[01][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) ;;
*)
	log "ERROR NOTES_BACKUP_TIME must be HH:MM on a 24-hour clock, not '$TIME'"
	exit 2
	;;
esac

if [ "${1:-}" = next-run ]; then
	next_run "${NOTES_BACKUP_NOW:-$(date +%s)}"
	exit 0
fi

trap on_term TERM INT
if [ -n "${TZ:-}" ] && [ ! -e "/usr/share/zoneinfo/$TZ" ]; then
	log "WARN time zone '$TZ' is not available (is /usr/share/zoneinfo mounted?), so times are UTC"
fi
log "backup-scheduler started: one backup run a day at $TIME"
sh "$DIR/nightly.sh" --recover

while :; do
	next=$(next_run "$(date +%s)")
	log "next backup run: $(date -d "@$next" '+%Y-%m-%d %H:%M %Z')"
	# Short sleeps, re-reading the clock, so a suspended host or a clock change cannot skip a night.
	while now=$(date +%s) && [ "$now" -lt "$next" ]; do
		left=$((next - now))
		[ "$left" -le 300 ] || left=300
		sleep "$left" &
		WAITER=$!
		wait "$WAITER"
		WAITER=
	done
	sh "$DIR/nightly.sh" &
	JOB=$!
	wait "$JOB"
	JOB=
done
