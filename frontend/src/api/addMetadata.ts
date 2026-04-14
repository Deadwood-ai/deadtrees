import { Settings } from "../config";

const addMetadata = async (dataset_id: number, metadata: any, token: string) => {
  try {
    const res = await fetch(
      `${Settings.API_URL}/datasets/${dataset_id}/metadata`,
      // `https://cors-anywhere.herokuapp.com/${Settings.API_URL}/datasets/${dataset_id}/metadata`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(metadata),
      },
    );

    if (!res.ok) {
      throw new Error(`HTTP error! Status: ${res.status}`);
    }

    const data = await res.json();
    // console.log("Add-metadata response data:", data);
    return data;
  } catch (error) {
    console.error("Add-metadata error:", error);
    throw error;
  }
};

export default addMetadata;
