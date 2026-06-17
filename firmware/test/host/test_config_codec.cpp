// DeviceConfig serialization round-trip + semantic validation.
#include <cstring>

#include "ConfigCodec.h"
#include "check.h"

using namespace rfsense;

namespace {
DeviceConfig goodConfig() {
  DeviceConfig c{};
  std::strcpy(c.wifiSsid, "mynet");
  std::strcpy(c.wifiPassword, "password123");
  std::strcpy(c.collectorHost, "192.168.1.50");
  std::strcpy(c.otaManifestUrl, "https://ota.local/manifest/stable.json");
  c.collectorPort = 5566;
  c.pingPps = 25;
  c.captureMode = 0;
  c.provisioned = true;
  return c;
}
}  // namespace

int main() {
  const DeviceConfig c = goodConfig();
  const char* err = "sentinel";
  CHECK(ConfigCodec::validate(c, &err));
  CHECK(err == nullptr);

  uint8_t blob[ConfigCodec::kMaxBlobSize];
  const std::size_t n = ConfigCodec::encode(c, blob, sizeof(blob));
  CHECK(n > 0);

  DeviceConfig d{};
  CHECK(ConfigCodec::decode(blob, n, d));
  CHECK(std::strcmp(d.wifiSsid, c.wifiSsid) == 0);
  CHECK(std::strcmp(d.wifiPassword, c.wifiPassword) == 0);
  CHECK(std::strcmp(d.otaManifestUrl, c.otaManifestUrl) == 0);
  CHECK(d.collectorPort == 5566);
  CHECK(d.captureMode == 0);
  CHECK(d.provisioned);

  // CRC and length integrity.
  uint8_t corrupt[ConfigCodec::kMaxBlobSize];
  std::memcpy(corrupt, blob, n);
  corrupt[0] ^= 0xFF;
  DeviceConfig tmp{};
  CHECK(!ConfigCodec::decode(corrupt, n, tmp));
  CHECK(!ConfigCodec::decode(blob, n - 1, tmp));

  // Validation rejects.
  DeviceConfig bad = c;
  std::strcpy(bad.wifiPassword, "short");  // < 8 chars
  CHECK(!ConfigCodec::validate(bad, &err));

  bad = c;
  bad.wifiSsid[0] = '\0';
  CHECK(!ConfigCodec::validate(bad, &err));

  bad = c;
  bad.collectorPort = 0;
  CHECK(!ConfigCodec::validate(bad, &err));

  bad = c;
  bad.pingPps = 0;
  CHECK(!ConfigCodec::validate(bad, &err));
  bad.pingPps = 201;
  CHECK(!ConfigCodec::validate(bad, &err));

  bad = c;
  bad.captureMode = 5;
  CHECK(!ConfigCodec::validate(bad, &err));

  bad = c;
  std::strcpy(bad.otaManifestUrl, "http://insecure.local/m.json");
  CHECK(!ConfigCodec::validate(bad, &err));  // plain http refused without dev flag

  // Empty manifest URL is allowed (OTA simply unconfigured).
  bad = c;
  bad.otaManifestUrl[0] = '\0';
  CHECK(ConfigCodec::validate(bad, &err));

  // isComplete needs provisioned + ssid.
  CHECK(ConfigCodec::isComplete(c));
  DeviceConfig incomplete = c;
  incomplete.provisioned = false;
  CHECK(!ConfigCodec::isComplete(incomplete));

  return SUMMARY();
}
