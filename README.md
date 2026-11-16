# homebridge-ecoflow-river3

A [Homebridge](https://homebridge.io) plugin that adds the **EcoFlow RIVER 3** and **RIVER 3 Plus** portable power stations to Apple Home.

> **Status: not yet tested on a real unit.** The plugin was written before its author's RIVER 3 Plus arrived. The protocol code is checked byte for byte against the [hassio-ecoflow-cloud](https://github.com/tolwi/hassio-ecoflow-cloud) Home Assistant integration, which does support these units, and the sign-in code has been checked against EcoFlow's live servers. Nothing has yet been confirmed against real hardware. Expect rough edges, and please report what you find.

## What you get in Apple Home

| In Home | What it does |
|---|---|
| **AC Outlets** | Turns the AC sockets on and off. Over Matter it also reports power in watts and lifetime energy |
| **12V Outlet** | Turns the 12 V car socket on and off, with the same power and energy readings over Matter |
| **Battery** | Charge level, charging state and a low-battery warning |
| **Light** (RIVER 3 Plus) | The light bar: off, dim (50% or below) or bright |
| **Mains Power** | A contact sensor that opens when mains power is lost, for power-cut notifications and automations |
| **X-Boost** (optional) | A switch for X-Boost |

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

```bash
npm install -g git+https://github.com/richorridge/homebridge-ecoflow-river3.git
```

Then restart Homebridge and open the plugin's settings.

## Settings

Use the settings form in the Homebridge UI, or add this to the `platforms` list in `config.json`:

```json
{
  "platform": "EcoFlowRiver3",
  "name": "EcoFlow RIVER 3",
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
| `apiHost` | EcoFlow service host: `api-s.ecoflow.com` (EcoFlow app service; required for some RIVER 3 Plus accounts), `api.ecoflow.com` (global and US), `api-e.ecoflow.com` (Europe) or `api-a.ecoflow.com` (Americas) | `api.ecoflow.com` |
| `protocol` | `auto`, `matter` or `homekit`. See "Watts in Apple Home" above | `auto` |
| `simulate` | Show a pretend RIVER 3 Plus without signing in | `false` |
| `devices[].name` | Name shown in Home | `RIVER 3` |
| `devices[].serialNumber` | On the label under the unit and in the EcoFlow app | none |
| `devices[].acOutlet` | Show the AC outlets | `true` |
| `devices[].dcOutlet` | Show the 12 V outlet | `true` |
| `devices[].light` | Show the light bar | `true` on a RIVER 3 Plus |
| `devices[].mainsSensor` | Show the mains power sensor | `true` |
| `devices[].xboostSwitch` | Show an X-Boost switch | `false` |
| `devices[].lowBatteryThreshold` | Battery level, in percent, at which Home shows a low-battery warning | `20` |

EcoFlow keeps accounts in separate regions. If sign-in is refused with a password you know is right, change `apiHost`: accounts registered in Europe (including the UK) usually need `api-e.ecoflow.com`.

If EcoFlow refuses the email and password, the plugin stops trying until Homebridge is restarted, so that a wrong password cannot lock the account.

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

## Known limits

- Only the AC and 12 V outputs report watts. Input power, USB power, charge limits, charging speed and timers are not exposed. Use the EcoFlow app for those.
- Lifetime energy only appears once the unit has sent its statistics, which may take a while after start-up.
- The unit can be switched off remotely but not back on, so the plugin has no power switch.
- The mains sensor relies on the unit's "AC charger connected" flag. Whether that flag drops the moment mains fails has not been confirmed on a real unit.
- Extra batteries (EB300, EB600) are included in the overall battery level but are not shown separately.
- The USB ports have no switch on this model, so there is nothing to control.

## Development

```bash
npm install
```

```bash
npm test
```

The tests cover the wire protocol (against fixtures generated from the reference implementation), sign-in, the cloud connection and its retry rules, device state, the HomeKit accessory using Homebridge's own classes, and the Matter accessories, all with the built-in simulator.

To regenerate the reference fixtures, see `scripts/make_reference_fixtures.py`.

## Credits and licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The protocol definition, sign-in flow and message framing come from [hassio-ecoflow-cloud](https://github.com/tolwi/hassio-ecoflow-cloud). Reading the output states from the flow fields follows [ha-ef-ble](https://github.com/rabits/ha-ef-ble). Both are Apache-2.0 projects, and this plugin would not exist without them.

This plugin is not made, endorsed or supported by EcoFlow.
