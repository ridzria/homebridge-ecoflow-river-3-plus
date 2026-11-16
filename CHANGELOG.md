# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- Added a roadmap for verified EcoFlow telemetry and Homebridge/Matter features.
- Added read-only custom HomeKit battery-health and cycle-count characteristics for compatible companion apps.
- Added a HomeKit SOS Mode control for the RIVER 3 Plus light using the verified EcoFlow light-mode command.
- Added read-only custom HomeKit charge/discharge remaining-time characteristics, reported in minutes when EcoFlow provides estimates.
- Added PV Input Power and PV Energy readings for Matter and Eve/HomeKit using EcoFlow's verified `pow_get_pv` and `pv_in_energy` fields.

## [0.10.0] - 2026-11-16

### Added

- Added PV Input Power and PV Energy readings to Matter and legacy HomeKit/Eve.
- Added cleanup for the earlier prototype PV characteristic.

### Live validation

- Confirmed live PV power around 5 W and PV energy around 71 Wh in Eve.

## [0.9.0] - 2026-11-16

### Added

- Added a dedicated HomeKit SOS Mode switch for Apple Home automations.
- Preserved the Eve SOS Mode characteristic for companion-app control.

### Live validation

- Confirmed the SOS switch appears in Apple Home automation controls and activates the blinking SOS light.

## [0.8.0] - 2026-11-16

### Added

- Added charge and discharge remaining-time characteristics in minutes.

### Live validation

- Confirmed in Eve using live RIVER 3 Plus telemetry, including a discharge estimate of approximately 2,499 minutes.

## [0.7.0] - 2026-11-16

### Added

- Added Battery Health and Battery Cycles custom HomeKit characteristics.

### Live validation

- Confirmed in Eve with Battery Health at 100% and Battery Cycles at 1.

## [0.6.0] - 2026-11-16

### Added

- Documented and regression-tested AC and 12V output power in legacy HomeKit mode through the Eve/Controller `Consumption` characteristic.

### Live validation

- Confirmed legacy HomeKit accessories and watt readings in the HomeKit test setup.

## [0.5.0] - 2026-11-16

### Added

- Added Matter USB-A and USB-C power sensors.

### Live validation

- Confirmed in Apple Home with USB-A reporting 7W and USB-C reporting 0W.

## [0.4.0] - 2026-11-16

### Added

- Added Matter electrical sensors for total input and output power.

### Notes

- Apple Home may display these read-only electrical sensors with a generic `Power` label or combine their presentation. Homebridge logs and other Matter controllers can distinguish `Input Power` and `Output Power`.

## [0.3.0] - 2026-11-16

### Added

- Added a Battery Temperature sensor using the verified RIVER 3 Plus `temp` telemetry field.

### Verification

- Covered by the simulator and Homebridge platform tests.
- Live-tested in Apple Home at approximately 27°C.
