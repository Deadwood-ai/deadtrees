// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

const { requestedTables } = vi.hoisted(() => ({ requestedTables: [] as string[] }));

vi.mock("./useAuthProvider", () => ({
  useAuth: () => ({ status: "anonymous", user: null, session: null }),
}));

vi.mock("./useSupabase", () => {
  const archiveItems = [
    { id: 2, authors: ["Grace  Hopper", "Ada Lovelace"] },
    { id: 1, authors: ["Ada Lovelace"] },
  ];
  const query = (table: string) => {
    const result = Promise.resolve({ data: table === "public_dataset_archive_items" ? archiveItems : [], error: null });
    const builder = {
      select: () => builder,
      order: () => builder,
      eq: () => builder,
      then: result.then.bind(result),
    };
    return builder;
  };
  return {
    supabase: {
      from: (table: string) => {
        requestedTables.push(table);
        return query(table);
      },
    },
  };
});

import DataProvider, { useData } from "./useDataProvider";

function AuthorNames() {
  const { authors } = useData();
  return <p>{authors ? authors.map((author) => author.value).join(", ") : "loading"}</p>;
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <DataProvider>
          <AuthorNames />
        </DataProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  requestedTables.length = 0;
});

describe("DataProvider", () => {
  it.each(["/about", "/profile", "/dataset"])("loads authors on %s without the full public dataset view", async (path) => {
    renderAt(path);

    expect(await screen.findByText("Ada Lovelace, Grace Hopper")).toBeTruthy();
    expect(requestedTables).toEqual(["public_dataset_archive_items"]);
  });

  it("requests nothing on other pages", async () => {
    renderAt("/");

    expect(screen.getByText("loading")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(requestedTables).toEqual([]);
  });
});
