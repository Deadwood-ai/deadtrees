import {
  CopyOutlined,
  DownOutlined,
  DownloadOutlined,
} from "@ant-design/icons";
import {
  Button,
  Dropdown,
  Input,
  message,
  Modal,
  Space,
  type ButtonProps,
  type MenuProps,
} from "antd";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../../hooks/useAuthProvider";
import { useCreatePrepackagedDownloadGrant } from "../../hooks/usePrepackagedDatasets";

interface PrepackagedDownloadButtonProps {
  versionId: number | null | undefined;
  returnTo: string;
  fileName?: string | null;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  icon?: ReactNode;
  size?: ButtonProps["size"];
  type?: ButtonProps["type"];
}

type DownloadCopyMode = "wget" | "curl" | "url";

export function PrepackagedDownloadButton({
  versionId,
  returnTo,
  fileName,
  children = "Download ZIP",
  className,
  disabled = false,
  icon = <DownloadOutlined />,
  size = "large",
  type = "primary",
}: PrepackagedDownloadButtonProps) {
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();
  const [manualCopyText, setManualCopyText] = useState<string | null>(null);
  const [manualCopyTitle, setManualCopyTitle] = useState("Copy download command");
  const [manualCopyDescription, setManualCopyDescription] = useState(
    "Copy this command into your terminal.",
  );
  const { session } = useAuth();
  const token = session?.access_token;
  const grantMutation = useCreatePrepackagedDownloadGrant();

  const createGrant = async () => {
    if (!versionId) {
      void messageApi.warning("This package is not available yet.");
      return null;
    }

    if (!token) {
      navigate(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
      return null;
    }

    return grantMutation.mutateAsync({ versionId, token });
  };

  const handleDownload = async () => {
    try {
      const grant = await createGrant();
      if (!grant) return;

      window.location.assign(grant.download_url);
    } catch (downloadError) {
      const errorMessage =
        downloadError instanceof Error
          ? downloadError.message
          : "Could not start the package download.";
      void messageApi.error(errorMessage);
    }
  };

  const shellQuote = (value: string) => `'${value.replace(/'/g, "'\"'\"'")}'`;

  const getExpiryMessage = (expiresAt: string | null | undefined) => {
    if (!expiresAt) return "Signed link expires automatically.";

    const expiresAtDate = new Date(expiresAt);
    if (Number.isNaN(expiresAtDate.getTime())) {
      return "Signed link expires automatically.";
    }

    return `Signed link expires ${new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(expiresAtDate)}.`;
  };

  const buildDownloadText = (
    copyMode: DownloadCopyMode,
    downloadFileName: string,
    downloadUrl: string,
  ) =>
    copyMode === "wget"
      ? `wget -c -O ${shellQuote(downloadFileName)} ${shellQuote(downloadUrl)}`
      : copyMode === "curl"
        ? `curl --fail -L -C - -o ${shellQuote(downloadFileName)} ${shellQuote(downloadUrl)}`
        : downloadUrl;

  const copyDownloadText = async (copyMode: DownloadCopyMode, successPrefix: string) => {
    try {
      const grant = await createGrant();
      if (!grant) return;

      const downloadFileName = fileName || `prepackaged-dataset-${versionId}.zip`;
      const text = buildDownloadText(copyMode, downloadFileName, grant.download_url);
      const expiryMessage = getExpiryMessage(grant.expires_at);

      try {
        await navigator.clipboard.writeText(text);
        void messageApi.success(`${successPrefix} ${expiryMessage}`);
      } catch {
        setManualCopyTitle(
          copyMode === "url"
            ? "Copy signed URL"
            : `Copy ${copyMode === "wget" ? "wget" : "curl"} command`,
        );
        setManualCopyDescription(expiryMessage);
        setManualCopyText(text);
        void messageApi.warning(
          "Clipboard access was blocked. Copy from the dialog instead.",
        );
      }
    } catch (downloadError) {
      const errorMessage =
        downloadError instanceof Error
          ? downloadError.message
          : "Could not copy the download command.";
      void messageApi.error(errorMessage);
    }
  };

  const downloadCommandItems: MenuProps["items"] = [
    {
      key: "wget",
      icon: <CopyOutlined />,
      label: "Copy wget command",
      onClick: () => void copyDownloadText("wget", "wget command copied."),
    },
    {
      key: "curl",
      icon: <CopyOutlined />,
      label: "Copy curl command",
      onClick: () => void copyDownloadText("curl", "curl command copied."),
    },
    {
      key: "url",
      icon: <CopyOutlined />,
      label: "Copy signed URL",
      onClick: () => void copyDownloadText("url", "Signed URL copied."),
    },
  ];

  return (
    <>
      {contextHolder}
      <Space.Compact className={className}>
        <Button
          type={type}
          size={size}
          icon={icon}
          loading={grantMutation.isPending}
          onClick={handleDownload}
          disabled={disabled || !versionId}
        >
          {token ? children : "Sign in to download"}
        </Button>
        <Dropdown
          menu={{ items: downloadCommandItems }}
          trigger={["click"]}
          placement="bottomRight"
          disabled={disabled || !versionId || grantMutation.isPending}
        >
          <Button
            type={type}
            size={size}
            icon={<DownOutlined />}
            aria-label="More download options"
            disabled={disabled || !versionId}
            loading={grantMutation.isPending}
          />
        </Dropdown>
      </Space.Compact>
      <Modal
        title={manualCopyTitle}
        open={Boolean(manualCopyText)}
        footer={null}
        onCancel={() => setManualCopyText(null)}
      >
        <p>{manualCopyDescription}</p>
        <Input.TextArea
          value={manualCopyText ?? ""}
          readOnly
          autoSize={{ minRows: 3, maxRows: 8 }}
          onFocus={(event) => event.currentTarget.select()}
        />
      </Modal>
    </>
  );
}
