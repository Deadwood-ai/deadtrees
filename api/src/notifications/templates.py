"""
HTML email templates for dataset notifications.
"""


def dataset_failed_email(dataset_id: int, file_name: str, error_message: str) -> tuple[str, str]:
	"""
	Generate subject and HTML body for a dataset failure notification.

	Returns:
		(subject, html_body) tuple.
	"""
	subject = f"Dataset {dataset_id} - Processing Failed"

	html_body = f"""
	<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
		<div style="background: #1a1a2e; padding: 20px; border-radius: 8px 8px 0 0;">
			<h1 style="color: #e74c3c; margin: 0; font-size: 20px;">Processing Failed</h1>
		</div>
		<div style="background: #f8f9fa; padding: 20px; border: 1px solid #dee2e6; border-top: none; border-radius: 0 0 8px 8px;">
			<p style="color: #333; margin-top: 0;">Your dataset encountered an error during processing.</p>

			<table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
				<tr>
					<td style="padding: 8px 12px; font-weight: bold; color: #666; width: 120px;">Dataset ID</td>
					<td style="padding: 8px 12px; color: #333;">{dataset_id}</td>
				</tr>
				<tr>
					<td style="padding: 8px 12px; font-weight: bold; color: #666;">File Name</td>
					<td style="padding: 8px 12px; color: #333;">{file_name}</td>
				</tr>
				<tr>
					<td style="padding: 8px 12px; font-weight: bold; color: #666; vertical-align: top;">Error</td>
					<td style="padding: 8px 12px; color: #c0392b; font-family: monospace; font-size: 13px;">{error_message}</td>
				</tr>
			</table>

			<p style="color: #666; font-size: 13px;">
				If the problem persists, please contact us at
				<a href="mailto:info@deadtrees.earth" style="color: #2980b9;">info@deadtrees.earth</a>.
			</p>
		</div>
		<p style="color: #999; font-size: 11px; text-align: center; margin-top: 16px;">
			DeadTrees &mdash; <a href="https://deadtrees.earth" style="color: #999;">deadtrees.earth</a>
		</p>
	</div>
	"""

	return subject, html_body


def dataset_completed_email(dataset_id: int, file_name: str) -> tuple[str, str]:
	"""
	Generate subject and HTML body for a dataset completion notification.

	Returns:
		(subject, html_body) tuple.
	"""
	subject = f"Dataset {dataset_id} - Processing Complete"

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
					<td style="padding: 8px 12px; color: #333;">{file_name}</td>
				</tr>
			</table>

			<div style="text-align: center; margin: 24px 0;">
				<a href="https://deadtrees.earth/datasets/{dataset_id}"
				   style="background: #27ae60; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">
					View Dataset
				</a>
			</div>
		</div>
		<p style="color: #999; font-size: 11px; text-align: center; margin-top: 16px;">
			DeadTrees &mdash; <a href="https://deadtrees.earth" style="color: #999;">deadtrees.earth</a>
		</p>
	</div>
	"""

	return subject, html_body
