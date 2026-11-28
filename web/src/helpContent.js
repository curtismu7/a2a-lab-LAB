// What the Help dialog says. Plain, and as hedged as the rest of the lab (rule 2): what was measured, what is simulated, what is UNVERIFIED.
export const HELP_SECTIONS = [
  {
    heading: "What this lab is",
    body: [
      "A lab for agent-to-agent delegation: a generalist agent hands a task to a specialist sub-agent. Two mock RFC 8693 token exchanges build a nested act chain (act={specialist, act:{generalist}}), and the mock gateway routes the specialist's call only when the specialist is registered and holds only the scope the handoff granted.",
      "The runs are simulated. The exchanges, the Agent Card registry, the gateway and the MFA are all mock, in this app's own process. Nothing leaves your machine."
    ]
  },
  {
    heading: "What was measured, and what was not",
    body: [
      "The decision contract (PERMIT for a valid depth-2 chain, DENY for an unregistered specialist, scope narrowed on an ungranted hop, 401 with no bearer) mirrors what was enforced live in AI-DEMO2 (UC2 / UC2.5 / UC2.6 / UC2.7).",
      "No real policy engine, tenant or agent network is behind this page: which product emits which act shape, and how a specific gateway treats a nested act, are UNVERIFIED here. Every token and decision value is labelled mock."
    ]
  },
  {
    heading: "The scenarios",
    body: [
      "UC2: the handoff permits — exchange #1 then #2, the specialist call is routed, chain depth 2. UC2.6: the same delegation shape from an identity not in the registry is DENIED (PERMIT_THEN_DENY) — authorization keys on WHO is acting.",
      "SCOPE: the handoff did not grant the scope — the ungranted scope is narrowed away. NOT A HANDOFF: a plain act={agent} token is refused (chain_not_nested). UC2.7: the Agent Card is served, and a call with no bearer is a real 401 — the protocol side of A2A beside the identity chain."
    ]
  },
  {
    heading: "How to use the page",
    body: [
      "Delegation & entitlement tab: pick a scenario and run it; the Decision shows the outcome, the reason and the token's act chain. Vertical (retail and friends) changes every name. Run observability, under the Decision, shows one row per decision across six layers for the current run — every row is simulated (the lab has no logs to read).",
      "Diagram: movable boxes, Reset in the header restores them. Talk track opens the script. Presenter hides the intro; the Mock / Real badge stays, and the Mock or Real modal opens once per session. Reset clears only your workspace: registry flips, exchanges and runs."
    ]
  },
  {
    heading: "Mock and Real",
    body: [
      "Mock (default): everything is in-process, nothing leaves the machine. This is the only story here.",
      "Real: the toggle exists but is RESERVED in this build — it reports a configured A2ALAB_REAL_* env, yet no live policy-engine data path is wired, and POST /api/mode answers 409. When Real exists it will be shown honestly; nothing is faked today."
    ]
  }
];
