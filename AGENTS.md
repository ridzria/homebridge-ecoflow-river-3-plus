# AGENTS.md

## Project

This repository develops a Homebridge plugin for the EcoFlow RIVER 3 Plus.
The goal is a reliable, contributor-friendly plugin that exposes verified
device state and controls in Apple Home.

## Verified transport

- Use `api-s.ecoflow.com` as the default service host for the RIVER 3 Plus.
- The corresponding MQTT broker is provided by EcoFlow certification and is
  currently `mqtt-s.ecoflow.com:8883`.
- Live telemetry works with the EcoFlow app closed when the `api-s` service
  region is used.
- The device publishes protobuf telemetry on the accepted `data` topic.
- The existing RIVER 3 protobuf definitions and framing are derived from
  `hassio-ecoflow-cloud`; retain the attribution in `NOTICE` and `README.md`.
- The official Developer API `accessKey`/`secretKey` path is separate from the
  private app MQTT path. Do not replace the verified transport based only on
  claims that another EcoFlow model supports the public API.

## Working rules

- Never commit passwords, bearer tokens, MQTT usernames/passwords, access keys,
  secret keys, private signing keys, full serial numbers, or raw HAR/cURL files.
- Redact credentials and serial numbers in logs, fixtures, issues, screenshots,
  and documentation. Use serial suffixes or synthetic values in examples.
- Do not change protocol constants or protobuf field mappings without a real
  capture, a fixture, or a reproducible reference implementation.
- Keep Homebridge behavior safe when EcoFlow partially refuses a subscription:
  accepted topics must remain usable and rejected topics must be diagnosed
  clearly.
- Preserve upstream license and attribution when porting or adapting protocol
  material.

## When to update the repository

Add a verified finding to the appropriate place:

- `src/`: implementation behavior or protocol support.
- `test/`: every new parser, transport, device-state, or authorization case.
- `test/fixtures/`: sanitized real-device payloads that are stable and useful.
- `README.md`: installation, configuration, supported fields, troubleshooting,
  or user-visible behavior.
- `NOTICE`: only when a new third-party source or licensed material is added.
- `CHANGELOG.md`: user-visible fixes, new controls, supported models, or
  breaking configuration changes.

Do not add speculative protocol claims to the README. Record uncertain findings
in an issue or development note until they are reproduced.

## Verification before commit

Run the applicable checks:

```bash
npx tsc -p tsconfig.json --noEmit
npm test
npm run build
git diff --check
```

For live-device work, use the probe scripts with `api-s.ecoflow.com`, keep the
EcoFlow app closed when testing background behavior, and share only sanitized
output.

## Contribution direction

Prefer small, reviewable changes. New contributors should be able to add a
sanitized telemetry fixture, map a verified field, add a HomeKit/Matter
characteristic, or document a tested device behavior without needing account
credentials.

