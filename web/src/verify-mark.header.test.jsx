// The header shows this lab's own Verified / In progress mark, read from the demo shelf's /api/shelf (through the lab-proxy that call reaches the
// shelf, whose payload lists every demo with its mark). The lab's own /api/shelf has no demos, so there is no mark then.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

vi.mock("./api", () => ({
  getJson: vi.fn(async (url) => (url.startsWith("/api/info") ? { mode: "mock", realAvailable: false, hosted: false } : { banner: "SIMULATED", intro: "i", verticals: ["retail"], scenarios: [], talkTrack: [] })),
  resetWorkspace: vi.fn(), setMode: vi.fn(),
}));
vi.mock("./components/PolicyGate", () => ({ default: () => null }));
vi.mock("./components/DiagramTab", () => ({ default: () => null }));
import App from "./App";

const mark = (status, label, extra = {}) => ({ status, label, note: "", updatedAt: "2026-11-15", source: "shipped", ...extra });
const stubShelf = (payload) => vi.stubGlobal("fetch", vi.fn(async (url) => (String(url) === "/api/shelf" ? { ok: true, json: async () => payload } : { ok: false, json: async () => ({}) })));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); sessionStorage.clear(); });

describe("verification mark in the header", () => {
  it("shows this lab's own mark, and no other lab's", async () => {
    stubShelf({ shelfUrl: "http://shelf.example", demos: [{ id: "other-lab", verification: mark("in-progress", "In progress") }, { id: "a2a-lab", verification: mark("verified", "Verified", { note: "Every consent path run on the mock" }) }] });
    render(<App />);
    const bar = within(await screen.findByTestId("top-menu"));
    expect(await bar.findByText("Verified")).toBeInTheDocument();
    expect(bar.queryByText("In progress")).toBeNull();
    expect(bar.getByText("Verified").closest(".verify")).toHaveAttribute("title", expect.stringContaining("Every consent path run on the mock"));
  });

  it("shows nothing when the lab is opened on its own port (its /api/shelf has no demos), the shelf has no mark for it, or the shelf is down", async () => {
    for (const shelf of [{ shelfUrl: "http://shelf.example" }, { shelfUrl: "http://shelf.example", demos: [{ id: "a2a-lab", verification: null }] }, null]) {
      if (shelf) stubShelf(shelf); else vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
      const { unmount } = render(<App />);
      await screen.findByTestId("top-menu");
      await new Promise((r) => setTimeout(r, 30)); // let the shelf call settle
      expect(document.querySelector(".verify")).toBeNull();
      unmount();
    }
  });
});
