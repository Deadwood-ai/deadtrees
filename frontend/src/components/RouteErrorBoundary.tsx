import { Component, type ReactNode } from "react";
import { Button } from "antd";
import { Link } from "react-router-dom";

import StatusPage from "./StatusPage";
import { isStaleBuildError, reloadForNewBuild } from "../utils/staleBuild";

// A route chunk disappears when a new version is deployed, and a page can also
// crash on its own. Either way keep navigation available: stale chunks reload
// into the new version once, everything else gets a reload and a way home.
export default class RouteErrorBoundary extends Component<
  { children: ReactNode },
  { error: unknown; reloading: boolean }
> {
  state = { error: null as unknown, reloading: false };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    if (isStaleBuildError(error) && reloadForNewBuild()) {
      this.setState({ reloading: true });
      return;
    }
    console.error("Route failed to render", error);
  }

  render() {
    const { error, reloading } = this.state;
    if (!error) return this.props.children;
    if (reloading) return null;

    const actions = (
      <>
        <Button type="primary" onClick={() => window.location.reload()}>
          Reload page
        </Button>
        <Link to="/">
          <Button>Go to home</Button>
        </Link>
      </>
    );

    if (isStaleBuildError(error)) {
      return (
        <StatusPage
          kind="updated"
          title="DeadTrees was just updated"
          description="This page belongs to the previous version. Reload to open the new one. If it still doesn’t load, check your connection."
          actions={actions}
        />
      );
    }

    return (
      <StatusPage
        kind="error"
        title="Something went wrong on this page"
        description="Reloading usually fixes it. If it keeps happening, tell us at info@deadtrees.earth with the link to this page."
        actions={actions}
      />
    );
  }
}
