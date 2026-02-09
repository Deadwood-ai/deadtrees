"""
Tests for the email notification system.

Uses Mailpit (local email testing server) to capture and verify sent emails.
All test emails are sent to jesvajnajehle@gmail.com.

Requires Mailpit SMTP port to be enabled in supabase/config.toml:
  smtp_port = 54325
"""

import pytest
from api.src.notifications.email import send_email
from api.src.notifications.notify import notify_dataset_failed, notify_dataset_completed
from api.src.notifications.templates import dataset_failed_email, dataset_completed_email
from api.src.notifications.mailpit import (
	purge_messages,
	get_messages,
	assert_email_received,
	get_message_by_id,
)

TEST_EMAIL = "jesvajnajehle@gmail.com"


# ---- Template unit tests ----

def test_failed_template_generates_subject_and_body():
	"""Template for failure should contain dataset ID and error."""
	subject, body = dataset_failed_email(999, "my_ortho.tif", "CUDA out of memory")

	assert "999" in subject
	assert "Failed" in subject
	assert "999" in body
	assert "my_ortho.tif" in body
	assert "CUDA out of memory" in body


def test_completed_template_generates_subject_and_body():
	"""Template for completion should contain dataset ID and link."""
	subject, body = dataset_completed_email(1234, "forest_scan.tif")

	assert "1234" in subject
	assert "Complete" in subject
	assert "1234" in body
	assert "forest_scan.tif" in body
	assert "View Dataset" in body


# ---- Email sending + Mailpit verification tests ----

@pytest.fixture(autouse=False)
def clean_mailpit():
	"""Purge all Mailpit messages before and after each email test."""
	purge_messages()
	yield
	purge_messages()


def test_send_failure_notification_email(clean_mailpit):
	"""Send a dataset failure email and verify it arrives in Mailpit."""
	result = notify_dataset_failed(
		dataset_id=999,
		error_message="Chunk and warp failed: untiled input",
		to_email=TEST_EMAIL,
		file_name="test_ortho_999.tif",
	)

	assert result["success"] is True, f"Email send failed: {result.get('error')}"

	# Verify the email was captured by Mailpit
	msg = assert_email_received(
		expected_subject="Dataset 999 - Processing Failed",
		expected_to=TEST_EMAIL,
	)

	# Check sender
	from_addr = msg.get("From", {}).get("Address", "")
	assert "deadtrees" in from_addr.lower() or "notifications" in from_addr.lower()


def test_send_success_notification_email(clean_mailpit):
	"""Send a dataset completion email and verify it arrives in Mailpit."""
	result = notify_dataset_completed(
		dataset_id=1234,
		to_email=TEST_EMAIL,
		file_name="forest_drone_1234.tif",
	)

	assert result["success"] is True, f"Email send failed: {result.get('error')}"

	# Verify the email was captured by Mailpit
	msg = assert_email_received(
		expected_subject="Dataset 1234 - Processing Complete",
		expected_to=TEST_EMAIL,
	)

	# Check sender
	from_addr = msg.get("From", {}).get("Address", "")
	assert "deadtrees" in from_addr.lower() or "notifications" in from_addr.lower()


def test_send_failure_email_body_contains_error(clean_mailpit):
	"""Verify the failure email HTML body includes the error message."""
	error_msg = "GDAL error: cannot open file"

	result = notify_dataset_failed(
		dataset_id=5555,
		error_message=error_msg,
		to_email=TEST_EMAIL,
		file_name="broken_file.tif",
	)
	assert result["success"] is True

	msg = assert_email_received(
		expected_subject="Dataset 5555 - Processing Failed",
		expected_to=TEST_EMAIL,
	)

	# Fetch full message to check HTML body
	full_msg = get_message_by_id(msg["ID"])
	assert full_msg is not None

	html_body = full_msg.get("HTML", "")
	assert error_msg in html_body
	assert "broken_file.tif" in html_body


def test_send_success_email_body_contains_link(clean_mailpit):
	"""Verify the completion email HTML body includes a link to the dataset."""
	result = notify_dataset_completed(
		dataset_id=7777,
		to_email=TEST_EMAIL,
		file_name="good_ortho.tif",
	)
	assert result["success"] is True

	msg = assert_email_received(
		expected_subject="Dataset 7777 - Processing Complete",
		expected_to=TEST_EMAIL,
	)

	# Fetch full message to check HTML body
	full_msg = get_message_by_id(msg["ID"])
	assert full_msg is not None

	html_body = full_msg.get("HTML", "")
	assert "good_ortho.tif" in html_body
	assert "datasets/7777" in html_body


def test_multiple_notifications_in_sequence(clean_mailpit):
	"""Send both failure and success emails and verify both arrive."""
	# Send failure
	r1 = notify_dataset_failed(
		dataset_id=100,
		error_message="Some error",
		to_email=TEST_EMAIL,
		file_name="file_a.tif",
	)
	assert r1["success"] is True

	# Send success
	r2 = notify_dataset_completed(
		dataset_id=200,
		to_email=TEST_EMAIL,
		file_name="file_b.tif",
	)
	assert r2["success"] is True

	# Verify both arrived
	messages = get_messages()
	assert len(messages) >= 2

	subjects = [m.get("Subject") for m in messages]
	assert "Dataset 100 - Processing Failed" in subjects
	assert "Dataset 200 - Processing Complete" in subjects
