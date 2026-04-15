import { useState } from "react";
import { Button } from "antd";
import UploadModal from "./UploadModal";
import { UploadOutlined } from "@ant-design/icons";
import { useDesktopOnlyFeature } from "../../hooks/useDesktopOnlyFeature";
import { useAnalytics } from "../../hooks/useAnalytics";

const UploadButton = () => {
  const [modals, setModals] = useState<{ key: string; isVisible: boolean }[]>([]);
  const { isMobile, runDesktopOnlyAction } = useDesktopOnlyFeature();
  const { track } = useAnalytics("profile");

  const showModal = () => {
    const newKey = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    setModals([...modals, { key: newKey, isVisible: true }]);
  };

  const handleClose = (key: string) => {
    setModals(modals.filter((modal) => modal.key !== key));
  };

  return (
    <>
      <Button
        size="large"
        icon={<UploadOutlined />}
        type="primary"
        onClick={() => {
          track("landing_cta_clicked", {
            cta_name: "profile_upload_data",
            action_target: "upload_modal",
            ...(isMobile ? { blocked_reason: "mobile" } : {}),
          });
          runDesktopOnlyAction("upload", showModal);
        }}
      >
        Upload Data
      </Button>
      {modals.map((modal) => (
        <UploadModal
          key={modal.key}
          isVisible={modal.isVisible}
          onClose={() => handleClose(modal.key)}
          uploadKey={modal.key}
        />
      ))}
    </>
  );
};

export default UploadButton;
