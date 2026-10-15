// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import BenchmarkAccess from "./BenchmarkAccess";
import BenchmarkFeedback from "./BenchmarkFeedback";
import type { IBenchmarkSite } from "./types";

const auth = vi.hoisted(() => ({
  session: { user: { id: "test-user" }, access_token: "test-session" } as {
    user: { id: string };
    access_token: string;
  } | null,
  loading: false,
}));
vi.mock("../../hooks/useAuthProvider", () => ({ useAuth: () => auth }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  auth.session = { user: { id: "test-user" }, access_token: "test-session" };
});

function accessPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BenchmarkAccess>
        <p>Protected viewer</p>
      </BenchmarkAccess>
    </QueryClientProvider>,
  );
}
describe("Internal benchmark access", () => {
  it("does not mount or request the viewer for anonymous users", () => {
    auth.session = null;
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    accessPage();
    expect(screen.queryByText("Protected viewer")).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([403, 404, 500])(
    "fails closed when the server returns %s",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("Denied", { status })),
      );
      accessPage();
      await screen.findByText("Internal forest disturbance benchmark");
      expect(screen.queryByText("Protected viewer")).toBeNull();
    },
  );
  it("mounts the viewer only after explicit server authorization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ allowed: true })),
    );
    accessPage();
    await screen.findByText("Protected viewer");
  });
});

describe("Internal benchmark feedback", () => {
  const site = { id: "Fire_Peru_2024" } as IBenchmarkSite;
  it("submits only site and comment, confirming the server's acceptance", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ accepted: true }, { status: 202 }));
    vi.stubGlobal("fetch", fetcher);
    render(<BenchmarkFeedback site={site} />);
    fireEvent.click(screen.getByText("Give feedback on this reference site"));
    fireEvent.change(screen.getByLabelText("Your comment"), {
      target: { value: " Check this reference " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
    await screen.findByRole("status");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      siteId: site.id,
      comment: "Check this reference",
    });
    expect(
      (screen.getByLabelText("Your comment") as HTMLTextAreaElement).value,
    ).toBe("");
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });
  it("retains the comment after an unavailable endpoint and never claims success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Missing", { status: 404 })),
    );
    render(<BenchmarkFeedback site={site} />);
    fireEvent.click(screen.getByText("Give feedback on this reference site"));
    fireEvent.change(screen.getByLabelText("Your comment"), {
      target: { value: "Keep this comment" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(
      (screen.getByLabelText("Your comment") as HTMLTextAreaElement).value,
    ).toBe("Keep this comment");
    expect(screen.queryByRole("status")).toBeNull();
  });
});
