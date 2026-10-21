#!/bin/sh
# NotesApp backup jobs (ROADMAP item 1, DESIGN §7.10, DEPLOY.md "Backups"). Runs inside the 'backup'
# container (restic image): its main process is `idle`; nightly.sh runs the other steps with docker exec,
# and you run setup and restores by hand:
#   docker compose exec backup sh /backup/restic-job.sh <command>     (the sidecar is running)
#   docker compose run --rm --no-deps -v <dir>:/target backup <command>  (restores: a one-off container)
#
#   idle                          wait for docker exec calls (the container's main process)
#   init                          create the local repository and, if configured, the off-site one
#   preflight                     the source and local repository are usable; removes stale locks
#   snapshot                      back up /source; the app must be stopped (nightly.sh does that).
#                                 Prints "snapshot=<id>" when restic saved a snapshot.
#   discard <id>                  forget one snapshot of the local repository (nightly.sh: it was not
#                                 taken while the app was stopped after all)
#   forget                        retention on the local repository, then prune
#   offsite                       copy new snapshots off site, retention there, prune. Prints
#                                 "offsite=ok", or "offsite=off" when no off-site repository is set
#   check                         check both repositories, reading a sample of the data
#   snapshots [local|offsite]     list the snapshots
#   restore <local|offsite> <notes-data|tailscale-state> <empty dir> [snapshot]
#                                 restore one volume's contents (default: the latest snapshot)
set -eu

HOST=${NOTES_BACKUP_HOST:-homeserver}
TAG=notes
SOURCE=${NOTES_BACKUP_SOURCE:-/source}
LOCAL=${RESTIC_REPOSITORY:-/repo}
OFFSITE=${NOTES_BACKUP_OFFSITE_REPO:-}
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/run/secrets/restic_password}"

die() {
	echo "restic-job: $*" >&2
	exit 1
}

number() {
	case "$2" in
	'' | *[!0-9]*) die "$1 must be a whole number, not '$2'" ;;
	esac
}

# local|offsite -> repository location
repo_of() {
	case "$1" in
	local) printf '%s\n' "$LOCAL" ;;
	offsite)
		[ -n "$OFFSITE" ] || die "no off-site repository is configured (NOTES_BACKUP_OFFSITE_REPO)"
		printf '%s\n' "$OFFSITE"
		;;
	*) die "unknown repository '$1' (local or offsite)" ;;
	esac
}

# Exit status of opening the repository: 0 opens, 10 does not exist, 12 wrong password, ...
probe() {
	if restic -r "$1" cat config >/dev/null 2>&1; then
		return 0
	else
		return $?
	fi
}

# 7 daily, 4 weekly, 12 monthly (ROADMAP item 1), then prune. $1 = repository.
retention() {
	number NOTES_BACKUP_KEEP_DAILY "${NOTES_BACKUP_KEEP_DAILY:-7}"
	number NOTES_BACKUP_KEEP_WEEKLY "${NOTES_BACKUP_KEEP_WEEKLY:-4}"
	number NOTES_BACKUP_KEEP_MONTHLY "${NOTES_BACKUP_KEEP_MONTHLY:-12}"
	restic -r "$1" forget --retry-lock 10m --host "$HOST" --tag "$TAG" \
		--keep-daily "${NOTES_BACKUP_KEEP_DAILY:-7}" \
		--keep-weekly "${NOTES_BACKUP_KEEP_WEEKLY:-4}" \
		--keep-monthly "${NOTES_BACKUP_KEEP_MONTHLY:-12}" \
		--prune
}

cmd_idle() {
	trap 'exit 0' TERM INT
	echo "backup sidecar ready ($(restic version)); jobs arrive through docker exec"
	while :; do
		sleep 3600 &
		wait $! || :
	done
}

cmd_init() {
	if probe "$LOCAL"; then
		echo "local repository $LOCAL: already initialized"
	else
		status=$?
		[ "$status" -eq 10 ] || die "cannot open the local repository $LOCAL (restic exit $status; 12 = wrong password)"
		if [ -n "$OFFSITE" ] && probe "$OFFSITE"; then
			# A new local disk (or a rebuilt server) next to an existing off-site repository: share its
			# chunker parameters, so the nightly copy keeps deduplicating against what is already there.
			restic -r "$LOCAL" init --from-repo "$OFFSITE" --from-password-file "$RESTIC_PASSWORD_FILE" \
				--copy-chunker-params
		else
			restic -r "$LOCAL" init
		fi
	fi
	if [ -z "$OFFSITE" ]; then
		echo "off-site repository: not configured (NOTES_BACKUP_OFFSITE_REPO is empty)"
	elif probe "$OFFSITE"; then
		echo "off-site repository $OFFSITE: already initialized"
	else
		status=$?
		[ "$status" -eq 10 ] || die "cannot open the off-site repository (restic exit $status; 12 = wrong password)"
		# Same chunker parameters as the local repository, so copied snapshots deduplicate there too.
		restic -r "$OFFSITE" init --from-repo "$LOCAL" --from-password-file "$RESTIC_PASSWORD_FILE" \
			--copy-chunker-params
	fi
	echo "Keep the repository password (the restic-password secret file) in your password manager:"
	echo "without it no backup can be restored."
}

cmd_preflight() {
	[ -s "$RESTIC_PASSWORD_FILE" ] || die "the repository password file $RESTIC_PASSWORD_FILE is missing or empty"
	[ -d "$SOURCE/notes-data/vault" ] || die "$SOURCE/notes-data/vault is missing: is the notes-data volume mounted?"
	[ -d "$SOURCE/tailscale-state" ] || die "$SOURCE/tailscale-state is missing: is the tailscale-state volume mounted?"
	if probe "$LOCAL"; then
		:
	else
		status=$?
		[ "$status" -ne 10 ] || die "the local repository $LOCAL is not initialized: run 'init' first (DEPLOY.md)"
		die "cannot open the local repository $LOCAL (restic exit $status; 12 = wrong password)"
	fi
	# A repository on the vault's own disk would not survive losing that disk (an unmounted USB disk
	# leaves its mount point on the system disk). Bind mounts report the device of the real filesystem.
	if [ -d "$LOCAL" ] && [ "${NOTES_BACKUP_ALLOW_SAME_DISK:-false}" != true ] &&
		[ "$(stat -c %d "$SOURCE/notes-data")" = "$(stat -c %d "$LOCAL")" ]; then
		die "the local repository is on the same filesystem as the vault. Mount a second disk there" \
			"(DEPLOY.md), or set NOTES_BACKUP_ALLOW_SAME_DISK=true if that is really what you want"
	fi
	restic -r "$LOCAL" unlock -q # removes only stale locks, left by a killed run
}

cmd_snapshot() {
	max=${NOTES_BACKUP_MAX_STOP_SECONDS:-1800}
	number NOTES_BACKUP_MAX_STOP_SECONDS "$max"
	out=$(mktemp)
	started=$(date +%s)
	set +e
	# The excluded folders are staging and derived data that the app empties or rebuilds.
	timeout "$max" restic -r "$LOCAL" backup --json --host "$HOST" --tag "$TAG" \
		--exclude "$SOURCE/notes-data/vault/.notesapp/tmp" \
		--exclude "$SOURCE/notes-data/vault/.notesapp/cache" \
		"$SOURCE/notes-data" "$SOURCE/tailscale-state" >"$out"
	status=$?
	set -e
	elapsed=$(($(date +%s) - started))
	summary='fromjson? | select(.message_type == "summary")'
	id=$(jq -rR "$summary | .snapshot_id // empty" "$out" | tail -n 1)
	jq -rR "$summary | \"snapshot \(.snapshot_id // \"none\" | .[0:8]): \(.files_new) new, \(.files_changed) changed,\" +
		\" \(.files_unmodified) unchanged files; \(.data_added) bytes added in \(.total_duration // 0 | floor) s\"" \
		"$out" >&2 || :
	rm -f "$out"
	if [ "$status" -ne 0 ] && [ "$elapsed" -ge "$max" ]; then
		echo "restic-job: the snapshot was cancelled after $max s (NOTES_BACKUP_MAX_STOP_SECONDS)" >&2
	fi
	[ -z "$id" ] || echo "snapshot=$id"
	return "$status"
}

cmd_discard() {
	case "${1:-}" in
	'' | *[!0-9a-f]*) die "discard needs a snapshot id" ;;
	esac
	restic -r "$LOCAL" forget --retry-lock 10m "$1"
}

cmd_offsite() {
	if [ -z "$OFFSITE" ]; then
		echo "off-site copy: not configured (NOTES_BACKUP_OFFSITE_REPO is empty)" >&2
		echo "offsite=off"
		return 0
	fi
	restic -r "$OFFSITE" unlock -q
	# Copies every local snapshot the off-site repository does not have yet, so it catches up after an
	# outage. It reads the local repository, never the live vault, so the app keeps running.
	restic -r "$OFFSITE" copy --retry-lock 10m --from-repo "$LOCAL" \
		--from-password-file "$RESTIC_PASSWORD_FILE" --host "$HOST" --tag "$TAG"
	retention "$OFFSITE"
	echo "offsite=ok"
}

cmd_check() {
	restic -r "$LOCAL" check --retry-lock 10m --read-data-subset 10%
	[ -z "$OFFSITE" ] || restic -r "$OFFSITE" check --retry-lock 10m --read-data-subset 2%
}

cmd_snapshots() {
	repo=$(repo_of "${1:-local}") || exit 1
	restic -r "$repo" snapshots --host "$HOST" --tag "$TAG"
}

cmd_restore() {
	[ $# -ge 3 ] || die "usage: restore <local|offsite> <notes-data|tailscale-state> <empty dir> [snapshot]"
	repo=$(repo_of "$1") || exit 1
	case "$2" in
	notes-data | tailscale-state) ;;
	*) die "restore either notes-data or tailscale-state, not '$2'" ;;
	esac
	[ -d "$3" ] || die "the target $3 does not exist; mount an empty host directory there with -v"
	[ -z "$(ls -A "$3")" ] || die "the target $3 is not empty; restore into an empty directory, then move it into place"
	# <snapshot>:<path> restores that folder's contents directly into the target.
	restic -r "$repo" restore "${4:-latest}:$SOURCE/$2" --host "$HOST" --tag "$TAG" --target "$3"
	echo "restored $2 from the $1 repository into $3"
}

command=${1:-}
[ $# -eq 0 ] || shift
case "$command" in
idle) cmd_idle ;;
init) cmd_init ;;
preflight) cmd_preflight ;;
snapshot) cmd_snapshot ;;
discard) cmd_discard "$@" ;;
forget) retention "$LOCAL" ;;
offsite) cmd_offsite ;;
check) cmd_check ;;
snapshots) cmd_snapshots "$@" ;;
restore) cmd_restore "$@" ;;
*) die "unknown command '$command'; see the list at the top of $0" ;;
esac
