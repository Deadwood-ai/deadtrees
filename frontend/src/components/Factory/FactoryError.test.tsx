// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../../hooks/useFactory", () => ({
  isFactoryPermissionError: (error: unknown) => (error as Error)?.message === "operator permission required",
}));

import { FactoryError } from "./FactoryPrimitives";

afterEach(cleanup);

describe("Factory load errors", () => {
  it("show the reason and one retry in the shared section style", () => {
    const onRetry = vi.fn();
    render(<FactoryError error={new Error("statement timeout")} onRetry={onRetry} title="Processors couldn’t load" />);
    expect(screen.getByRole("heading", { name: "Processors couldn’t load" })).toBeTruthy();
    expect(screen.getByText("statement timeout")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("turn a permission error into the operator denial", () => {
    render(
      <MemoryRouter>
        <FactoryError error={new Error("operator permission required")} onRetry={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Operator access required")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
