import { Settings } from "../config";

const uploadFile = async (file: any, token: string) => {
  // console.log("file in uploadFile", file);
  const formData = new FormData();
  formData.append("file", file.originFileObj);

  try {
    const res = await fetch(
      `${Settings.API_URL}/datasets`,
      // "https://cors-anywhere.herokuapp.com/https://data.deadtrees.earth/api/v1/datasets",

      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          // accept: "application/json",
        },
        body: formData,
      },
    );
    // console.log("Upload dataset response:", res);

    if (!res.ok) {
      throw new Error(`HTTP error! Status: ${res.status}`);
    }

    const data = await res.json(); // Parse the response body as JSON
    // console.log("Upload dataset response data:", data);
    return data;
  } catch (error) {
    console.error("Upload dataset error:", error);
    throw error;
  }
};

export default uploadFile;
