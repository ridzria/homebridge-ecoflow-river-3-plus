# homebridge-ecoflow-river-3-plus

A [Homebridge](https://homebridge.io) plugin that adds the **EcoFlow RIVER 3 Plus** portable power station to Apple Home.

> **Status: tested against a real RIVER 3 Plus.** Live telemetry was verified through EcoFlow's app MQTT service at `api-s.ecoflow.com` / `mqtt-s.ecoflow.com` with the app closed.

## Product-family compatibility

The EcoFlow app's `getAllRealSnList` response provides a useful product catalog. It identifies product names, regional variants, product types, and serial-number prefixes, but it does **not** guarantee that models share the same telemetry or control protocol.

| Family or variant | Catalog serial prefix | Plugin status |
|---|---:|---|
| RIVER 3 Plus | `R631` | Verified live |
| RIVER 3 Plus 270 | `R634` | Verified live |
| RIVER 3 Plus Wireless | `R635` | Catalog-listed; protocol compatibility not separately live-validated |
| RIVER 3 / 245 Wh variants | `R651`, `R653` | Possible future support; not live-validated |
| RIVER 3 / UPS variants | `R654`, `R655` | Possible future support; not live-validated |
| RIVER 3 Plus extra batteries | `R632`, `R633` | Battery accessory entries; separate support not validated |

The plugin currently targets the verified RIVER 3 Plus protocol. Other catalog entries remain possible support targets until a real device provides matching telemetry and its controls pass live validation. Regional names and catalog membership alone are not sufficient to mark a model as supported.

## What you get in Apple Home

| In Home | What it does |
|---|---|
| **AC Outlets** | Turns the AC sockets on and off. Over Matter it also reports power in watts and lifetime energy |
| **12V Outlet** | Turns the 12 V car socket on and off, with the same power and energy readings over Matter |
| **Battery** | Charge level, charging state, low-battery warning, and custom health/cycle values for compatible HomeKit apps |
| **Light** (RIVER 3 Plus) | The light bar: off, dim (50% or below) or bright |
| **Mains Power** | A contact sensor that opens when mains power is lost, for power-cut notifications and automations |
| **X-Boost** (optional) | A switch for X-Boost |

When Matter is enabled, the plugin also exposes read-only **Input Power**, **Output Power**, and **PV Input Power** electrical sensors, with PV energy totals when reported by the unit.

When the unit cannot be reached, HomeKit tiles show "No Response" and Matter commands fail.

## Watts in Apple Home: Matter or HomeKit

Apple Home shows power use only for devices that report it over **Matter** (reported as new in iOS 27). The older HomeKit protocol has no standard watts value. So the plugin can present the unit either way:

| | Matter | HomeKit |
|---|---|---|
| Watts and energy in Apple Home | Yes | No (third-party apps such as Eve can show watts) |
| Needs | Homebridge 2.3 or later, with Matter switched on for the bridge the plugin runs on | Homebridge 1.8 or later |
| Pair using | The bridge's **Matter** pairing code | The bridge's HomeKit code |
| Appears in Home as | Separate devices: AC Outlets, 12V Outlet, Light, Mains Power. The battery is attached to the first of them | One accessory with several tiles |

By default (`"protocol": "auto"`) the plugin uses Matter whenever Matter is switched on for its bridge, and HomeKit otherwise. It uses one or the other, never both, so nothing appears twice. Moving from one to the other removes the old accessories, so rooms and automations need setting up again.

To switch Matter on, open the bridge's settings in the Homebridge UI (the main bridge, or the plugin's child bridge if it has one) and enable Matter, then restart and pair with the Matter code shown there.

Homebridge 2.5 accepts all of these Matter devices, including the power, energy and battery features, and that is covered by the tests. How Apple Home then displays them has not been checked.

## How it works, and what that means for you

EcoFlow has not added the RIVER 3 family to its official developer API, so this plugin talks to EcoFlow's cloud the same way the EcoFlow phone app does.

- **It needs your EcoFlow app email and password.** They are stored in Homebridge's `config.json`, like any other plugin setting, and are only sent to EcoFlow.
- **It depends on EcoFlow's cloud.** The unit must be connected to Wi-Fi, and there is no local control. If your internet is down, Home cannot reach the unit.
- **It uses an unofficial API.** EcoFlow could change it without notice, which would break the plugin until it is updated.

## Install

Homebridge 1.8 or later and Node.js 20.18 or later. For watts in Apple Home you need Homebridge 2.3 or later.

### Install from Homebridge UI

1. Open Homebridge Config UI.
2. Open **Plugins** and search for `homebridge-ecoflow-river-3-plus`.
3. Install the plugin.
4. Add the **EcoFlow RIVER 3 Plus** platform configuration.
5. Enter the EcoFlow app email, password, `api-s.ecoflow.com`, and the unit serial number.
6. Save and restart Homebridge.

### Install from a terminal

```bash
sudo npm install -g https://github.com/ridzria/homebridge-ecoflow-river-3-plus.git
sudo systemctl restart homebridge
```

```bash
npm install -g git+https://github.com/ridzria/homebridge-ecoflow-river-3-plus.git
```

Then restart Homebridge and open the plugin's settings.

## Settings

Use the settings form in the Homebridge UI, or add this to the `platforms` list in `config.json`:

```json
{
  "platform": "EcoFlowRiver3Plus",
  "name": "EcoFlow RIVER 3 Plus",
  "email": "you@example.com",
  "password": "your EcoFlow app password",
  "apiHost": "api-s.ecoflow.com",
  "devices": [
    {
      "name": "RIVER 3 Plus",
      "serialNumber": "R631XXXXXXXXXXXX"
    }
  ]
}
```

| Setting | Meaning | Default |
|---|---|---|
| `email`, `password` | Your EcoFlow app account | none |
| `apiHost` | EcoFlow app service host for this plugin | `api-s.ecoflow.com` |
| `protocol` | `auto`, `matter` or `homekit`. See "Watts in Apple Home" above | `auto` |
| `simulate` | Show a pretend RIVER 3 Plus without signing in | `false` |
| `devices[].name` | Name shown in Home | `RIVER 3 Plus` |
| `devices[].serialNumber` | On the label under the unit and in the EcoFlow app | none |
| `devices[].acOutlet` | Show the AC outlets | `true` |
| `devices[].dcOutlet` | Show the 12 V outlet | `true` |
| `devices[].light` | Show the light bar | `true` on a RIVER 3 Plus |
| `devices[].mainsSensor` | Show the mains power sensor | `true` |
| `devices[].xboostSwitch` | Show an X-Boost switch | `false` |
| `devices[].lowBatteryThreshold` | Battery level, in percent, at which Home shows a low-battery warning | `20` |

For the RIVER 3 Plus, use `api-s.ecoflow.com`. This is the app-service host required for the live MQTT telemetry path verified by this plugin.

If EcoFlow refuses the email and password, the plugin stops trying until Homebridge is restarted, so that a wrong password cannot lock the account.

## Raspberry Pi deployment

```bash
sudo systemctl restart homebridge
sudo journalctl -u homebridge -f
```

The expected sequence is `Signed in to EcoFlow`, `Connected to EcoFlow`, `data: ...`, and `is now online`. The EcoFlow iOS app does not need to remain open.

To update an existing installation:

```bash
sudo npm update -g homebridge-ecoflow-river-3-plus
sudo systemctl restart homebridge
```

## Try it without a unit

Set `"simulate": true` and add a device with any serial number starting `R631`. The plugin then shows a pretend RIVER 3 Plus that charges slowly and responds to its switches, with no sign-in. This is how the HomeKit side of the plugin is tested.

## Checking a real unit

`scripts/probe.mjs` connects to EcoFlow without Homebridge and prints what the unit reports. It only listens and never changes a setting.

```bash
npm install
```

```bash
ECOFLOW_EMAIL=you@example.com ECOFLOW_PASSWORD='your password' ECOFLOW_SN=R631XXXXXXXXXXXX ECOFLOW_HOST=api-s.ecoflow.com npm run probe
```

Change something in the EcoFlow app while it runs and the change should appear in the output. Running Homebridge in debug mode (`homebridge -D`) logs the same detail.

For a topic-by-topic diagnostic:

```bash
npm run build
ECOFLOW_HOST=api-s.ecoflow.com node scripts/probe-topics.mjs
```

Never share diagnostic output containing credentials, bearer tokens, MQTT passwords, or a full serial number.

## Troubleshooting

### The plugin connects but shows no telemetry

Confirm that the configured host is `api-s.ecoflow.com`, then restart Homebridge in debug mode. Do not use Developer API `accessKey`/`secretKey` values in place of the EcoFlow app email and password.

### Subscription error or `code: "-1"`

Run the topic diagnostic with `api-s`. A successful RIVER 3 Plus connection accepts the `data`, `set_reply`, and `get_reply` topics. Live `data` telemetry is the authoritative source for this model.

### Homebridge cannot start after installation

Verify the platform name:

```json
"platform": "EcoFlowRiver3Plus"
```

The serial number should normally begin with `R63`.

### Resetting a broken configuration

Remove only the EcoFlow platform entry from `config.json`, keep a backup, and restart. Do not delete the entire Homebridge persist directory.

## Known limits

- In legacy HomeKit mode, only the AC and 12 V outputs report watts through third-party characteristics. Input/output power sensors are Matter-only for now.
- Lifetime energy only appears once the unit has sent its statistics, which may take a while after start-up.
- The unit can be switched off remotely but not back on, so the plugin has no power switch.
- The mains sensor relies on the unit's "AC charger connected" flag. Whether that flag drops the moment mains fails has not been confirmed on a real unit.
- Extra batteries (EB300, EB600) are included in the overall battery level but are not shown separately.
- The USB ports have no switch on this model, so there is nothing to control.

## Roadmap

Features are implemented one at a time, in the order listed, from verified telemetry, with a fixture/test, documentation, versioned changelog entry, and live-device validation before the next feature begins. We only change the order for a documented dependency, compatibility issue, or bug fix.

- [x] Battery temperature sensor (HomeKit and Matter)
- [x] Total input/output power sensors (Matter)
- [x] USB-A and USB-C power sensors (Matter)
- [x] AC output power in legacy HomeKit mode (Eve/Controller `Consumption`)
- [x] 12 V DC output power in legacy HomeKit mode (Eve/Controller `Consumption`)
- [x] Battery health and cycle count (custom HomeKit characteristics for compatible apps)
- [x] Charge/discharge remaining time (custom HomeKit characteristics in minutes)
- [x] PV/solar input power (Matter and Eve/HomeKit)
- [x] PV/solar energy totals (Matter and Eve/HomeKit when reported)
- [x] Error, alarm, and protection sensors (read-only Eve/HomeKit status values)
- [x] Maximum Charge control (HomeKit/Eve)
- [ ] Timer controls (device, AC outlet, and LCD screen) — deferred pending reliable field mapping

The RIVER 3 Plus light reports four verified modes: Off, Dim, Bright, and SOS. HomeKit exposes SOS as a separate read/write characteristic on the Light service; Matter continues to expose Off/Dim/Bright through its level control.

## Development

```bash
npm install
```

```bash
npm test
```

The tests cover the wire protocol (against fixtures generated from the reference implementation), sign-in, the cloud connection and its retry rules, device state, the HomeKit accessory using Homebridge's own classes, and the Matter accessories, all with the built-in simulator.

To regenerate the reference fixtures, see `scripts/make_reference_fixtures.py`.

### Publish a release

After a feature has passed live-device validation, update the version in `package.json`, changelog, and roadmap, then run:

```bash
npm test
npm run build
git diff --check
```

Then commit and publish the matching tag and GitHub Release:

```bash
git add .
git commit -m "Release version X.Y.Z"
git tag -a vX.Y.Z -m "Release X.Y.Z"
git push origin main vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /path/to/release-notes.md
```

Release notes must contain real Markdown line breaks. Use `--notes-file` or shell `$'...'` quoting; do not pass escaped `\\n` text. npm publication is intentionally separate and requires explicit approval.

## Credits and licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The protocol definition, sign-in flow and message framing come from [hassio-ecoflow-cloud](https://github.com/tolwi/hassio-ecoflow-cloud). Reading the output states from the flow fields follows [ha-ef-ble](https://github.com/rabits/ha-ef-ble). Both are Apache-2.0 projects, and this plugin would not exist without them.

This plugin is not made, endorsed or supported by EcoFlow.
