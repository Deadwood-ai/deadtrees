import { Settings } from "../config";

// interface IProcessCOG {
//   resolution: number;
//   profile: string;
//   quality: number;
//   force_recreate: boolean;
//   tiling_scheme: string;
// }

const addProcess = async (dataset_id: number, task_types: string[], token: string) => {
  const priority = 4;
  try {
    const res = await fetch(`${Settings.API_URL}/datasets/${dataset_id}/process`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ task_types, priority }),
    });

    if (!res.ok) {
      throw new Error(`HTTP error! Status: ${res.status}`);
    }

    const data = await res.json();
    // console.log("Add process response data:", data);
    return data;
  } catch (error) {
    console.error("Add process error:", error);
    throw error;
  }
};

export default addProcess;
