#include "ConfigCodec.h"

#include <cstring>

#include "Protocol.h"

namespace rfsense {
namespace {

class Cursor {
 public:
  Cursor(uint8_t* buf, std::size_t cap) : buf_(buf), cap_(cap) {}
  bool putBytes(const void* src, std::size_t n) {
    if (off_ + n > cap_) {
      return false;
    }
    std::memcpy(buf_ + off_, src, n);
    off_ += n;
    return true;
  }
  bool putU8(uint8_t v) { return putBytes(&v, 1); }
  bool putU16(uint16_t v) {
    uint8_t b[2] = {static_cast<uint8_t>(v & 0xFF), static_cast<uint8_t>((v >> 8) & 0xFF)};
    return putBytes(b, 2);
  }
  bool putU32(uint32_t v) {
    uint8_t b[4] = {static_cast<uint8_t>(v & 0xFF), static_cast<uint8_t>((v >> 8) & 0xFF),
                    static_cast<uint8_t>((v >> 16) & 0xFF), static_cast<uint8_t>((v >> 24) & 0xFF)};
    return putBytes(b, 4);
  }
  std::size_t offset() const { return off_; }

 private:
  uint8_t* buf_;
  std::size_t cap_;
  std::size_t off_ = 0;
};

class Reader {
 public:
  Reader(const uint8_t* buf, std::size_t len) : buf_(buf), len_(len) {}
  bool getBytes(void* dst, std::size_t n) {
    if (off_ + n > len_) {
      return false;
    }
    std::memcpy(dst, buf_ + off_, n);
    off_ += n;
    return true;
  }
  bool getU8(uint8_t& v) { return getBytes(&v, 1); }
  bool getU16(uint16_t& v) {
    uint8_t b[2];
    if (!getBytes(b, 2)) return false;
    v = static_cast<uint16_t>(b[0]) | static_cast<uint16_t>(b[1] << 8);
    return true;
  }
  bool getU32(uint32_t& v) {
    uint8_t b[4];
    if (!getBytes(b, 4)) return false;
    v = static_cast<uint32_t>(b[0]) | (static_cast<uint32_t>(b[1]) << 8) |
        (static_cast<uint32_t>(b[2]) << 16) | (static_cast<uint32_t>(b[3]) << 24);
    return true;
  }
  std::size_t offset() const { return off_; }

 private:
  const uint8_t* buf_;
  std::size_t len_;
  std::size_t off_ = 0;
};

// Length of the fixed v1 body (header + fields), excluding the trailing CRC32.
constexpr std::size_t kBodyLen = 8 + (33 + 64 + 192 + 16 + 64 + 49 + 32) + (2 + 1 + 2 + 2 + 2 + 4 + 1 + 4 + 1 + 1);

bool encodeBody(const DeviceConfig& c, uint8_t* out, std::size_t cap) {
  Cursor w(out, cap);
  bool ok = true;
  ok &= w.putU32(ConfigCodec::kMagic);
  ok &= w.putU16(ConfigCodec::kVersion);
  ok &= w.putU16(0);  // reserved
  ok &= w.putBytes(c.wifiSsid, sizeof(c.wifiSsid));
  ok &= w.putBytes(c.wifiPassword, sizeof(c.wifiPassword));
  ok &= w.putBytes(c.otaManifestUrl, sizeof(c.otaManifestUrl));
  ok &= w.putBytes(c.otaChannel, sizeof(c.otaChannel));
  ok &= w.putBytes(c.collectorHost, sizeof(c.collectorHost));
  ok &= w.putBytes(c.adminToken, sizeof(c.adminToken));
  ok &= w.putBytes(c.deviceName, sizeof(c.deviceName));
  ok &= w.putU16(c.collectorPort);
  ok &= w.putU8(c.captureMode);
  ok &= w.putU16(c.pingPps);
  ok &= w.putU16(c.pingPayloadBytes);
  ok &= w.putU16(c.pingTimeoutMs);
  ok &= w.putU32(c.pingWarmupMs);
  ok &= w.putU8(c.otaScheduledEnabled ? 1 : 0);
  ok &= w.putU32(c.otaScheduledIntervalS);
  ok &= w.putU8(c.otaAutoApply ? 1 : 0);
  ok &= w.putU8(c.provisioned ? 1 : 0);
  return ok && w.offset() == kBodyLen;
}

}  // namespace

std::size_t ConfigCodec::encode(const DeviceConfig& cfg, uint8_t* out, std::size_t outCap) {
  if (outCap < kBodyLen + 4) {
    return 0;
  }
  if (!encodeBody(cfg, out, outCap)) {
    return 0;
  }
  const uint32_t crc = proto::crc32(out, kBodyLen);
  out[kBodyLen + 0] = static_cast<uint8_t>(crc & 0xFF);
  out[kBodyLen + 1] = static_cast<uint8_t>((crc >> 8) & 0xFF);
  out[kBodyLen + 2] = static_cast<uint8_t>((crc >> 16) & 0xFF);
  out[kBodyLen + 3] = static_cast<uint8_t>((crc >> 24) & 0xFF);
  return kBodyLen + 4;
}

bool ConfigCodec::decode(const uint8_t* in, std::size_t len, DeviceConfig& cfg) {
  if (len != kBodyLen + 4) {
    return false;
  }
  const uint32_t storedCrc = static_cast<uint32_t>(in[kBodyLen]) |
                             (static_cast<uint32_t>(in[kBodyLen + 1]) << 8) |
                             (static_cast<uint32_t>(in[kBodyLen + 2]) << 16) |
                             (static_cast<uint32_t>(in[kBodyLen + 3]) << 24);
  if (proto::crc32(in, kBodyLen) != storedCrc) {
    return false;
  }

  Reader r(in, len);
  uint32_t magic = 0;
  uint16_t version = 0;
  uint16_t reserved = 0;
  if (!r.getU32(magic) || !r.getU16(version) || !r.getU16(reserved)) {
    return false;
  }
  if (magic != kMagic || version != kVersion) {
    return false;
  }

  DeviceConfig c;
  bool ok = true;
  ok &= r.getBytes(c.wifiSsid, sizeof(c.wifiSsid));
  ok &= r.getBytes(c.wifiPassword, sizeof(c.wifiPassword));
  ok &= r.getBytes(c.otaManifestUrl, sizeof(c.otaManifestUrl));
  ok &= r.getBytes(c.otaChannel, sizeof(c.otaChannel));
  ok &= r.getBytes(c.collectorHost, sizeof(c.collectorHost));
  ok &= r.getBytes(c.adminToken, sizeof(c.adminToken));
  ok &= r.getBytes(c.deviceName, sizeof(c.deviceName));
  uint8_t scheduled = 0, autoApply = 0, provisioned = 0;
  ok &= r.getU16(c.collectorPort);
  ok &= r.getU8(c.captureMode);
  ok &= r.getU16(c.pingPps);
  ok &= r.getU16(c.pingPayloadBytes);
  ok &= r.getU16(c.pingTimeoutMs);
  ok &= r.getU32(c.pingWarmupMs);
  ok &= r.getU8(scheduled);
  ok &= r.getU32(c.otaScheduledIntervalS);
  ok &= r.getU8(autoApply);
  ok &= r.getU8(provisioned);
  if (!ok) {
    return false;
  }
  // Guarantee NUL termination of every string field regardless of stored bytes.
  c.wifiSsid[sizeof(c.wifiSsid) - 1] = 0;
  c.wifiPassword[sizeof(c.wifiPassword) - 1] = 0;
  c.otaManifestUrl[sizeof(c.otaManifestUrl) - 1] = 0;
  c.otaChannel[sizeof(c.otaChannel) - 1] = 0;
  c.collectorHost[sizeof(c.collectorHost) - 1] = 0;
  c.adminToken[sizeof(c.adminToken) - 1] = 0;
  c.deviceName[sizeof(c.deviceName) - 1] = 0;
  c.otaScheduledEnabled = scheduled != 0;
  c.otaAutoApply = autoApply != 0;
  c.provisioned = provisioned != 0;
  cfg = c;
  return true;
}

bool ConfigCodec::validate(const DeviceConfig& cfg, const char** errorOut) {
  auto fail = [&](const char* msg) {
    if (errorOut) *errorOut = msg;
    return false;
  };
  const std::size_t ssidLen = std::strlen(cfg.wifiSsid);
  if (ssidLen == 0 || ssidLen > 32) {
    return fail("wifiSsid must be 1-32 chars");
  }
  const std::size_t pwLen = std::strlen(cfg.wifiPassword);
  // WPA2-PSK is 8-63 chars; allow 0 for an open network.
  if (pwLen != 0 && (pwLen < 8 || pwLen > 63)) {
    return fail("wifiPassword must be empty or 8-63 chars");
  }
  if (cfg.collectorPort == 0) {
    return fail("collectorPort must be non-zero");
  }
  if (cfg.pingPps == 0 || cfg.pingPps > 200) {
    return fail("pingPps must be 1-200");
  }
  if (cfg.captureMode > 2) {
    return fail("captureMode must be 0-2");
  }
  const bool httpsOk = std::strncmp(cfg.otaManifestUrl, "https://", 8) == 0;
#if defined(CONFIG_RF_SENSE_OTA_ALLOW_INSECURE_HTTP)
  const bool httpOk = std::strncmp(cfg.otaManifestUrl, "http://", 7) == 0;
#else
  const bool httpOk = false;
#endif
  if (std::strlen(cfg.otaManifestUrl) != 0 && !httpsOk && !httpOk) {
    return fail("otaManifestUrl must be https://");
  }
  if (errorOut) *errorOut = nullptr;
  return true;
}

bool ConfigCodec::isComplete(const DeviceConfig& cfg) {
  return cfg.provisioned && std::strlen(cfg.wifiSsid) > 0;
}

}  // namespace rfsense
