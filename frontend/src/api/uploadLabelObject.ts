import { Settings } from "../config";
// import { ILabelObject } from "../types/dataset";

const uploadLabelObject = async (labelObject: FormData, token: string) => {
  try {
    const res = await fetch(`${Settings.API_URL}/datasets/${labelObject.get("dataset_id")}/user-labels`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        // Don't set Content-Type here, it will be automatically set with the correct boundary
      },
      body: labelObject,
    });

    if (!res.ok) {
      throw new Error(`HTTP error! Status: ${res.status}`);
    }

    const data = await res.json();
    return data;
  } catch (error) {
    console.error("Upload label object error:", error);
    throw error;
  }
};

export default uploadLabelObject;
