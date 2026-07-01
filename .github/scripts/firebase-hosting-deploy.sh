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
auth_mode="${FIREBASE_AUTH_MODE:-access-token}"

if [[ -z "${FIREBASE_SERVICE_ACCOUNT:-}" ]]; then
	echo "FIREBASE_SERVICE_ACCOUNT is required" >&2
	exit 2
fi

credential_file="$runner_temp/firebase-service-account.json"
printf '%s' "$FIREBASE_SERVICE_ACCOUNT" >"$credential_file"
chmod 600 "$credential_file"
# Match FirebaseExtended/action-hosting-deploy so Firebase can attribute these CI deploys.
export FIREBASE_DEPLOY_AGENT="${FIREBASE_DEPLOY_AGENT:-action-hosting-deploy}"
trap 'rm -f "$credential_file"' EXIT

mint_access_token() {
	local assertion token_response access_token

	# firebase-tools currently fails in GitHub Actions while using google-auth-library's
	# ADC token exchange. Mint the same OAuth token with curl so transport retries are
	# explicit and independent of the Firebase CLI's Node fetch path.
	assertion="$(node - "$credential_file" <<'NODE'
const crypto = require("crypto");
const fs = require("fs");

const credentialPath = process.argv[2];
const credential = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
const now = Math.floor(Date.now() / 1000);

function base64url(value) {
  return Buffer.from(JSON.stringify(value))
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

const header = { alg: "RS256", typ: "JWT" };
const claims = {
  iss: credential.client_email,
  scope: "https://www.googleapis.com/auth/cloud-platform",
  aud: "https://oauth2.googleapis.com/token",
  iat: now,
  exp: now + 3600,
};
const unsigned = `${base64url(header)}.${base64url(claims)}`;
const signature = crypto
  .createSign("RSA-SHA256")
  .update(unsigned)
  .sign(credential.private_key, "base64")
  .replace(/=/g, "")
  .replace(/\+/g, "-")
  .replace(/\//g, "_");

process.stdout.write(`${unsigned}.${signature}`);
NODE
)"

	token_response="$(
		curl --fail-with-body --retry 5 --retry-all-errors --retry-delay 5 \
			--silent --show-error \
			--request POST "https://oauth2.googleapis.com/token" \
			--header "Content-Type: application/x-www-form-urlencoded" \
			--data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer" \
			--data-urlencode "assertion=$assertion"
	)"
	access_token="$(node -e '
const fs = require("fs");
const body = JSON.parse(fs.readFileSync(0, "utf8"));
if (!body.access_token) {
  console.error("OAuth token response did not include access_token");
  process.exit(1);
}
process.stdout.write(body.access_token);
' <<<"$token_response")"

	if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
		echo "::add-mask::$access_token"
	fi
	export FIREBASE_TOKEN="$access_token"
	unset GOOGLE_APPLICATION_CREDENTIALS
}

case "$auth_mode" in
	access-token)
		mint_access_token
		;;
	adc)
		export GOOGLE_APPLICATION_CREDENTIALS="$credential_file"
		;;
	*)
		echo "Unsupported FIREBASE_AUTH_MODE: $auth_mode" >&2
		exit 2
		;;
esac

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

is_hosting_version_already_active() {
	local log_file="$1"
	grep -Fq 'current active version' "$log_file" && grep -Fq '/channels/' "$log_file"
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

	if is_hosting_version_already_active "$log_file"; then
		echo "Firebase reports this Hosting version is already active on the target channel; treating as a successful deploy."
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
