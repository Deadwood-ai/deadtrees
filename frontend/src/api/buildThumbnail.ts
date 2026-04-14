import { Settings } from "../config";

const buildThumbnail = async (dataset_id: number, token: string) => {
  try {
    const res = await fetch(
      `${Settings.API_URL}/datasets/${dataset_id}/build-thumbnail`,
      // `https://cors-anywhere.herokuapp.com/${Settings.API_URL}/datasets/${dataset_id}/build-thumbnail`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json", // Specify that the content type is JSON
        },
        // body: 
      },
    );

    if (!res.ok) {
      throw new Error(`HTTP error! Status: ${res.status}`);
    }

    const data = await res.json(); // Parse the response body as JSON
    console.debug("Build-thumbnail response data:", data);
    return data;
  } catch (error) {
    console.error("Build-thumbnail error:", error);
    throw error;
  }
};

export default buildThumbnail;