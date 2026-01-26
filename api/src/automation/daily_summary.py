#!/usr/bin/env python3
"""
Daily Platform Activity Summary for Zulip

Gathers platform metrics and posts a formatted summary to Zulip.
Designed to run via cron at 8:00 AM CET on weekdays.

Usage:
    python -m api.src.automation.daily_summary
    # or via docker exec:
    docker compose exec api python /app/api/src/automation/daily_summary.py
"""

import httpx
from datetime import datetime, timedelta
from dataclasses import dataclass, field
from supabase import create_client, Client

from shared.settings import settings


# Country to emoji flag mapping
COUNTRY_FLAGS = {
	"Germany": "🇩🇪",
	"United States": "🇺🇸",
	"South Africa": "🇿🇦",
	"Spain": "🇪🇸",
	"France": "🇫🇷",
	"Brazil": "🇧🇷",
	"Australia": "🇦🇺",
	"Canada": "🇨🇦",
	"United Kingdom": "🇬🇧",
	"Italy": "🇮🇹",
	"Netherlands": "🇳🇱",
	"Austria": "🇦🇹",
	"Switzerland": "🇨🇭",
	"Poland": "🇵🇱",
	"Sweden": "🇸🇪",
	"Norway": "🇳🇴",
	"Finland": "🇫🇮",
	"Denmark": "🇩🇰",
	"Belgium": "🇧🇪",
	"Czech Republic": "🇨🇿",
	"Czechia": "🇨🇿",
	"Portugal": "🇵🇹",
	"Greece": "🇬🇷",
	"Ireland": "🇮🇪",
	"New Zealand": "🇳🇿",
	"Japan": "🇯🇵",
	"China": "🇨🇳",
	"India": "🇮🇳",
	"Mexico": "🇲🇽",
	"Argentina": "🇦🇷",
	"Chile": "🇨🇱",
	"Colombia": "🇨🇴",
	"Peru": "🇵🇪",
	"Kenya": "🇰🇪",
	"Nigeria": "🇳🇬",
	"Egypt": "🇪🇬",
	"Morocco": "🇲🇦",
	"Russia": "🇷🇺",
	"Ukraine": "🇺🇦",
	"Turkey": "🇹🇷",
	"Israel": "🇮🇱",
	"Saudi Arabia": "🇸🇦",
	"United Arab Emirates": "🇦🇪",
	"Singapore": "🇸🇬",
	"Malaysia": "🇲🇾",
	"Indonesia": "🇮🇩",
	"Thailand": "🇹🇭",
	"Vietnam": "🇻🇳",
	"Philippines": "🇵🇭",
	"South Korea": "🇰🇷",
	"Taiwan": "🇹🇼",
}


@dataclass
class SummaryMetrics:
	"""Container for all summary metrics"""
	# Time period
	period_start: datetime
	period_end: datetime
	period_label: str  # e.g., "last 24h" or "since Friday"
	
	# Website activity (from PostHog)
	unique_visitors: int = 0
	page_views: int = 0
	
	# Uploads
	total_uploads: int = 0
	successful_uploads: int = 0
	failed_uploads: int = 0
	processing_uploads: int = 0
	upload_countries: dict = field(default_factory=dict)
	uploaders: list = field(default_factory=list)
	
	# Failures (7 days for context)
	recent_failures: list = field(default_factory=list)
	
	# Data quality
	audits_completed: int = 0
	reference_patches_created: int = 0
	top_auditors: list = field(default_factory=list)


def get_lookback_period() -> tuple[datetime, datetime, str]:
	"""
	Calculate the lookback period based on current day.
	- Monday: Look back to Friday 8:00 AM (covers weekend)
	- Other days: Look back 24 hours
	"""
	now = datetime.now()
	
	if now.weekday() == 0:  # Monday
		# Look back to Friday 8:00 AM
		days_back = 3
		period_label = "since Friday"
	else:
		days_back = 1
		period_label = "last 24h"
	
	period_start = now - timedelta(days=days_back)
	period_end = now
	
	return period_start, period_end, period_label


def get_supabase_client() -> Client:
	"""Create Supabase client with service role key for full access"""
	# Use service role key for accessing auth.users and bypassing RLS
	key = settings.SUPABASE_SERVICE_ROLE_KEY or settings.SUPABASE_KEY
	return create_client(settings.SUPABASE_URL, key)


def fetch_posthog_metrics(period_start: datetime, period_end: datetime) -> tuple[int, int]:
	"""
	Fetch website metrics from PostHog API.
	Returns (unique_visitors, page_views)
	"""
	if not settings.POSTHOG_API_KEY or not settings.POSTHOG_PROJECT_ID:
		print("Warning: PostHog not configured, skipping website metrics")
		return 0, 0
	
	headers = {
		"Authorization": f"Bearer {settings.POSTHOG_API_KEY}",
		"Content-Type": "application/json",
	}
	
	# Calculate date range for PostHog
	date_from = period_start.strftime("%Y-%m-%dT%H:%M:%S")
	date_to = period_end.strftime("%Y-%m-%dT%H:%M:%S")
	
	unique_visitors = 0
	page_views = 0
	
	try:
		with httpx.Client(timeout=30) as client:
			url = f"{settings.POSTHOG_HOST}/api/projects/{settings.POSTHOG_PROJECT_ID}/query/"
			
			# Query for unique visitors (DAU)
			dau_query = {
				"query": {
					"kind": "InsightVizNode",
					"source": {
						"kind": "TrendsQuery",
						"dateRange": {"date_from": date_from, "date_to": date_to},
						"series": [{"kind": "EventsNode", "event": "$pageview", "custom_name": "Visitors", "math": "dau"}]
					}
				}
			}
			
			response = client.post(url, json=dau_query, headers=headers)
			
			if response.status_code == 200:
				data = response.json()
				if "results" in data and data["results"]:
					for result in data["results"]:
						if "data" in result:
							unique_visitors = sum(result["data"])
			
			# Query for page views
			pageview_query = {
				"query": {
					"kind": "InsightVizNode",
					"source": {
						"kind": "TrendsQuery",
						"dateRange": {"date_from": date_from, "date_to": date_to},
						"series": [{"kind": "EventsNode", "event": "$pageview", "custom_name": "Page Views", "math": "total"}]
					}
				}
			}
			
			response = client.post(url, json=pageview_query, headers=headers)
			
			if response.status_code == 200:
				data = response.json()
				if "results" in data and data["results"]:
					for result in data["results"]:
						if "data" in result:
							page_views = sum(result["data"])
	
	except Exception as e:
		print(f"Warning: Failed to fetch PostHog metrics: {e}")
	
	return unique_visitors, page_views


def fetch_upload_metrics(client: Client, period_start: datetime) -> dict:
	"""Fetch upload statistics from database"""
	stats = {"total": 0, "successful": 0, "failed": 0, "processing": 0}
	
	# Get datasets created after period_start with their status
	# Using PostgREST embedding to join v2_datasets with v2_statuses
	period_str = period_start.isoformat()
	
	response = client.table(settings.datasets_table).select(
		'id, v2_statuses(has_error, current_status)'
	).gte('created_at', period_str).execute()
	
	if response.data:
		for row in response.data:
			stats["total"] += 1
			status_data = row.get("v2_statuses")
			
			# PostgREST returns list for joins - get first item if list
			if isinstance(status_data, list) and len(status_data) > 0:
				status = status_data[0]
			elif isinstance(status_data, dict):
				status = status_data
			else:
				status = None
			
			if status:
				has_error = status.get("has_error", False)
				current_status = status.get("current_status", "idle")
				
				if has_error:
					stats["failed"] += 1
				elif current_status == "idle":
					stats["successful"] += 1
				else:
					stats["processing"] += 1
	
	return stats


def fetch_upload_details(client: Client, period_start: datetime) -> tuple[dict, list]:
	"""Fetch country breakdown and uploader emails"""
	countries = {}
	uploaders = set()
	period_str = period_start.isoformat()
	
	# Get datasets with metadata (for country)
	datasets_response = client.table(settings.datasets_table).select(
		'id, user_id, v2_metadata(metadata)'
	).gte('created_at', period_str).execute()
	
	user_ids = set()
	
	if datasets_response.data:
		for row in datasets_response.data:
			user_id = row.get("user_id")
			if user_id:
				user_ids.add(user_id)
			
			# Extract country from metadata
			metadata_data = row.get("v2_metadata")
			
			# PostgREST returns list for joins - get first item if list
			if isinstance(metadata_data, list) and len(metadata_data) > 0:
				metadata_row = metadata_data[0]
			elif isinstance(metadata_data, dict):
				metadata_row = metadata_data
			else:
				metadata_row = None
			
			if metadata_row:
				metadata = metadata_row.get("metadata", {})
				if isinstance(metadata, dict):
					gadm = metadata.get("gadm", {})
					if isinstance(gadm, dict):
						country = gadm.get("admin_level_1")
						if country:
							countries[country] = countries.get(country, 0) + 1
	
	# Fetch user emails using service role (auth.users access)
	if user_ids:
		for user_id in user_ids:
			try:
				# Access auth.users via admin API
				user_response = client.auth.admin.get_user_by_id(user_id)
				if user_response and user_response.user:
					email = user_response.user.email
					if email:
						uploaders.add(email)
			except Exception as e:
				print(f"Warning: Could not fetch user {user_id}: {e}")
	
	return countries, list(uploaders)


def fetch_recent_failures(client: Client) -> list:
	"""Fetch recent failures (7 days) for context"""
	seven_days_ago = (datetime.now() - timedelta(days=7)).isoformat()
	failures = []
	
	# Get datasets with errors
	response = client.table(settings.datasets_table).select(
		'id, file_name, v2_statuses(error_message, has_error)'
	).gte('created_at', seven_days_ago).execute()
	
	if response.data:
		for row in response.data:
			status_data = row.get("v2_statuses")
			
			# PostgREST returns list for joins - get first item if list
			if isinstance(status_data, list) and len(status_data) > 0:
				status = status_data[0]
			elif isinstance(status_data, dict):
				status = status_data
			else:
				status = None
			
			if status and status.get("has_error"):
				error_msg = status.get("error_message", "Unknown error")
				if error_msg:
					error_msg = error_msg[:100]  # Truncate
				failures.append({
					"id": row.get("id"),
					"file_name": row.get("file_name"),
					"error_message": error_msg
				})
	
	return failures[:5]  # Limit to 5


def fetch_audit_metrics(client: Client, period_start: datetime) -> tuple[int, list]:
	"""Fetch audit statistics and top auditors"""
	period_str = period_start.isoformat()
	
	# Get audits from period
	response = client.table('dataset_audit').select(
		'dataset_id, audited_by'
	).gte('audit_date', period_str).execute()
	
	audit_count = 0
	auditor_counts = {}
	auditor_ids = set()
	
	if response.data:
		audit_count = len(response.data)
		for row in response.data:
			auditor_id = row.get("audited_by")
			if auditor_id:
				auditor_ids.add(auditor_id)
				auditor_counts[auditor_id] = auditor_counts.get(auditor_id, 0) + 1
	
	# Get auditor emails
	top_auditors = []
	auditor_emails = {}
	
	for auditor_id in auditor_ids:
		try:
			user_response = client.auth.admin.get_user_by_id(auditor_id)
			if user_response and user_response.user:
				auditor_emails[auditor_id] = user_response.user.email
		except Exception as e:
			print(f"Warning: Could not fetch auditor {auditor_id}: {e}")
	
	# Build top auditors list
	sorted_auditors = sorted(auditor_counts.items(), key=lambda x: -x[1])
	for auditor_id, count in sorted_auditors[:5]:
		email = auditor_emails.get(auditor_id, f"user-{auditor_id[:8]}")
		top_auditors.append({"email": email, "count": count})
	
	return audit_count, top_auditors


def fetch_reference_patches(client: Client, period_start: datetime) -> int:
	"""Fetch count of reference patches created"""
	period_str = period_start.isoformat()
	
	response = client.table('reference_patches').select(
		'id', count='exact'
	).gte('created_at', period_str).execute()
	
	return response.count if response.count else 0


def gather_metrics() -> SummaryMetrics:
	"""Gather all metrics for the summary"""
	period_start, period_end, period_label = get_lookback_period()
	
	print(f"Gathering metrics for period: {period_start} to {period_end} ({period_label})")
	
	# Initialize metrics
	metrics = SummaryMetrics(
		period_start=period_start,
		period_end=period_end,
		period_label=period_label,
	)
	
	# Fetch PostHog metrics
	metrics.unique_visitors, metrics.page_views = fetch_posthog_metrics(period_start, period_end)
	print(f"  Website: {metrics.unique_visitors} visitors, {metrics.page_views} page views")
	
	# Fetch database metrics
	try:
		client = get_supabase_client()
		
		# Upload stats
		upload_stats = fetch_upload_metrics(client, period_start)
		metrics.total_uploads = upload_stats["total"]
		metrics.successful_uploads = upload_stats["successful"]
		metrics.failed_uploads = upload_stats["failed"]
		metrics.processing_uploads = upload_stats["processing"]
		print(f"  Uploads: {metrics.total_uploads} total ({metrics.successful_uploads} ok, {metrics.failed_uploads} failed)")
		
		# Upload details
		metrics.upload_countries, metrics.uploaders = fetch_upload_details(client, period_start)
		print(f"  Countries: {metrics.upload_countries}")
		
		# Recent failures
		metrics.recent_failures = fetch_recent_failures(client)
		print(f"  Recent failures: {len(metrics.recent_failures)}")
		
		# Audit metrics
		metrics.audits_completed, metrics.top_auditors = fetch_audit_metrics(client, period_start)
		print(f"  Audits: {metrics.audits_completed} completed")
		
		# Reference patches
		metrics.reference_patches_created = fetch_reference_patches(client, period_start)
		print(f"  Reference patches: {metrics.reference_patches_created}")
		
	except Exception as e:
		print(f"Warning: Failed to fetch database metrics: {e}")
		import traceback
		traceback.print_exc()
		print("  Continuing with PostHog metrics only...")
	
	return metrics


def format_country_list(countries: dict) -> str:
	"""Format countries with flag emojis"""
	if not countries:
		return "No data"
	
	items = []
	for country, count in sorted(countries.items(), key=lambda x: -x[1]):
		flag = COUNTRY_FLAGS.get(country, "🌍")
		items.append(f"{flag} {country} ({count})")
	
	return ", ".join(items)


def format_message(metrics: SummaryMetrics) -> str:
	"""Format the summary message for Zulip"""
	date_str = metrics.period_end.strftime("%a, %b %d, %Y")
	
	# Build message sections
	sections = []
	
	# Header
	sections.append(f"## 🌲 deadtrees.earth Daily Summary ({date_str})")
	sections.append("")
	
	# Website Activity
	sections.append("### 📊 Website Activity")
	if metrics.unique_visitors > 0 or metrics.page_views > 0:
		sections.append(f"- **Visitors**: {metrics.unique_visitors} unique | {metrics.page_views} page views")
	else:
		sections.append("- *PostHog not configured or no data*")
	sections.append("")
	
	# Uploads
	sections.append(f"### 📤 Uploads ({metrics.period_label})")
	sections.append(f"- **New datasets**: {metrics.total_uploads}")
	
	if metrics.total_uploads > 0:
		status_parts = []
		if metrics.successful_uploads > 0:
			status_parts.append(f"✅ {metrics.successful_uploads} successful")
		if metrics.processing_uploads > 0:
			status_parts.append(f"⏳ {metrics.processing_uploads} processing")
		if metrics.failed_uploads > 0:
			status_parts.append(f"❌ {metrics.failed_uploads} failed")
		
		if status_parts:
			sections.append(f"- **Status**: {' | '.join(status_parts)}")
		
		if metrics.uploaders:
			sections.append(f"- **Contributors**: {', '.join(metrics.uploaders)}")
		
		if metrics.upload_countries:
			sections.append(f"- **Countries**: {format_country_list(metrics.upload_countries)}")
	else:
		sections.append("- *No new uploads*")
	sections.append("")
	
	# Failures (if any)
	if metrics.recent_failures:
		sections.append("### ⚠️ Failures (last 7 days)")
		for failure in metrics.recent_failures:
			error_short = (failure["error_message"] or "Unknown").split("\n")[0][:60]
			sections.append(f"- Dataset {failure['id']} ({failure['file_name']}) - {error_short}")
		sections.append("")
	
	# Data Quality
	sections.append(f"### ✅ Data Quality ({metrics.period_label})")
	sections.append(f"- **Audits completed**: {metrics.audits_completed}")
	sections.append(f"- **Reference patches created**: {metrics.reference_patches_created}")
	sections.append("")
	
	# Auditor Shoutout
	if metrics.top_auditors and metrics.audits_completed > 0:
		sections.append("### 🙏 Auditor Shoutout")
		sections.append("Thank you to our data quality heroes:")
		medals = ["🥇", "🥈", "🥉", "4️⃣", "5️⃣"]
		for i, auditor in enumerate(metrics.top_auditors[:5]):
			medal = medals[i] if i < len(medals) else "•"
			sections.append(f"- {medal} {auditor['email']} ({auditor['count']} audits)")
		sections.append("")
	
	# Footer
	sections.append("---")
	sections.append(f"*Generated automatically at {metrics.period_end.strftime('%H:%M')} CET*")
	
	return "\n".join(sections)


def post_to_zulip(message: str) -> bool:
	"""Post the summary message to Zulip"""
	if not settings.ZULIP_EMAIL or not settings.ZULIP_API_KEY or not settings.ZULIP_SITE:
		print("Error: Zulip not configured. Please set ZULIP_EMAIL, ZULIP_API_KEY, and ZULIP_SITE.")
		print("\nMessage that would have been posted:")
		print("-" * 40)
		print(message)
		print("-" * 40)
		return False
	
	url = f"{settings.ZULIP_SITE}/api/v1/messages"
	
	data = {
		"type": "stream",
		"to": settings.ZULIP_STREAM,
		"topic": settings.ZULIP_TOPIC,
		"content": message,
	}
	
	try:
		with httpx.Client(timeout=30) as client:
			response = client.post(
				url,
				data=data,
				auth=(settings.ZULIP_EMAIL, settings.ZULIP_API_KEY),
			)
			
			if response.status_code == 200:
				result = response.json()
				if result.get("result") == "success":
					print(f"Successfully posted to Zulip: {settings.ZULIP_STREAM} > {settings.ZULIP_TOPIC}")
					return True
				else:
					print(f"Zulip API error: {result}")
					return False
			else:
				print(f"Zulip HTTP error {response.status_code}: {response.text}")
				return False
	
	except Exception as e:
		print(f"Failed to post to Zulip: {e}")
		return False


def main(dry_run: bool = False):
	"""
	Main entry point
	
	Args:
		dry_run: If True, print the message but don't post to Zulip
	"""
	print("=" * 60)
	print("Daily Platform Activity Summary")
	print(f"Run time: {datetime.now().isoformat()}")
	if dry_run:
		print("MODE: DRY RUN (will not post to Zulip)")
	print("=" * 60)
	
	# Gather all metrics
	metrics = gather_metrics()
	
	# Format the message
	message = format_message(metrics)
	
	print("\n" + "=" * 60)
	print("Generated Message:")
	print("=" * 60)
	print(message)
	print("=" * 60 + "\n")
	
	if dry_run:
		print("✅ Dry run complete - message NOT posted to Zulip")
		return 0
	
	# Post to Zulip
	success = post_to_zulip(message)
	
	if success:
		print("✅ Daily summary posted successfully!")
		return 0
	else:
		print("❌ Failed to post daily summary")
		return 1


if __name__ == "__main__":
	import sys
	
	# Check for --dry-run flag
	dry_run = "--dry-run" in sys.argv or "-n" in sys.argv
	
	exit(main(dry_run=dry_run))
