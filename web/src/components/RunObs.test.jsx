// Rule 27 on this lab's page: the shared panel under the Decision, Mock only (Real is reserved here).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RunObs, RUN_OBS_STREAMS } from "./PolicyGate";
import { setJsonView } from "./JsonPane.jsx";
import { mockRecord, realRecord } from "../run-observability/fixtures";

vi.mock("../api", () => ({ getRunObservability: vi.fn() }));
import { getRunObservability } from "../api";

const RUN = { decision: "PERMIT", hops: [] };
beforeEach(() => { vi.clearAllMocks(); setJsonView("form"); });

describe("RunObs", () => {
  it("shows the empty state before a run and does not ask the server", () => {
    render(<RunObs run={null} tick="0" mode="mock" />);
    expect(screen.getByTestId("ro-empty").textContent).toMatch(/Run the demo/);
    expect(getRunObservability).not.toHaveBeenCalled();
  });

  it("while the answer is pending it says so (no empty-state flash), and a no-record message is shown, not dropped", async () => {
    let release;
    getRunObservability.mockReturnValue(new Promise((r) => { release = r; }));
    render(<RunObs run={RUN} tick="0" mode="mock" />);
    expect(screen.getByTestId("ro-loading")).toBeTruthy();
    expect(screen.queryByTestId("ro-empty")).toBeNull();
    release({ record: null, message: "No run yet in this workspace: run the demo." });
    await waitFor(() => expect(screen.getByTestId("ro-none").textContent).toMatch(/No run yet in this workspace/));
    expect(screen.queryByTestId("ro-empty")).toBeNull();
  });

  it("keeps the previous record on screen while a refresh is pending", async () => {
    getRunObservability.mockResolvedValue({ record: mockRecord });
    const { rerender } = render(<RunObs run={RUN} tick="0" mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    getRunObservability.mockReturnValue(new Promise(() => {}));
    rerender(<RunObs run={{ ...RUN }} tick="1" mode="mock" />);
    expect(screen.getByTestId("ro-table")).toBeTruthy();
    expect(screen.queryByTestId("ro-loading")).toBeNull();
  });

  it("after a run: the mock record, every row simulated, the Mock wording, and where this lab's logs live", async () => {
    getRunObservability.mockResolvedValue({ record: mockRecord });
    render(<RunObs run={RUN} tick="0" mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    expect(screen.getByTestId("ro-basis").textContent).toMatch(/^Simulated/);
    expect(screen.queryAllByText("logged").length).toBe(1); // only the legend entry: no row is tagged logged
    expect(document.querySelectorAll('[data-origin="simulated"].ro-chip').length).toBeGreaterThan(1);
    expect(document.querySelector('tr[data-origin="logged"]')).toBeNull();
    expect(screen.getByTestId("ro-streams").textContent).toMatch(/demo-logs-a2a-lab/);
    expect(RUN_OBS_STREAMS.length).toBeGreaterThan(0);
  });

  it("long names stay inside the panel as text (no markup)", async () => {
    const LONG = "long-specialist-name-".repeat(12);
    const long = { ...mockRecord, rows: mockRecord.rows.map((r, i) => (i === 0 ? { ...r, message: `RFC 8693 exchange #2 for ${LONG} <img src=x onerror=alert(1)>`, detail: { actor: LONG } } : r)) };
    getRunObservability.mockResolvedValue({ record: long });
    const { container } = render(<RunObs run={RUN} tick="0" mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    expect(container.querySelector("img, script")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("a record the server built in the other mode is refused on screen, not shown under the Mock label", async () => {
    getRunObservability.mockResolvedValue({ record: realRecord });
    render(<RunObs run={RUN} tick="0" mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-mismatch")).toBeTruthy());
    expect(screen.queryByTestId("ro-table")).toBeNull();
  });

  it("a structured server error (Rule 23) and a network failure are shown, never blank", async () => {
    getRunObservability.mockResolvedValue({ error: "internal_error", message: "The run observability record could not be built." });
    const { unmount } = render(<RunObs run={RUN} tick="0" mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-error").textContent).toMatch(/could not be built/));
    unmount();
    getRunObservability.mockRejectedValue(new Error("down"));
    render(<RunObs run={RUN} tick="1" mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-error").textContent).toMatch(/Could not reach the server/));
  });

  it("Real (reserved): says it is not offered and never asks for or fakes a record", () => {
    render(<RunObs run={RUN} tick="0" mode="real" />);
    expect(screen.getByTestId("ro-real-not-offered").textContent).toMatch(/Not offered in Real mode/);
    expect(screen.queryByTestId("ro-table")).toBeNull();
    expect(getRunObservability).not.toHaveBeenCalled();
  });

  it("switching Mock -> Real -> Mock works both ways", async () => {
    getRunObservability.mockResolvedValue({ record: mockRecord });
    const { rerender } = render(<RunObs run={RUN} tick="0" mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
    rerender(<RunObs run={RUN} tick="0" mode="real" />);
    expect(screen.getByTestId("ro-real-not-offered")).toBeTruthy();
    rerender(<RunObs run={RUN} tick="0" mode="mock" />);
    await waitFor(() => expect(screen.getByTestId("ro-table")).toBeTruthy());
  });
});
