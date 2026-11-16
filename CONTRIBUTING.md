# Contributing

Thank you for helping improve the Homebridge EcoFlow RIVER 3 Plus plugin.

## Before opening an issue

Search existing issues first. For unsupported devices, use the [unsupported-device issue template](https://github.com/ridzria/homebridge-ecoflow-river-3-plus/issues/new?template=unsupported-device.yml).

## Development

```bash
npm install
npm test
npm run build
git diff --check
```

Use `npm link` for local Homebridge testing. Keep credentials in local configuration only.

## Pull requests

- Explain the user-visible change and the EcoFlow telemetry or command it uses.
- Include or update tests and documentation.
- Keep one feature or fix per pull request where practical.
- Do not commit passwords, tokens, MQTT credentials, full serial numbers, HAR files, or private logs.
- Do not claim a device model is supported without live validation or clearly labeled evidence.

The maintainer will decide the version, changelog entry, release notes, and whether a change belongs in a stable or pre-release channel.
