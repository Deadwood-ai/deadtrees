import { Link } from "react-router-dom";

/** What DeadTrees accepts, shared by the getting-started strip and the upload help popover. */
export default function UploadRequirements() {
  return (
    <ul className="m-0 space-y-1 p-0 text-sm text-slate-600" style={{ listStyleType: "none" }}>
      <li>
        <span className="font-medium text-slate-800">Formats:</span> a GeoTIFF orthomosaic (max 20 GB) or a ZIP of raw
        JPEG drone images (max 30 GB).
      </li>
      <li>
        <span className="font-medium text-slate-800">Raw images:</span> follow the{" "}
        <Link to="/releases/drone-mapping-guide" className="font-semibold underline">
          drone mapping guide
        </Link>{" "}
        so we can build the orthomosaic.
      </li>
      <li>
        <span className="font-medium text-slate-800">Imagery:</span> RGB or NIR-RGB, finer than 10 cm, any coordinate
        reference system.
      </li>
    </ul>
  );
}
