import { MailOutlined } from "@ant-design/icons";
import { Switch, Typography } from "antd";

import { useProcessingEmailPreference } from "../hooks/useProcessingEmailPreference";

interface ProcessingEmailPreferenceProps {
  userId?: string;
}

export default function ProcessingEmailPreference({
  userId,
}: ProcessingEmailPreferenceProps) {
  const { enabled, error, isLoading, isSaving, setEnabled } =
    useProcessingEmailPreference(userId);

  return (
    <section
      aria-labelledby="processing-email-preference-title"
      className="flex items-center gap-3"
    >
      <MailOutlined className="text-base text-gray-500" aria-hidden />
      <div className="min-w-0">
        <Typography.Text
          id="processing-email-preference-title"
          className="block text-sm font-medium text-gray-900"
        >
          Processing emails
        </Typography.Text>
        <Typography.Text type={error ? "danger" : "secondary"} className="block text-xs">
          {error
            ? "Your preference could not be loaded or saved."
            : "Email me when processing finishes or fails."}
        </Typography.Text>
      </div>
      <Switch
        aria-label="Processing emails"
        checked={enabled}
        disabled={!userId || !!error}
        loading={isLoading || isSaving}
        onChange={(checked) => setEnabled(checked)}
      />
    </section>
  );
}
