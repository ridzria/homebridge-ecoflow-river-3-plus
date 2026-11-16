# AGENTS.md

This repository follows the [Ridzria Agent Engineering Protocol](https://github.com/ridzria/agent-engineering-protocol). The protocol governs agent-assisted work here; this file adds EcoFlow-specific constraints.

## Required workflow

Scale ceremony to risk:

- Small: inspect → change → focused verification.
- Medium: investigate → brief plan → implement → test/review.
- Large: investigate → approved plan → staged execution → independent review → human approval.

For non-trivial work use: **Frame → Investigate → Plan → Execute → Verify → Review/Handoff**.

Frame the outcome, scope, non-goals, constraints, and authorization boundary. Investigate the repository, primary sources, existing patterns, and current behavior. Plan with action → evidence pairs, risks, dependencies, and gates. Execute the smallest sufficient change. Verify against observable success criteria. Hand off with changes, evidence, limitations, uncertainty, and follow-up decisions.

Keep facts, assumptions, decisions, and open questions distinct. Stop and ask when uncertainty could materially change correctness, safety, cost, or scope. Do not claim a behavior is fixed without evidence.

For medium or large tasks, use this handoff record:

```text
Outcome:
Scope / non-goals:
Authorization boundary:

Plan:
1. [action] → verify: [evidence]
2. [action] → verify: [evidence]

Risks and assumptions:
Changes made:
Verification performed:
Verification not performed:
Remaining uncertainty:
Approval or follow-up needed:
```

## Project outcome

Build a reliable, contributor-friendly Homebridge plugin for the EcoFlow RIVER 3 Plus that exposes verified device state and controls in Apple Home.

## Verified EcoFlow facts

- Use `api-s.ecoflow.com` as the default service host for the RIVER 3 Plus.
- The corresponding MQTT broker is supplied by EcoFlow certification and has been observed as `mqtt-s.ecoflow.com:8883`.
- Live telemetry works with the EcoFlow app closed when the `api-s` service region is used.
- The device publishes protobuf telemetry on the accepted `data` topic.
- Existing RIVER 3 protobuf definitions and framing are derived from `hassio-ecoflow-cloud`; retain attribution in `NOTICE` and `README.md`.
- The official Developer API `accessKey`/`secretKey` path is separate from the private app MQTT path. Do not replace the verified transport based only on claims that another model supports the public API.

## Safety and authorization

- Never commit passwords, bearer tokens, MQTT credentials, access keys, secret keys, private signing keys, full serial numbers, or raw HAR/cURL files.
- Redact credentials and serial numbers in logs, fixtures, issues, screenshots, and documentation. Use suffixes or synthetic values in examples.
- Treat external pushes, releases, package publication, and device-control tests as consequential actions; perform them only when explicitly authorized.
- Do not use destructive repository or filesystem operations without explicit authorization and a verified target.
- Preserve upstream licenses and attribution when porting or adapting protocol material.

## Evidence and change rules

- Do not change protocol constants or protobuf field mappings without a real capture, fixture, or reproducible reference implementation.
- When EcoFlow partially refuses subscriptions, accepted topics must remain usable and rejected topics must be diagnosed clearly.
- Record important discoveries only when verified. Put speculative protocol theories in an issue or development note first.

Update the appropriate artifact when evidence warrants it:

- `src/` — implementation behavior or protocol support.
- `test/` — every new parser, transport, device-state, or authorization case.
- `test/fixtures/` — sanitized, stable real-device payloads.
- `README.md` — installation, configuration, supported fields, troubleshooting, or user-visible behavior.
- `NOTICE` — new third-party licensed material.
- `CHANGELOG.md` — user-visible fixes, controls, supported models, or breaking configuration changes.

## Verification before delivery

Run applicable checks and report exactly what ran:

```bash
npx tsc -p tsconfig.json --noEmit
npm test
npm run build
git diff --check
```

For live-device work, use probe scripts with `api-s.ecoflow.com`, keep the EcoFlow app closed when testing background behavior, and share only sanitized output.

## Contribution direction

Prefer small, reviewable changes. New contributors should be able to add a sanitized telemetry fixture, map a verified field, add a HomeKit/Matter characteristic, or document tested device behavior without needing account credentials.

## Release workflow

After the user approves a feature and its live test passes:

1. Update `package.json` using semantic versioning: patch for fixes, minor for compatible features, major for breaking changes.
2. Update `CHANGELOG.md` and mark the roadmap item complete only when live validation is confirmed.
3. Run `npm test`, `npm run build`, and `git diff --check`.
4. Commit the complete implementation and documentation.
5. Create the matching annotated tag, such as `v0.5.0`.
6. Push the branch and tag to GitHub.
7. Create the GitHub Release with Markdown notes matching the changelog.

Use a quoted heredoc or a shell `$'...'` string for multiline `gh release create/edit --notes` content. Do not pass literal `\\n` sequences. Never publish to npm unless the user separately authorizes public package publication.

## Roadmap order

Implement roadmap items in the listed order. A deviation is allowed only for a dependency, compatibility issue, or bug fix that materially improves correctness. When deviating, record the reason in the plan and update the roadmap order in the same change. Do not silently skip ahead.

## Three-person collaboration

The project uses these role names:

- **PM:** the user owns product direction, live EcoFlow/HomeKit/Matter testing, prioritisation, and approval of consequential releases.
- **Primary Agent:** owns implementation, integration, verification, documentation, commits, tags, and GitHub Releases after PM approval.
- **Junior Agent:** performs independent telemetry research, compatibility investigation, focused test review, or code review under the Primary Agent's direction.

The PM may check and approve work while the Primary Agent continues implementation. Junior Agent work may run in parallel, but only one roadmap feature is delivered and live-validated at a time. The Junior Agent must not publish releases, expose credentials, control the device, or expand scope without explicit authorization.

