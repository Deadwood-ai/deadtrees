from html import escape


ACCOUNT_URL = 'https://deadtrees.earth/profile'


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
		'The DeadTrees team has recorded the failure. You can retry processing from your account.\n\n'
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
			<p style="color: #333;">The DeadTrees team has recorded the failure. You can retry processing from your account.</p>
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
	dataset_url = f'https://deadtrees.earth/dataset/{dataset_id}'
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
