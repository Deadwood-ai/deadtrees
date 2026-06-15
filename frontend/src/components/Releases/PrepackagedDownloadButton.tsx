import { DownloadOutlined } from "@ant-design/icons";
import { Button, message, type ButtonProps } from "antd";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../../hooks/useAuthProvider";
import { useCreatePrepackagedDownloadGrant } from "../../hooks/usePrepackagedDatasets";

interface PrepackagedDownloadButtonProps {
  versionId: number | null | undefined;
  returnTo: string;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
  icon?: ReactNode;
  size?: ButtonProps["size"];
  type?: ButtonProps["type"];
}

export function PrepackagedDownloadButton({
  versionId,
  returnTo,
  children = "Download ZIP",
  className,
  disabled = false,
  icon = <DownloadOutlined />,
  size = "large",
  type = "primary",
}: PrepackagedDownloadButtonProps) {
  const navigate = useNavigate();
  const [messageApi, contextHolder] = message.useMessage();
  const { session } = useAuth();
  const token = session?.access_token;
  const grantMutation = useCreatePrepackagedDownloadGrant();

  const handleDownload = async () => {
    if (!versionId) {
      void messageApi.warning("This package is not available yet.");
      return;
    }

    if (!token) {
      navigate(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`);
      return;
    }

    try {
      const grant = await grantMutation.mutateAsync({ versionId, token });
      window.location.assign(grant.download_url);
    } catch (downloadError) {
      const errorMessage =
        downloadError instanceof Error
          ? downloadError.message
          : "Could not start the package download.";
      void messageApi.error(errorMessage);
    }
  };

  return (
    <>
      {contextHolder}
      <Button
        type={type}
        size={size}
        icon={icon}
        loading={grantMutation.isPending}
        onClick={handleDownload}
        disabled={disabled || !versionId}
        className={className}
      >
        {token ? children : "Sign in to download"}
      </Button>
    </>
  );
}
