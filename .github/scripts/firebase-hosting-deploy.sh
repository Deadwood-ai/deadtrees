#!/usr/bin/env bash
set -euo pipefail

mode="${1:-}"
if [[ "$mode" != "live" && "$mode" != "preview" ]]; then
	echo "Usage: $0 live|preview" >&2
	exit 2
fi

project_id="${FIREBASE_PROJECT_ID:-deadwood-d4a4b}"
tools_version="${FIREBASE_TOOLS_VERSION:-15.22.2}"
max_attempts="${FIREBASE_DEPLOY_ATTEMPTS:-4}"
runner_temp="${RUNNER_TEMP:-/tmp}"

if [[ -z "${FIREBASE_SERVICE_ACCOUNT:-}" ]]; then
	echo "FIREBASE_SERVICE_ACCOUNT is required" >&2
	exit 2
fi

credential_file="$runner_temp/firebase-service-account.json"
printf '%s' "$FIREBASE_SERVICE_ACCOUNT" >"$credential_file"
chmod 600 "$credential_file"
export GOOGLE_APPLICATION_CREDENTIALS="$credential_file"
# Match FirebaseExtended/action-hosting-deploy so Firebase can attribute these CI deploys.
export FIREBASE_DEPLOY_AGENT="${FIREBASE_DEPLOY_AGENT:-action-hosting-deploy}"
trap 'rm -f "$credential_file"' EXIT

if [[ "$mode" == "live" ]]; then
	command=(npx --yes "firebase-tools@$tools_version" deploy --only hosting --project "$project_id" --json)
else
	channel_id="${FIREBASE_CHANNEL_ID:-}"
	if [[ -z "$channel_id" ]]; then
		echo "FIREBASE_CHANNEL_ID is required for preview deploys" >&2
		exit 2
	fi
	command=(
		npx --yes "firebase-tools@$tools_version"
		hosting:channel:deploy "$channel_id"
		--expires "${FIREBASE_PREVIEW_EXPIRES:-7d}"
		--project "$project_id"
		--json
	)
fi

is_transient_firebase_auth_error() {
	local log_file="$1"
	# firebase-tools collapses OAuth token fetch failures into this generic login hint.
	# Retry it here; genuinely invalid credentials still fail after the attempt budget.
	grep -Eq \
		'Premature close|Invalid response body while trying to fetch https://www.googleapis.com/oauth2|Failed to authenticate' \
		"$log_file"
}

is_live_already_active() {
	local log_file="$1"
	grep -Fq 'current active version' "$log_file" && grep -Fq '/channels/live' "$log_file"
}

for attempt in $(seq 1 "$max_attempts"); do
	log_file="$runner_temp/firebase-hosting-${mode}-${attempt}.log"
	echo "Firebase Hosting ${mode} deploy attempt ${attempt}/${max_attempts}"

	set +e
	"${command[@]}" 2>&1 | tee "$log_file"
	rc="${PIPESTATUS[0]}"
	set -e

	if [[ "$rc" -eq 0 ]]; then
		exit 0
	fi

	if [[ "$mode" == "live" ]] && is_live_already_active "$log_file"; then
		echo "Firebase reports this Hosting version is already active on live; treating as a successful deploy."
		exit 0
	fi

	if [[ "$attempt" -lt "$max_attempts" ]] && is_transient_firebase_auth_error "$log_file"; then
		sleep_seconds=$((attempt * 15))
		echo "Transient Firebase/Google auth transport error detected; retrying in ${sleep_seconds}s."
		sleep "$sleep_seconds"
		continue
	fi

	exit "$rc"
done
