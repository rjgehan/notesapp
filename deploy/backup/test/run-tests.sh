#!/bin/sh
# Tests for nightly.sh and scheduler.sh against a fake docker CLI (fake-bin/). CI runs them with dash and with
# BusyBox, the shell of the backup-scheduler image (.github/workflows/ci.yml); restic-job.sh has its own test
# against a real restic (restic-job-test.sh).
#   sh deploy/backup/test/run-tests.sh [shell that runs the scripts, default sh]
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPTS=$(dirname "$HERE")
SH=${1:-sh}
ORIG_PATH=$PATH
PASSED=0
FAILED=0
TEST=
T=
STATUS=

setup() {
	TEST=$1
	[ -z "$T" ] || rm -rf "$T"
	T=$(mktemp -d)
	FAKE_DIR=$T/fake
	mkdir -p "$FAKE_DIR"
	: >"$FAKE_DIR/calls"
	echo running >"$FAKE_DIR/app"
	export FAKE_DIR
	for name in FAKE_BACKUP_RUNNING FAKE_HEALTH FAKE_STOP_FAIL FAKE_STOP_RESTARTS FAKE_START_FAIL FAKE_RESTIC_RUNNING \
		FAKE_SNAPSHOT_SLEEP FAKE_DURING_SNAPSHOT FAKE_SNAPSHOT_NOID FAKE_SNAPSHOT_ID FAKE_OFFSITE_RESULT \
		FAKE_FAIL_preflight FAKE_FAIL_snapshot FAKE_FAIL_discard FAKE_FAIL_forget FAKE_FAIL_offsite FAKE_FAIL_check \
		FAKE_HTTP_FAIL FAKE_STDERR NOTES_BACKUP_TIME NOTES_BACKUP_NOW TZ \
		NOTES_BACKUP_APP_CONTAINER NOTES_BACKUP_CONTAINER NOTES_BACKUP_UP_HINT; do
		unset "$name"
	done
	export NOTES_BACKUP_STATE_DIR="$T/state"
	export NOTES_BACKUP_NTFY_URL=https://ntfy.example/notes-test
	export NOTES_BACKUP_HEARTBEAT_URL=https://hc.example/ping
	export NOTES_BACKUP_CHECK_DAY=0 # never, unless a test sets it
	export NOTES_BACKUP_HEALTH_WAIT_SECONDS=5
	export NOTES_BACKUP_START_RETRY_SECONDS=0
	export NOTES_BACKUP_HTTP_CLIENT=curl
	PATH="$HERE/fake-bin:$ORIG_PATH"
	export PATH
}

nightly() {
	$SH "$SCRIPTS/nightly.sh" "$@" >"$T/output" 2>&1
	STATUS=$?
}

pass() { PASSED=$((PASSED + 1)); }

fail() {
	FAILED=$((FAILED + 1))
	echo "FAIL [$TEST] $*"
	echo "  --- docker/curl calls:"
	sed 's/^/  /' "$FAKE_DIR/calls"
	echo "  --- output:"
	sed 's/^/  /' "$T/output" 2>/dev/null
}

exit_is() {
	if [ "$STATUS" = "$1" ]; then pass; else fail "exit status $STATUS, expected $1"; fi
}

called() {
	if grep -qF -- "$1" "$FAKE_DIR/calls"; then pass; else fail "expected a call containing: $1"; fi
}

not_called() {
	if grep -qF -- "$1" "$FAKE_DIR/calls"; then fail "unexpected call containing: $1"; else pass; fi
}

# $1 is called (first time) before $2 is called (last time).
in_order() {
	first=$(grep -nF -- "$1" "$FAKE_DIR/calls" | head -n 1 | cut -d: -f1)
	last=$(grep -nF -- "$2" "$FAKE_DIR/calls" | tail -n 1 | cut -d: -f1)
	if [ -n "$first" ] && [ -n "$last" ] && [ "$first" -lt "$last" ]; then
		pass
	else
		fail "expected '$1' before '$2'"
	fi
}

output_has() {
	if grep -qF -- "$1" "$T/output"; then pass; else fail "expected output containing: $1"; fi
}

status_has() {
	if grep -qF -- "$1" "$NOTES_BACKUP_STATE_DIR/status.json" 2>/dev/null; then
		pass
	else
		fail "expected status.json containing: $1 (got: $(cat "$NOTES_BACKUP_STATE_DIR/status.json" 2>/dev/null))"
	fi
}

app_is() {
	state=$(cat "$FAKE_DIR/app" 2>/dev/null || echo missing)
	if [ "$state" = "$1" ]; then pass; else fail "app is $state, expected $1"; fi
}

absent() {
	if [ -e "$1" ]; then fail "$1 should not exist"; else pass; fi
}

present() {
	if [ -e "$1" ]; then pass; else fail "$1 should exist"; fi
}

JOB='/backup/restic-job.sh'

# ------------------------------------------------------------------ nightly.sh

setup "a normal run stops the app only around the snapshot"
nightly
exit_is 0
in_order "$JOB preflight" "stop -t 45 notes-notes-1"
in_order "stop -t 45 notes-notes-1" "$JOB snapshot"
in_order "$JOB snapshot" "start notes-notes-1"
in_order "start notes-notes-1" "$JOB forget"
in_order "$JOB forget" "$JOB offsite"
not_called "$JOB check"
not_called "$JOB discard"
called "curl -fsS -m 20 --retry 2 -o /dev/null https://hc.example/ping"
not_called "Title:"
app_is running
absent "$NOTES_BACKUP_STATE_DIR/app-stopped"
absent "$NOTES_BACKUP_STATE_DIR/run.lock"
status_has '"result":"ok"'
status_has '"snapshot":"0123abcd"'
status_has '"offsite":"ok"'
status_has '"failures":null'
present "$NOTES_BACKUP_STATE_DIR/last-success"

setup "the check day runs the repository check and sends the weekly report"
NOTES_BACKUP_CHECK_DAY=$(date +%u)
nightly
exit_is 0
in_order "$JOB offsite" "$JOB check"
called "Title: NotesApp backups OK"
called "Priority: low"

setup "a failed preflight stops nothing and alerts"
export FAKE_FAIL_preflight=1
nightly
exit_is 1
not_called "stop -t"
not_called "$JOB snapshot"
called "Title: NotesApp backup failed"
called "The backup run on homeserver failed:|- preflight|Details: the Backups card of the status page"
not_called "Fatal:" # restic's output stays in status.json and the log
not_called "hc.example"
app_is running
status_has '"result":"failed"'
status_has '"failures":"- preflight: Fatal: \"preflight\" went wrong \\ (code 1)'
output_has 'ERROR preflight: Fatal: "preflight" went wrong'

setup "the backup container is not running"
export FAKE_BACKUP_RUNNING=false
nightly
exit_is 1
not_called "stop -t"
called "the backup container notes-backup-1 is not running"

setup "a failed snapshot still starts the app and runs retention"
export FAKE_FAIL_snapshot=1 FAKE_SNAPSHOT_NOID=1
nightly
exit_is 1
in_order "$JOB snapshot" "start notes-notes-1"
called "$JOB forget"
called "|- snapshot (restic exit 1)|"
not_called "restic: snapshot output"
status_has '- snapshot (restic exit 1): restic: snapshot output Fatal: \"snapshot\" went wrong'
app_is running
absent "$NOTES_BACKUP_STATE_DIR/app-stopped"
status_has '"snapshot":null'

setup "an incomplete snapshot (restic exit 3) is kept but alerts"
export FAKE_FAIL_snapshot=3
nightly
exit_is 1
not_called "$JOB discard"
called "snapshot (restic exit 3, snapshot 0123abcd kept)"
status_has '"snapshot":"0123abcd"'

setup "an app that is not running is neither stopped nor started"
echo stopped >"$FAKE_DIR/app"
nightly
exit_is 0
not_called "stop -t"
not_called "start notes-notes-1"
called "$JOB snapshot"
app_is stopped
output_has "is not running, so nothing writes to the vault"

setup "a missing app container is backed up without stopping anything"
rm "$FAKE_DIR/app"
nightly
exit_is 0
not_called "stop -t"
not_called "start notes-notes-1"
output_has "there is no container notes-notes-1"

setup "an app started during the snapshot makes the snapshot void"
export FAKE_DURING_SNAPSHOT=restart
nightly
exit_is 1
called "$JOB discard 0123abcd"
called "was started or replaced during the snapshot"
status_has '"snapshot":null'
app_is running

setup "an app replaced during the snapshot (Watchtower) makes the snapshot void"
export FAKE_DURING_SNAPSHOT=replace
nightly
exit_is 1
called "$JOB discard 0123abcd"

setup "an app started during a snapshot it was not stopped for also voids it"
echo stopped >"$FAKE_DIR/app"
export FAKE_DURING_SNAPSHOT=restart
nightly
exit_is 1
called "$JOB discard 0123abcd"

setup "a failed stop takes no snapshot"
export FAKE_STOP_FAIL=1
nightly
exit_is 1
not_called "$JOB snapshot"
called "stopping notes-notes-1 failed"
app_is running
absent "$NOTES_BACKUP_STATE_DIR/app-stopped"

setup "an app that is running again right after the stop takes no snapshot"
export FAKE_STOP_RESTARTS=1
nightly
exit_is 1
not_called "$JOB snapshot"
called "was running again right after it was stopped"

setup "an app that cannot be started again raises an urgent alert"
export FAKE_START_FAIL=9
nightly
exit_is 1
called "Priority: urgent"
called "could not be started again after the snapshot"
present "$NOTES_BACKUP_STATE_DIR/app-stopped"
not_called "hc.example"

setup "CasaOS (casaos-backup-compose.yml): its container names"
export NOTES_BACKUP_APP_CONTAINER=notesapp NOTES_BACKUP_CONTAINER=notesapp-backup
export NOTES_BACKUP_UP_HINT='docker start notesapp-tailscale notesapp'
nightly
exit_is 0
in_order "notesapp-backup sh $JOB preflight" "stop -t 45 notesapp"
in_order "stop -t 45 notesapp" "notesapp-backup sh $JOB snapshot"
in_order "notesapp-backup sh $JOB snapshot" "start notesapp"
not_called "notes-notes-1"
not_called "notes-backup-1"
app_is running
status_has '"result":"ok"'

setup "CasaOS: the alerts name its own way to start the app again, not docker compose"
export NOTES_BACKUP_APP_CONTAINER=notesapp NOTES_BACKUP_CONTAINER=notesapp-backup FAKE_START_FAIL=99
export NOTES_BACKUP_UP_HINT='docker start notesapp-tailscale notesapp'
nightly
exit_is 1
called "Priority: urgent"
called "- notesapp could not be started again after the snapshot (run: docker start notesapp-tailscale notesapp)"
not_called "docker compose"
nightly --recover
called "On homeserver: docker start notesapp-tailscale notesapp"

setup "an app that starts on the second attempt is fine"
export FAKE_START_FAIL=1
nightly
exit_is 0
app_is running

setup "an app that does not become healthy alerts"
export FAKE_HEALTH=starting NOTES_BACKUP_HEALTH_WAIT_SECONDS=0
nightly
exit_is 1
called "did not become healthy within 0 s"

setup "no off-site repository is a warning, not a failure"
export FAKE_OFFSITE_RESULT=off
nightly
exit_is 0
output_has "no off-site repository is configured"
status_has '"offsite":"off"'

setup "a failed off-site copy alerts"
export FAKE_FAIL_offsite=1
nightly
exit_is 1
called "|- off-site copy|"
status_has '- off-site copy: Fatal: \"offsite\" went wrong'
status_has '"offsite":"failed"'

setup "a failed retention alerts and the off-site copy still runs"
export FAKE_FAIL_forget=1
nightly
exit_is 1
called "retention on the local repository"
called "$JOB offsite"

setup "a run in progress makes the next one skip"
mkdir -p "$NOTES_BACKUP_STATE_DIR/run.lock"
echo $$ >"$NOTES_BACKUP_STATE_DIR/run.lock/pid"
nightly
exit_is 1
not_called "stop -t"
called "Title: NotesApp backup skipped"
present "$NOTES_BACKUP_STATE_DIR/run.lock"

setup "the lock of a dead run is taken over"
mkdir -p "$NOTES_BACKUP_STATE_DIR/run.lock"
echo 999999 >"$NOTES_BACKUP_STATE_DIR/run.lock/pid"
nightly
exit_is 0
called "$JOB snapshot"
absent "$NOTES_BACKUP_STATE_DIR/run.lock"

setup "a run that died with the app stopped is recovered by the next run"
mkdir -p "$NOTES_BACKUP_STATE_DIR"
: >"$NOTES_BACKUP_STATE_DIR/app-stopped"
echo stopped >"$FAKE_DIR/app"
nightly
exit_is 0
in_order "start notes-notes-1" "$JOB preflight"
called "Title: NotesApp backup interrupted"
in_order "$JOB preflight" "stop -t 45 notes-notes-1"
app_is running

setup "--recover starts the app a dead run left stopped"
mkdir -p "$NOTES_BACKUP_STATE_DIR/run.lock"
: >"$NOTES_BACKUP_STATE_DIR/app-stopped"
echo stopped >"$FAKE_DIR/app"
export FAKE_RESTIC_RUNNING=1
nightly --recover
exit_is 0
in_order "exec notes-backup-1 pkill -x restic" "start notes-notes-1"
called "Title: NotesApp backup interrupted"
app_is running
absent "$NOTES_BACKUP_STATE_DIR/app-stopped"
absent "$NOTES_BACKUP_STATE_DIR/run.lock"

setup "--recover does nothing after a clean run"
nightly --recover
exit_is 0
not_called "docker"

setup "--recover that cannot start the app keeps the marker and alerts"
mkdir -p "$NOTES_BACKUP_STATE_DIR"
: >"$NOTES_BACKUP_STATE_DIR/app-stopped"
echo stopped >"$FAKE_DIR/app"
export FAKE_START_FAIL=99
nightly --recover
called "Title: NotesApp is down"
present "$NOTES_BACKUP_STATE_DIR/app-stopped"

setup "a TERM during the snapshot cancels restic and starts the app"
export FAKE_SNAPSHOT_SLEEP=3 FAKE_RESTIC_RUNNING=1
$SH "$SCRIPTS/nightly.sh" >"$T/output" 2>&1 &
pid=$!
tries=0
until grep -qF "$JOB snapshot" "$FAKE_DIR/calls" || [ "$tries" -ge 50 ]; do
	tries=$((tries + 1))
	sleep 0.1 2>/dev/null || sleep 1
done
kill -TERM "$pid"
wait "$pid"
STATUS=$?
exit_is 143
in_order "$JOB snapshot" "exec notes-backup-1 pkill -x restic"
in_order "exec notes-backup-1 pkill -x restic" "start notes-notes-1"
not_called "$JOB forget"
app_is running
absent "$NOTES_BACKUP_STATE_DIR/app-stopped"
absent "$NOTES_BACKUP_STATE_DIR/run.lock"

setup "an ntfy:// URL (Watchtower's form) is posted to over https"
export NOTES_BACKUP_NTFY_URL=ntfy://ntfy.sh/notes-abc FAKE_FAIL_preflight=1
nightly
called "https://ntfy.sh/notes-abc"

setup "wget is used where curl is missing (the docker:cli image)"
export NOTES_BACKUP_HTTP_CLIENT=wget FAKE_FAIL_preflight=1
nightly
called "wget -q -T 20 -O /dev/null --header Title: NotesApp backup failed"
not_called "curl"

setup "a failing ntfy server does not change the outcome"
export FAKE_HTTP_FAIL=7 FAKE_FAIL_preflight=1
nightly
exit_is 1
output_has "could not post to ntfy"

setup "failures with quotes and backslashes keep status.json valid"
export FAKE_FAIL_preflight=1
nightly
status_has '"failures":"- preflight: Fatal: \"preflight\" went wrong \\ (code 1)'
if command -v jq >/dev/null 2>&1; then
	if jq -e . "$NOTES_BACKUP_STATE_DIR/status.json" >/dev/null; then pass; else fail "status.json is not valid JSON"; fi
fi

setup "restic's output, which names vault files, never reaches the ntfy topic"
export FAKE_FAIL_snapshot=3
export FAKE_STDERR='{"message_type":"error","error":{"message":"read: input/output error"},"during":"archival","item":"/source/notes-data/vault/Private/Diary.md"}'
nightly
exit_is 1
called "|- snapshot (restic exit 3, snapshot 0123abcd kept)|Details:"
not_called "Diary.md"
not_called "input/output error"
status_has 'vault/Private/Diary.md'

setup "a detail cut inside a UTF-8 character, or with control characters, keeps status.json valid"
# A terminal colour code, then x up to byte 299, then the two bytes of "é": the 300-byte cut falls between them.
export FAKE_FAIL_preflight=1
FAKE_STDERR="$(printf '\033')[0m$(printf '%0295d' 0 | tr 0 x)$(printf '\303\251') is next"
export FAKE_STDERR
nightly
exit_is 1
status_has '"failures":"- preflight: ?[0mxxx'
status_has 'xx? "}'
not_ascii=$(LC_ALL=C tr -d '\12\40-\176' <"$NOTES_BACKUP_STATE_DIR/status.json" | wc -c | tr -d ' ')
if [ "$not_ascii" = 0 ]; then pass; else fail "status.json has $not_ascii bytes that are not printable ASCII"; fi
if command -v jq >/dev/null 2>&1; then
	if jq -e . "$NOTES_BACKUP_STATE_DIR/status.json" >/dev/null; then pass; else fail "status.json is not valid JSON"; fi
fi

setup "a state directory the run cannot write is reported, not taken for a run in progress"
# Docker creates a missing bind-mount source as root (DEPLOY.md "Host cron instead of backup-scheduler").
mkdir -p "$NOTES_BACKUP_STATE_DIR"
chmod 555 "$NOTES_BACKUP_STATE_DIR"
if [ -w "$NOTES_BACKUP_STATE_DIR" ]; then
	echo "skipped [$TEST]: chmod cannot make a directory unwritable here (root, or no Unix permissions)"
else
	nightly
	exit_is 1
	not_called "stop -t"
	not_called "$JOB"
	called "Title: NotesApp backup failed"
	called "its state directory $NOTES_BACKUP_STATE_DIR cannot be written"
	not_called "still in progress"
	output_has "ERROR the state directory"
fi
chmod 755 "$NOTES_BACKUP_STATE_DIR"

setup "a state directory that cannot be created is reported too"
: >"$T/not-a-directory"
export NOTES_BACKUP_STATE_DIR="$T/not-a-directory/state"
nightly
exit_is 1
not_called "$JOB"
called "Title: NotesApp backup failed"
called "cannot be written. No backup is taken until that is fixed."
nightly --recover # nothing to recover, and nothing to say
exit_is 0
not_called "Title: NotesApp backup interrupted"

setup "no ntfy URL means no alert and no error"
export FAKE_FAIL_preflight=1 NOTES_BACKUP_NTFY_URL=
nightly
exit_is 1
not_called "Title:"

# ------------------------------------------------------------------ scheduler.sh

next_run() {
	NOTES_BACKUP_NOW=$1 $SH "$SCRIPTS/scheduler.sh" next-run 2>"$T/output"
}

expect_next() {
	got=$(next_run "$1")
	if [ "$got" = "$2" ]; then pass; else fail "next run after $1 is $got, expected $2"; fi
}

setup "the next run is today before the time, tomorrow from the time on"
export TZ=UTC NOTES_BACKUP_TIME=04:00
expect_next 1792209540 1792209600 # 2026-10-17 03:59 -> 04:00 the same day
expect_next 1792209600 1792296000 # 04:00 itself -> the next day
expect_next 1792279800 1792296000 # 23:30 -> the next day

setup "a bad NOTES_BACKUP_TIME is refused"
for bad in 4:00 24:00 04:60 0400 nightly; do
	NOTES_BACKUP_TIME=$bad NOTES_BACKUP_NOW=1792209540 $SH "$SCRIPTS/scheduler.sh" next-run >/dev/null 2>"$T/output"
	STATUS=$?
	exit_is 2
done

if [ -e /usr/share/zoneinfo/America/New_York ]; then
	setup "the end of daylight saving time keeps the run at 04:00 local time"
	export TZ=America/New_York NOTES_BACKUP_TIME=04:00
	expect_next 1793437200 1793523600 # Sat 2026-10-31 05:00 EDT -> Sun 04:00 EST, a 25-hour day later
	expect_next 1793523540 1793523600 # Sun 03:59 EST -> 04:00 EST
	expect_next 1793523600 1793610000 # Sun 04:00 EST -> Mon 04:00 EST
fi

rm -rf "$T"
echo "$PASSED checks passed, $FAILED failed ($SH)"
[ "$FAILED" -eq 0 ]
