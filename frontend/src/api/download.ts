import { Settings } from "../config";

const download = async (dataset_id, token) => {
  try {
    const response = await fetch(
      // `${Settings.API_URL}/download/datasets/${dataset_id}/dataset.zip`,
      `${Settings.API_URL}/download/datasets/${dataset_id}/dataset.zip`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    // console.log("Download URL:", url);
    const a = document.createElement("a");
    a.href = url;
    a.download = "dataset.zip"; // Set the filename for the download
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);

    // console.log("Download successful");
  } catch (error) {
    console.error("Download error:", error);
    throw error;
  }
};

export default download;
