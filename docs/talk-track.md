# Talk track

<!-- Generated from server/src/policyData.js by `npm run talk-track`. Do not edit by hand. -->

## Say first

Everything here is simulated: the exchanges, the registry and the Agent Card are mock, mirroring what we ran live in AI-DEMO2.

## Two things called A2A

The Linux Foundation agent protocol (Agent Card, JSON-RPC, 401 without the bearer) and the identity chain (nested act). UC2.7 shows them side by side — this lab covers both.

## The nested act chain

Exchange #1: user consents, generalist acts. Exchange #2: specialist acts via the generalist — act={specialist, act:{generalist}}. Depth 2, still acting for the same user.

## Least privilege per hop

The specialist holds only the scope the handoff granted. Scope cannot grow across hops — an ungranted scope is narrowed away.

## WHO is acting

UC2.6: same user, same shape, unregistered specialist — DENIED. The registry is read on every decision; revoke a specialist and the next handoff moves.

## What we do not claim

The mock exchanges, registry and card are demo values; the decision contract follows what we enforced live. No real agent-to-agent network call happens here.

## Close

Reset clears your workspace: registry flips, exchanges and runs. Nothing was sent anywhere.

## The scenarios

1. **UC2: generalist hands off — nested act chain permits.** Two exchanges build act={specialist, act:{generalist}} acting for the same user. The chain is valid and the specialist is registered: PERMIT with the full chain in the token.
2. **UC2.6: unregistered specialist — PERMIT_THEN_DENY.** Same user, same delegation shape — but "rogue-specialist" is not in the Agent Card registry. Authorization keys on WHO is acting.
3. **SCOPE: the handoff did not grant the scope.** Exchange #2 narrows scope: the specialist may hold at most what the generalist had. An ungranted scope is narrowed away and the gateway denies.
4. **NOT A HANDOFF: a plain act={agent} token is refused.** A2A calls require the NESTED chain. A depth-1 act={agent} token is the generalist acting alone — no handoff to validate.
5. **UC2.7: the Agent Card is served; no bearer is a real 401.** The protocol side of A2A: the well-known Agent Card, and a 401 before anything else when the bearer is missing. Identity and protocol, side by side.
