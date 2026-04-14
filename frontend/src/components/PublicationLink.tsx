import { Button, Tag, Tooltip } from "antd";
import { LinkOutlined } from "@ant-design/icons";

interface PublicationLinkProps {
  freidataDoI?: string | null;
  citationDoi?: string | null;
}

function PublicationLink({ freidataDoI, citationDoi }: PublicationLinkProps) {
  // FreiDATA DOI takes priority
  if (freidataDoI) {
    return (
      <Tooltip title={`View publication: ${freidataDoI}`}>
        <Button
          type="link"
          size="small"
          className="m-0 p-0"
          href={`https://doi.org/${freidataDoI}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <img
            src={`https://freidata.uni-freiburg.de/badge/DOI/${freidataDoI}.svg`}
            alt="FreiDATA DOI"
            style={{ maxWidth: "100%", height: "auto" }}
          />
        </Button>
      </Tooltip>
    );
  }

  // Citation DOI handling
  if (citationDoi) {
    const isZenodoDoi = citationDoi.toLowerCase().includes("zenodo");
    const href = citationDoi.startsWith("http") ? citationDoi : `https://doi.org/${citationDoi}`;

    if (isZenodoDoi) {
      // Extract DOI for badge URL (remove https://doi.org/ prefix if present)
      const doiForBadge = citationDoi.replace(/^https?:\/\/(dx\.)?doi\.org\//, "");

      return (
        <Tooltip title={`View publication: ${citationDoi}`}>
          <Button type="link" size="small" className="m-0 p-0" href={href} target="_blank" rel="noopener noreferrer">
            <img
              src={`https://zenodo.org/badge/DOI/${doiForBadge}.svg`}
              alt="Zenodo DOI"
              style={{ maxWidth: "100%", height: "auto" }}
            />
          </Button>
        </Tooltip>
      );
    }

    // Generic URL/DOI with link icon
    return (
      <Tooltip title={`View publication: ${citationDoi}`}>
        <Button type="link" size="small" icon={<LinkOutlined />} href={href} target="_blank" rel="noopener noreferrer">
          View Publication
        </Button>
      </Tooltip>
    );
  }

  // No publication available
  return <Tag color="default" style={{ margin: 0 }}>Not published</Tag>;
}

export default PublicationLink;
