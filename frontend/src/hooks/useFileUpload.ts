import { useState } from "react";
import type { UploadFile } from "antd";

export const useFileUpload = () => {
  const [fileList, setFileList] = useState<UploadFile[]>([]);
  const [fileName, setFileName] = useState<string>("");
  const [fileNameFull, setFileNameFull] = useState<string>("");
  const onFileChange = ({ fileList: newFileList }) => {
    // console.log("newFileList", newFileList);
    setFileList(newFileList.slice(-1));
    if (newFileList.length > 0) {
      const name = newFileList[0].name;
      setFileNameFull(name);
      setFileName(name.length > 40 ? name.substring(0, 40) + "..." : name);
    } else {
      setFileName("");
      setFileNameFull("");
    }
  };

  const beforeUpload = (file) => {
    setFileList([file]);
    return false;
  };

  return {
    fileList,
    fileName,
    fileNameFull,
    onFileChange,
    beforeUpload,
  };
};
