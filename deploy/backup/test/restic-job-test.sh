#!/bin/sh
# Tests restic-job.sh against a real restic, in temporary directories. CI runs it inside the backup service's
# image (.github/workflows/ci.yml), which brings restic, jq and BusyBox:
#   docker run --rm -v "$PWD/deploy/backup:/backup:ro" --entrypoint sh <backup image> /backup/test/restic-job-test.sh
set -u

JOB="$(cd "$(dirname "$0")/.." && pwd)/restic-job.sh"
W=$(mktemp -d)
PASSED=0
FAILED=0
TEST=

export NOTES_BACKUP_SOURCE="$W/source"
export RESTIC_REPOSITORY="$W/repo"
export NOTES_BACKUP_OFFSITE_REPO="$W/offsite"
export RESTIC_PASSWORD_FILE="$W/password"
export RESTIC_CACHE_DIR="$W/cache"
export NOTES_BACKUP_ALLOW_SAME_DISK=true # everything here is on one filesystem
VAULT="$NOTES_BACKUP_SOURCE/notes-data/vault"

pass() { PASSED=$((PASSED + 1)); }

fail() {
	FAILED=$((FAILED + 1))
	echo "FAIL [$TEST] $*"
	sed 's/^/  /' "$W/out" 2>/dev/null
}

# Runs restic-job.sh; stdout and stderr land in $W/out, the status in $STATUS.
job() {
	sh "$JOB" "$@" >"$W/out" 2>&1
	STATUS=$?
}

# job with one environment variable changed: job_with NAME=value command [args]
job_with() {
	setting=$1
	shift
	env "$setting" sh "$JOB" "$@" >"$W/out" 2>&1
	STATUS=$?
}

succeeds() {
	TEST=$*
	job "$@"
	if [ "$STATUS" -eq 0 ]; then pass; else fail "exit status $STATUS, expected 0"; fi
}

fails() {
	TEST=$*
	job "$@"
	if [ "$STATUS" -ne 0 ]; then pass; else fail "succeeded, expected a failure"; fi
}

output_has() {
	if grep -qF -- "$1" "$W/out"; then pass; else fail "expected output containing: $1"; fi
}

same_file() {
	if cmp -s "$1" "$2"; then pass; else fail "$2 differs from $1"; fi
}

absent() {
	if [ -e "$1" ]; then fail "$1 should not exist"; else pass; fi
}

count_snapshots() {
	restic -r "$1" snapshots --json --host homeserver --tag notes | jq length
}

expect_count() {
	got=$(count_snapshots "$1")
	if [ "$got" = "$2" ]; then pass; else fail "$1 has $got snapshots, expected $2"; fi
}

printf 'test password\n' >"$RESTIC_PASSWORD_FILE"
mkdir -p "$VAULT/.git/refs/heads" "$VAULT/.notesapp/tmp" "$VAULT/.notesapp/cache" "$VAULT/Projects" \
	"$NOTES_BACKUP_SOURCE/tailscale-state" "$RESTIC_REPOSITORY"
printf '# Plan\n\nWith "quotes" and a [[Link]].\n' >"$VAULT/Projects/Plan.md"
printf 'ref: refs/heads/main\n' >"$VAULT/.git/HEAD"
printf '0123456789abcdef0123456789abcdef01234567\n' >"$VAULT/.git/refs/heads/main"
printf 'half-written upload' >"$VAULT/.notesapp/tmp/1234.tmp"
printf 'derived' >"$VAULT/.notesapp/cache/index"
printf '{"node":"key"}' >"$NOTES_BACKUP_SOURCE/tailscale-state/tailscaled.state"

fails preflight
output_has "is not initialized: run 'init' first"

succeeds init
output_has "created restic repository"
succeeds init
output_has "local repository $RESTIC_REPOSITORY: already initialized"
output_has "off-site repository $NOTES_BACKUP_OFFSITE_REPO: already initialized"

succeeds preflight

TEST="the local repository on the vault's filesystem is refused"
job_with NOTES_BACKUP_ALLOW_SAME_DISK=false preflight
if [ "$STATUS" -ne 0 ]; then pass; else fail "preflight accepted a repository on the vault's filesystem"; fi
output_has "on the same filesystem as the vault"

TEST="a missing password file is refused"
job_with RESTIC_PASSWORD_FILE="$W/nope" preflight
if [ "$STATUS" -ne 0 ]; then pass; else fail "preflight accepted a missing password file"; fi

succeeds snapshot
FIRST=$(sed -n 's/^snapshot=//p' "$W/out")
case "$FIRST" in
[0-9a-f]*) pass ;;
*) fail "no snapshot id printed" ;;
esac
output_has "4 new, 0 changed" # Plan.md, .git/HEAD, refs/heads/main, tailscaled.state
expect_count "$RESTIC_REPOSITORY" 1

succeeds snapshots local
output_has "${FIRST%"${FIRST#????????}"}"

succeeds offsite
output_has "offsite=ok"
expect_count "$NOTES_BACKUP_OFFSITE_REPO" 1

TEST="restore notes-data from the local repository"
mkdir "$W/restore-local"
succeeds restore local notes-data "$W/restore-local"
same_file "$VAULT/Projects/Plan.md" "$W/restore-local/vault/Projects/Plan.md"
same_file "$VAULT/.git/refs/heads/main" "$W/restore-local/vault/.git/refs/heads/main"
absent "$W/restore-local/vault/.notesapp/tmp/1234.tmp"
absent "$W/restore-local/vault/.notesapp/cache/index"

TEST="restore tailscale-state from the off-site repository"
mkdir "$W/restore-offsite"
succeeds restore offsite tailscale-state "$W/restore-offsite"
same_file "$NOTES_BACKUP_SOURCE/tailscale-state/tailscaled.state" "$W/restore-offsite/tailscaled.state"

fails restore local notes-data "$W/restore-local"
output_has "is not empty"
fails restore local notes-data "$W/missing"
fails restore local vault "$W/restore-empty"
fails restore elsewhere notes-data "$W/restore-empty"

TEST="a changed note is in the next snapshot"
printf '# Plan\n\nChanged.\n' >"$VAULT/Projects/Plan.md"
succeeds snapshot
SECOND=$(sed -n 's/^snapshot=//p' "$W/out")
output_has "0 new, 1 changed"
mkdir "$W/restore-second"
succeeds restore local notes-data "$W/restore-second" "$SECOND"
same_file "$VAULT/Projects/Plan.md" "$W/restore-second/vault/Projects/Plan.md"

succeeds discard "$SECOND"
expect_count "$RESTIC_REPOSITORY" 1
fails discard
fails discard "not-an-id"

TEST="retention keeps one snapshot per day"
succeeds snapshot
succeeds snapshot
expect_count "$RESTIC_REPOSITORY" 3
succeeds forget
expect_count "$RESTIC_REPOSITORY" 1
job_with NOTES_BACKUP_KEEP_DAILY=seven forget
if [ "$STATUS" -ne 0 ]; then pass; else fail "forget accepted a keep value that is not a number"; fi

succeeds offsite
expect_count "$NOTES_BACKUP_OFFSITE_REPO" 1
succeeds check

TEST="without an off-site repository, offsite does nothing"
job_with NOTES_BACKUP_OFFSITE_REPO= offsite
if [ "$STATUS" -eq 0 ]; then pass; else fail "exit status $STATUS"; fi
output_has "offsite=off"
job_with NOTES_BACKUP_OFFSITE_REPO= snapshots offsite
if [ "$STATUS" -ne 0 ]; then pass; else fail "listing an unconfigured off-site repository succeeded"; fi

TEST="a new local disk next to an existing off-site repository shares its chunker parameters"
mkdir "$W/repo2"
job_with RESTIC_REPOSITORY="$W/repo2" init
if [ "$STATUS" -eq 0 ]; then pass; else fail "exit status $STATUS"; fi
output_has "created restic repository"
polynomial() { restic -r "$1" cat config | jq -r .chunker_polynomial; }
if [ "$(polynomial "$W/repo2")" = "$(polynomial "$NOTES_BACKUP_OFFSITE_REPO")" ] &&
	[ "$(polynomial "$RESTIC_REPOSITORY")" = "$(polynomial "$NOTES_BACKUP_OFFSITE_REPO")" ]; then
	pass
else
	fail "the repositories have different chunker parameters"
fi

fails no-such-command

rm -rf "$W"
echo "$PASSED checks passed, $FAILED failed (restic-job.sh, $(restic version))"
[ "$FAILED" -eq 0 ]
