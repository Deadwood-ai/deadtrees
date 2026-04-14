import { Settings } from "../config";

const buildCog = async (dataset_id: number, token: string) => {
  try {
    const res = await fetch(
      `${Settings.API_URL}/datasets/${dataset_id}/build-cog`,
      // `${Settings.API_URL}/datasets/${dataset_id}/force-cog-build`, // only for testing without queue
      // `https://cors-anywhere.herokuapp.com/${Settings.API_URL}/datasets/${dataset_id}/build-cog`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json", // Specify that the content type is JSON
        },
        body: JSON.stringify({}),
      },
    );
    if (!res.ok) {
      throw new Error(`HTTP error! Status: ${res.status}`);
    }

    const data = await res.json(); // Parse the response body as JSON
    // console.log("Build-cog response data:", data);
    return data;
  } catch (error) {
    console.error("Build-cog error:", error);
    throw error;
  }
};

export default buildCog;
