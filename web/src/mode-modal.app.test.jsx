// The Real-or-mock modal replaced the simulation banner. Each state the old banner had (local, hosted, unknown) and Real have their own line;
// the banner element is gone; "Got it" closes the modal for the rest of the session; Real appears after /api/info answers even if MOCK was shown first.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let info; let scenarios;
vi.mock("./api", () => ({
  getJson: vi.fn((url) => (url.startsWith("/api/info") ? info() : scenarios())),
  resetWorkspace: vi.fn(), setMode: vi.fn(),
}));
vi.mock("./components/PolicyGate", () => ({ default: () => null }));
vi.mock("./components/DiagramTab", () => ({ default: () => null }));
import App, { MODE_LINES } from "./App";

const STORY = (extra = {}) => ({ banner: "SERVER SENT", intro: "i", verticals: ["retail"], scenarios: [], talkTrack: [], ...extra });
beforeEach(() => { sessionStorage.clear(); info = async () => ({ mode: "mock", realAvailable: false, hosted: false }); scenarios = async () => STORY({ hosted: false }); });
afterEach(() => { cleanup(); sessionStorage.clear(); });

describe("Real-or-mock modal", () => {
  it("opens on MOCK with the local line, has no banner, and closes on Got it for the rest of the session", async () => {
    const { unmount } = render(<App />);
    const modal = await screen.findByTestId("mode-modal");
    await waitFor(() => expect(screen.getByTestId("mode-modal").textContent).toContain(MODE_LINES.mock));
    expect(modal.dataset.mode).toBe("mock");
    expect(modal.textContent).toMatch(/MOCK/);
    expect(modal.textContent).toMatch(/Nothing here calls a real gateway, identity provider or tenant/);
    expect(screen.queryByTestId("banner")).toBeNull();
    expect(document.querySelector(".banner")).toBeNull();
    expect(screen.queryByText(/SERVER SENT/)).toBeNull();
    fireEvent.click(screen.getByTestId("mode-modal-ok"));
    expect(screen.queryByTestId("mode-modal")).toBeNull();
    unmount();
    render(<App />);
    await screen.findByTestId("top-menu");
    expect(screen.queryByTestId("mode-modal")).toBeNull();
  });

  it("says HOSTED simulation on the hosted build, still MOCK", async () => {
    info = async () => ({ mode: "mock", realAvailable: false, hosted: true });
    scenarios = async () => STORY({ hosted: true });
    render(<App />);
    await waitFor(() => expect(screen.getByTestId("mode-modal").textContent).toContain(MODE_LINES.hosted));
    expect(screen.getByTestId("mode-modal").dataset.mode).toBe("mock");
    expect(screen.getByTestId("mode-modal").textContent).toMatch(/Hosted simulation/);
  });

  it("never claims 'not hosted' before it knows: with /api/info and /api/scenarios down it says both", async () => {
    info = async () => { throw new Error("down"); };
    scenarios = async () => { throw new Error("down"); };
    render(<App />);
    await screen.findByRole("alert");
    const modal = screen.getByTestId("mode-modal");
    expect(modal.textContent).toContain(MODE_LINES.unknown);
    expect(modal.textContent).toMatch(/possibly a hosted simulation/);
    expect(modal.dataset.mode).toBe("mock");
  });

  it("shows MOCK first, then REAL when /api/info answers Real, and the REAL line says Real is reserved and still simulated", async () => {
    let release;
    info = () => new Promise((r) => { release = () => r({ mode: "real", realAvailable: true, hosted: false }); });
    render(<App />);
    expect((await screen.findByTestId("mode-modal")).dataset.mode).toBe("mock");
    release();
    await waitFor(() => expect(screen.getByTestId("mode-modal").dataset.mode).toBe("real"));
    expect(screen.getByTestId("mode-modal").textContent).toMatch(/REAL/);
    expect(screen.getByTestId("mode-modal").textContent).toContain(MODE_LINES.real);
    expect(screen.getByTestId("mode-modal").textContent).toMatch(/reserved/);
  });

  it("a dismissed MOCK does not hide REAL", async () => {
    let release;
    info = () => new Promise((r) => { release = () => r({ mode: "real", realAvailable: true, hosted: false }); });
    render(<App />);
    fireEvent.click(await screen.findByTestId("mode-modal-ok"));
    expect(screen.queryByTestId("mode-modal")).toBeNull();
    release();
    await waitFor(() => expect(screen.getByTestId("mode-modal").dataset.mode).toBe("real"));
  });
});
