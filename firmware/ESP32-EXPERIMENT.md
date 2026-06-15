# Disposable classic ESP32 experiment

This target exists only to validate provisioning, networking, collection, protocol, and OTA
application behavior on a classic ESP32 while the supported ESP32-S3 hardware is unavailable.
It is not a supported production target.

- Build config: `sdkconfig.defaults.esp32-experiment`
- Build directory: `build-esp32-experiment`
- Bootstrap output: `../dist/bootstrap-esp32-experiment`
- Board identifier: `esp32-classic-experiment`
- Provisioning is bypassed: Wi-Fi and collector settings are seeded into NVS on first boot
- Admin token and device name: populated with disposable internal defaults
- Internal-RAM queue and batch sizes are intentionally reduced because this board has no PSRAM.

Delete this file, the experiment sdkconfig, and code guarded by
`CONFIG_RF_SENSE_CLASSIC_ESP32_EXPERIMENT` when the ESP32-S3 arrives. Never publish this image as
an ESP32-S3 release or OTA update.
