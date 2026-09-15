import { Component, type ReactNode } from "react";
import { Button, Result } from "antd";

// A route chunk can disappear during deployment or fail on a weak connection.
// Keep navigation available and let the user reload the current app version.
export default class RouteErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <Result
          status="warning"
          title="This page couldn’t load"
          subTitle="Check your connection and reload to try again."
          extra={
            <Button type="primary" onClick={() => window.location.reload()}>
              Reload page
            </Button>
          }
        />
      );
    }
    return this.props.children;
  }
}
