from html import escape


SITE_URL = 'https://deadtrees.earth'
ACCOUNT_URL = f'{SITE_URL}/profile'
LOGO_URL = f'{SITE_URL}/assets/logo.png'


def dataset_failed_email(
	dataset_id: int,
	file_name: str,
	error_message: str | None = None,
) -> tuple[str, str, str]:
	"""Return a user-safe failure email without exposing processor internals."""
	safe_file_name = escape(file_name)
	subject = f'Dataset {dataset_id} - Processing Failed'
	text_body = (
		f'Processing failed for dataset {dataset_id} ({file_name}).\n\n'
		'The DeadTrees team has recorded the failure. Open your dataset status for details and available results.'
		f'\n\nView dataset status: {ACCOUNT_URL}?dataset={dataset_id}'
		'\n\nFor help, contact info@deadtrees.earth.\n\n'
		f'Manage processing emails: {ACCOUNT_URL}'
	)
	html_body = f"""
	<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
		<div style="background: #1a1a2e; padding: 20px; border-radius: 8px 8px 0 0;">
			<h1 style="color: #e74c3c; margin: 0; font-size: 20px;">Processing Failed</h1>
		</div>
		<div style="background: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; border-top: none; border-radius: 0 0 8px 8px;">
			<p style="color: #333; margin-top: 0;">Your dataset could not be processed successfully.</p>
			<table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
				<tr>
					<td style="padding: 8px 12px; font-weight: bold; color: #666; width: 120px;">Dataset ID</td>
					<td style="padding: 8px 12px; color: #333;">{dataset_id}</td>
				</tr>
				<tr>
					<td style="padding: 8px 12px; font-weight: bold; color: #666;">File Name</td>
					<td style="padding: 8px 12px; color: #333;">{safe_file_name}</td>
				</tr>
			</table>
			<p style="color: #333;">The DeadTrees team has recorded the failure. Open your dataset status for details and available results.</p>
			<p><a href="{ACCOUNT_URL}?dataset={dataset_id}">View dataset status</a></p>
			<p style="color: #666; font-size: 13px;">
				If the problem persists, contact
				<a href="mailto:info@deadtrees.earth" style="color: #2980b9;">info@deadtrees.earth</a>.
			</p>
		</div>
		<p style="color: #999; font-size: 11px; text-align: center; margin-top: 16px;">
			DeadTrees &mdash; <a href="{ACCOUNT_URL}" style="color: #777;">Manage processing emails</a>
		</p>
	</div>
	"""
	return subject, text_body, html_body


def dataset_completed_email(dataset_id: int, file_name: str) -> tuple[str, str, str]:
	"""Return a completion email linking to the canonical dataset route."""
	safe_file_name = escape(file_name)
	dataset_url = f'{SITE_URL}/dataset/{dataset_id}'
	subject = f'Dataset {dataset_id} - Processing Complete'
	text_body = (
		f'Processing completed for dataset {dataset_id} ({file_name}).\n\n'
		f'View dataset: {dataset_url}\n\n'
		f'Manage processing emails: {ACCOUNT_URL}'
	)
	html_body = f"""
	<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
		<div style="background: #1a1a2e; padding: 20px; border-radius: 8px 8px 0 0;">
			<h1 style="color: #27ae60; margin: 0; font-size: 20px;">Processing Complete</h1>
		</div>
		<div style="background: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; border-top: none; border-radius: 0 0 8px 8px;">
			<p style="color: #333; margin-top: 0;">Your dataset has been successfully processed and is now available.</p>
			<table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
				<tr>
					<td style="padding: 8px 12px; font-weight: bold; color: #666; width: 120px;">Dataset ID</td>
					<td style="padding: 8px 12px; color: #333;">{dataset_id}</td>
				</tr>
				<tr>
					<td style="padding: 8px 12px; font-weight: bold; color: #666;">File Name</td>
					<td style="padding: 8px 12px; color: #333;">{safe_file_name}</td>
				</tr>
			</table>
			<div style="text-align: center; margin: 24px 0;">
				<a href="{dataset_url}"
				   style="background: #27ae60; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
					View Dataset
				</a>
			</div>
		</div>
		<p style="color: #999; font-size: 11px; text-align: center; margin-top: 16px;">
			DeadTrees &mdash; <a href="{ACCOUNT_URL}" style="color: #777;">Manage processing emails</a>
		</p>
	</div>
	"""
	return subject, text_body, html_body


def duplicates_archived_email(datasets: list[dict]) -> tuple[str, str, str]:
	"""Tell an owner which of their datasets were archived as copies of an existing upload.

	Each entry has `id`, `file_name` and `kept_dataset_id`, which is None when
	the owner may not see the dataset that was kept.
	"""
	subject = 'Duplicate datasets archived on deadtrees.earth'
	intro = (
		'We now detect files that were uploaded to deadtrees.earth more than once. '
		'The datasets below are copies of a file that is already on the platform, so we archived them. '
		'Nothing was deleted, and one dataset per file stays available.'
	)
	outro = 'If one of these should not have been archived, contact info@deadtrees.earth and we will restore it.'

	text_lines, html_rows = [], []
	for dataset in datasets:
		kept_dataset_id = dataset['kept_dataset_id']
		if kept_dataset_id is None:
			kept_text = kept_html = 'another upload of the same file'
		else:
			kept_url = f'https://deadtrees.earth/dataset/{kept_dataset_id}'
			kept_text = f'dataset {kept_dataset_id} ({kept_url})'
			kept_html = f'<a href="{kept_url}">dataset {kept_dataset_id}</a>'
		text_lines.append(f'- Dataset {dataset["id"]} ({dataset["file_name"]}): kept is {kept_text}')
		html_rows.append(f'<li>Dataset {dataset["id"]} ({escape(dataset["file_name"])}): kept is {kept_html}</li>')

	text_body = f'{intro}\n\n' + '\n'.join(text_lines) + f'\n\n{outro}\n\nManage processing emails: {ACCOUNT_URL}'
	html_body = f"""
	<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
		<div style="background: #1a1a2e; padding: 20px; border-radius: 8px 8px 0 0;">
			<h1 style="color: #ffffff; margin: 0; font-size: 20px;">Duplicate datasets archived</h1>
		</div>
		<div style="background: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; border-top: none; border-radius: 0 0 8px 8px;">
			<p style="color: #333; margin-top: 0;">{intro}</p>
			<ul style="color: #333;">{''.join(html_rows)}</ul>
			<p style="color: #666; font-size: 13px;">
				If one of these should not have been archived, contact
				<a href="mailto:info@deadtrees.earth" style="color: #2980b9;">info@deadtrees.earth</a>
				and we will restore it.
			</p>
		</div>
		<p style="color: #999; font-size: 11px; text-align: center; margin-top: 16px;">
			DeadTrees &mdash; <a href="{ACCOUNT_URL}" style="color: #777;">Manage processing emails</a>
		</p>
	</div>
	"""
	return subject, text_body, html_body


def _account_email(heading: str, intro: str, button: str, url: str) -> str:
	"""Branded HTML for account emails: logo, one message, one button and the plain link."""
	safe_url = escape(url, quote=True)
	return f"""
	<div style="background: #f4f6f5; padding: 32px 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
		<div style="max-width: 480px; margin: 0 auto;">
			<div style="text-align: center; margin-bottom: 20px;">
				<a href="{SITE_URL}" style="text-decoration: none;">
					<img src="{LOGO_URL}" alt="deadtrees.earth" width="180" height="36" style="border: 0; display: inline-block;">
				</a>
			</div>
			<div style="background: #ffffff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 32px 28px;">
				<h1 style="margin: 0 0 12px; font-size: 22px; font-weight: 600; color: #111827;">{escape(heading)}</h1>
				<p style="margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: #374151;">{escape(intro)}</p>
				<div style="text-align: center; margin: 0 0 24px;">
					<a href="{safe_url}" style="display: inline-block; background: #1B5E35; color: #ffffff; padding: 12px 28px; border-radius: 8px; font-size: 15px; font-weight: 600; text-decoration: none;">{escape(button)}</a>
				</div>
				<p style="margin: 0 0 6px; font-size: 13px; color: #6b7280;">If the button does not work, copy this link into your browser:</p>
				<p style="margin: 0; font-size: 12px; line-height: 1.5; word-break: break-all;"><a href="{safe_url}" style="color: #1B5E35;">{safe_url}</a></p>
			</div>
			<p style="margin: 20px 0 0; text-align: center; font-size: 12px; line-height: 1.5; color: #9ca3af;">
				You received this email because someone signed up at deadtrees.earth with this address.<br>
				If that was not you, you can ignore it.
			</p>
		</div>
	</div>
	"""


def _account_text(intro: str, url: str) -> str:
	return f'{intro}\n\n{url}\n\nIf you did not sign up at deadtrees.earth, you can ignore this email.'


def confirm_signup_email(confirm_url: str) -> tuple[str, str, str]:
	"""Return the sign-up confirmation email with the one-time link Supabase generated."""
	intro = 'Welcome to DeadTrees. Confirm your email address to finish creating your account.'
	return (
		'Confirm your DeadTrees account',
		_account_text(intro, confirm_url),
		_account_email('Confirm your email address', intro, 'Confirm email address', confirm_url),
	)


def finish_signup_email(set_password_url: str) -> tuple[str, str, str]:
	"""Return the confirmation email for an address whose account exists but was never confirmed.

	Its earlier password may have been chosen by someone else, so the owner of the
	inbox chooses the password through this link. To the reader it is simply the
	confirmation step, so it reads like the normal sign-up email.
	"""
	intro = 'Welcome to DeadTrees. Confirm your email address and choose your password to finish creating your account.'
	return (
		'Confirm your DeadTrees account',
		_account_text(intro, set_password_url),
		_account_email('Confirm your email address', intro, 'Confirm and choose password', set_password_url),
	)
