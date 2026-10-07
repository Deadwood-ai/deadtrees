import { Button } from "antd";
import { Link } from "react-router-dom";

import StatusPage from "../components/StatusPage";

export default function NotFound() {
  return (
    <StatusPage
      kind="not-found"
      title="Page not found"
      description="This link doesn’t lead anywhere on DeadTrees. It may be mistyped or the page may have moved."
      actions={
        <>
          <Link to="/">
            <Button type="primary">Go to home</Button>
          </Link>
          <Link to="/dataset">
            <Button>Browse the drone archive</Button>
          </Link>
        </>
      }
    />
  );
}
