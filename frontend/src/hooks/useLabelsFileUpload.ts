import { useState } from "react";
import type { UploadFile } from "antd";

const useLabelsFileUpload = () => {
  const [labelsFileList, setLabelsFileList] = useState<UploadFile[]>([]);
  const onLabelsFileChange = ({ fileList: newFileList }) => {
    setLabelsFileList(newFileList.slice(-1));
  };

  const beforeLabelsUpload = (file) => {
    setLabelsFileList([file]);
    return false;
  };

  return { labelsFileList, onLabelsFileChange, beforeLabelsUpload };
};

export default useLabelsFileUpload;
