import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PolicyGate, { Hops, Verdict } from "./PolicyGate";
import { setJsonView } from "./JsonPane.jsx";

vi.mock("../api", () => ({
  runTool: vi.fn(),
  getRegistry: vi.fn(async () => ({ specialists: ["portfolio-specialist", "wire-specialist"] })),
  setRegistration: vi.fn(async (p) => ({ ok: true, status: 200, body: { ...p, specialists: [] } })),
  exchangeOne: vi.fn(),
  exchangeTwo: vi.fn(),
  getAgentCard: vi.fn(async () => ({ name: "Generalist Banking Agent", skills: [{ id: "portfolio" }] })),
}));

import { runTool, exchangeOne, exchangeTwo } from "../api";

const STORY = {
  tokenLabel: "TOKEN-LABEL",
  tools: [{ name: "get_portfolio_summary", tier: "specialist", lesson: "" }],
  facts: [{ id: "f1", status: "measured", text: "a fact", source: "src" }],
  scenarios: [
    { id: "a2a-handoff", title: "UC2 handoff", user: "demoUser", generalist: "generalist-agent", specialist: "portfolio-specialist", scope: "a2a:get_portfolio_summary", expected: "PERMIT", lesson: "the lesson" },
    { id: "a2a-unregistered", title: "UC2.6 unregistered", user: "demoUser", generalist: "generalist-agent", specialist: "rogue-specialist", scope: "a2a:get_portfolio_summary", expected: "DENY", lesson: "denied" },
    { id: "a2a-plain-act", title: "plain act", user: "demoUser", generalist: "generalist-agent", specialist: null, scope: "a2a:get_portfolio_summary", expected: "DENY", lesson: "refused" },
    { id: "a2a-protocol", title: "protocol beat", user: "demoUser", generalist: "generalist-agent", specialist: "portfolio-specialist", scope: "a2a:get_portfolio_summary", protocolProbe: true, expected: "PERMIT", lesson: "401 first" },
  ],
};

beforeEach(() => { vi.clearAllMocks(); setJsonView("form"); });

describe("Verdict", () => {
  it("renders the empty state and the A2A stage wording", () => {
    render(<Verdict run={null} />);
    expect(screen.getByTestId("verdict-empty")).toBeTruthy();
    render(<Verdict run={{ decision: "PERMIT", stage: "policy", user: "u", act: { sub: "s", act: { sub: "g" } }, chainDepth: 2, scope: "a2a:get_portfolio_summary" }} />);
    expect(screen.getByTestId("verdict").textContent).toContain("fully attributable");
    expect(screen.getByTestId("who").textContent).toContain("s -> g");
    expect(screen.getByTestId("who").textContent).toContain("chain depth 2");
  });
});

describe("Hops", () => {
  it("renders each hop with its label", () => {
    render(<Hops hops={[{ n: 1, label: "one", request: "r", response: "s" }, { n: 2, label: "two", request: "r2", response: "s2" }]} traceId="abc" />);
    expect(screen.getByTestId("hops").textContent).toContain("one");
    expect(screen.getByTestId("hops").textContent).toContain("two");
  });
});

describe("PolicyGate", () => {
  it("runs the happy handoff: exchange #1, #2, then the gated call", async () => {
    const t1 = { sub: "demoUser", act: { sub: "generalist-agent" }, scope: "a2a:get_portfolio_summary" };
    const t2 = { sub: "demoUser", act: { sub: "portfolio-specialist", act: { sub: "generalist-agent" } }, scope: "a2a:get_portfolio_summary" };
    exchangeOne.mockResolvedValue({ ok: true, body: { token: t1 } });
    exchangeTwo.mockResolvedValue({ ok: true, body: { token: t2 } });
    runTool.mockResolvedValue({ ok: true, status: 200, body: { decision: "PERMIT", stage: "policy", user: "demoUser", act: t2.act, chainDepth: 2, scope: t2.scope, hops: [{ n: 1, label: "x", request: "r", response: "s" }], traceId: "t" } });
    const user = userEvent.setup();
    render(<PolicyGate story={STORY} resetSignal={0} requestedId={null} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("verdict").textContent).toContain("PERMITTED"));
    expect(exchangeOne).toHaveBeenCalledWith({ user: "demoUser", generalist: "generalist-agent", scope: "a2a:get_portfolio_summary" });
    expect(exchangeTwo).toHaveBeenCalledWith({ generalistToken: t1, specialist: "portfolio-specialist", scope: "a2a:get_portfolio_summary" });
    expect(runTool).toHaveBeenCalledWith({ token: t2, tool: "get_portfolio_summary" });
    await user.click(screen.getByTestId("ex2-run"));
  });

  it("UC2.6: shows the DENY reason for an unregistered specialist", async () => {
    const t1 = { sub: "demoUser", act: { sub: "generalist-agent" }, scope: "s" };
    const t2 = { sub: "demoUser", act: { sub: "rogue-specialist", act: { sub: "generalist-agent" } }, scope: "s" };
    exchangeOne.mockResolvedValue({ ok: true, body: { token: t1 } });
    exchangeTwo.mockResolvedValue({ ok: true, body: { token: t2 } });
    runTool.mockResolvedValue({ ok: false, status: 403, body: { decision: "DENY", stage: "policy", code: "unregistered_specialist", reason: "keys on WHO is acting", user: "demoUser", act: t2.act, chainDepth: 2, hops: [], traceId: "t" } });
    const user = userEvent.setup();
    render(<PolicyGate story={STORY} resetSignal={0} requestedId="a2a-unregistered" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("verdict").textContent).toContain("DENIED"));
    expect(screen.getByTestId("verdict").textContent).toContain("WHO is acting");
  });

  it("plain-act scenario explains the depth-1 refusal", async () => {
    exchangeOne.mockResolvedValue({ ok: true, body: { token: { sub: "demoUser", act: { sub: "g" }, scope: "s" } } });
    render(<PolicyGate story={STORY} resetSignal={0} requestedId="a2a-plain-act" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("verdict-empty")).toBeTruthy());
    expect(screen.getByText(/no handoff/i)).toBeTruthy();
  });

  it("protocol probe expects a 401 first, then runs the handoff", async () => {
    runTool.mockResolvedValueOnce({ ok: false, status: 401, body: { decision: "DENY", stage: "protocol", code: "missing_bearer", reason: "No bearer token: the A2A gateway answers 401 before anything else.", hops: [{ n: 1, label: "a", request: "r", response: "s" }, { n: 2, label: "b", request: "r", response: "s" }], traceId: "t" } });
    const t1 = { sub: "u", act: { sub: "g" }, scope: "s" };
    const t2 = { sub: "u", act: { sub: "s", act: { sub: "g" } }, scope: "s" };
    exchangeOne.mockResolvedValue({ ok: true, body: { token: t1 } });
    exchangeTwo.mockResolvedValue({ ok: true, body: { token: t2 } });
    runTool.mockResolvedValueOnce({ ok: true, status: 200, body: { decision: "PERMIT", stage: "policy", user: "u", act: t2.act, chainDepth: 2, hops: [], traceId: "t" } });
    render(<PolicyGate story={STORY} resetSignal={0} requestedId="a2a-protocol" onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("verdict").textContent).toContain("PERMITTED"));
    expect(runTool).toHaveBeenNthCalledWith(1, { tool: "get_portfolio_summary" });
    // the 401 hop data is rendered in the hops panel of the final permit run is separate; assert the call order instead
    expect(exchangeOne).toHaveBeenCalled();
  });

  it("registry board: register and revoke flip the live registry", async () => {
    const user = userEvent.setup();
    render(<PolicyGate story={STORY} resetSignal={0} requestedId={null} onSelect={() => {}} />);
    await screen.findByTestId("registry-board");
    await user.click(screen.getByTestId("reg-add"));
    await waitFor(() => expect(screen.getByTestId("reg-msg").textContent).toContain("registered"));
    await user.click(screen.getByTestId("reg-remove"));
    await waitFor(() => expect(screen.getByTestId("reg-msg").textContent).toContain("revoked"));
  });

  it("renders the Agent Card panel and the fact statuses", async () => {
    render(<PolicyGate story={STORY} resetSignal={0} requestedId={null} onSelect={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("agent-card").textContent).toContain("Generalist Banking Agent"));
    expect(screen.getByTestId("facts").textContent).toContain("measured");
  });

  it("Rule 24: the Agent Card and the scenario input go through JsonPane (Form | JSON), the lab's own keys are hot", async () => {
    const user = userEvent.setup();
    render(<PolicyGate story={STORY} resetSignal={0} requestedId={null} onSelect={() => {}} />);
    const card = await screen.findByTestId("agent-card");
    // Form view: a label and a value per field, the lab's hot keys marked.
    expect(card.className).toContain("json--form");
    const hotKeys = [...card.querySelectorAll('[data-hot="true"] > .jform__k')].map((n) => n.textContent);
    expect(hotKeys).toEqual(expect.arrayContaining(["name", "skills"]));
    const scen = screen.getByTestId("scenario-prefs");
    const scenHot = [...scen.querySelectorAll('[data-hot="true"] > .jform__k')].map((n) => n.textContent);
    expect(scenHot).toEqual(expect.arrayContaining(["user", "generalist", "specialist", "scope", "expected"]));
    // JSON view: the exact text, keys in the hot colour, and no capped pane.
    await user.click(screen.getByTestId("agent-card-raw"));
    const raw = screen.getByTestId("agent-card");
    expect(raw.tagName).toBe("PRE");
    expect(raw.textContent).toContain('"name": "Generalist Banking Agent"');
    expect(raw.querySelector(".jtok--hot")?.textContent).toBe('"name"');
    expect(raw.className).not.toMatch(/max|scroll/);
    expect(screen.getByTestId("agent-card-box").querySelector(".jsonbox__toggle").textContent).toBe("FormJSON");
  });

  it("Rule 24: a hop's HTTP transcript with a JSON body keeps its headers as text and gives the body its own Form | JSON pane", () => {
    const request = 'POST https://a2a.example/a2a\nAuthorization: Bearer <delegated: sub=u>\ncontent-type: application/json\n\n{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"skill":"get_portfolio_summary"}}';
    render(<Hops hops={[{ n: 1, label: "one", request, response: "traceparent: 00-aa-bb-01" }]} traceId="abc" />);
    const head = screen.getByLabelText("Request of hop 1 headers");
    expect(head.tagName).toBe("PRE");
    expect(head.textContent).toContain("Authorization: Bearer <delegated: sub=u>");
    expect(head.textContent).not.toContain("jsonrpc");
    const body = screen.getByLabelText("Request of hop 1 body");
    expect(body.className).toContain("json--form");
    const hot = [...body.querySelectorAll('[data-hot="true"] > .jform__k')].map((n) => n.textContent);
    expect(hot).toEqual(expect.arrayContaining(["method"]));
    expect(screen.getByRole("group", { name: "Request of hop 1 body view" }).textContent).toBe("FormJSON");
  });

  it("Rule 24: a hop's raw text that is not JSON stays text through JsonPane (no Form | JSON toggle)", () => {
    render(<Hops hops={[{ n: 1, label: "one", request: "POST https://a2a.example/a2a\ncontent-type: application/json", response: "HTTP/1.1 200" }]} traceId="abc" />);
    const box = screen.getByTestId("hops").querySelector(".jsonbox");
    expect(box.getAttribute("data-view")).toBe("text");
    expect(box.querySelector(".jsonbox__toggle")).toBeNull();
    expect(box.querySelector("pre").textContent).toContain("POST https://a2a.example/a2a");
  });
});
