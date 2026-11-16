# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- Added a roadmap for verified EcoFlow telemetry and Homebridge/Matter features.

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
