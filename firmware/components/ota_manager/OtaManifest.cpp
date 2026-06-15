#include "OtaManifest.h"

#include <cstdlib>
#include <cstring>

namespace rfsense {
namespace {

bool isHexLower(char c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
}

bool startsWith(const char* s, const char* prefix) {
  return std::strncmp(s, prefix, std::strlen(prefix)) == 0;
}

}  // namespace

int SemVer::compare(const SemVer& other) const {
  if (valid != other.valid) return valid ? 1 : -1;
  if (major != other.major) return major < other.major ? -1 : 1;
  if (minor != other.minor) return minor < other.minor ? -1 : 1;
  if (patch != other.patch) return patch < other.patch ? -1 : 1;
  return 0;
}

SemVer parseSemVer(const char* s) {
  SemVer v{};
  if (!s) return v;
  if (*s == 'v' || *s == 'V') ++s;

  char* end = nullptr;
  unsigned long major = std::strtoul(s, &end, 10);
  if (end == s || *end != '.') return v;
  s = end + 1;
  unsigned long minor = std::strtoul(s, &end, 10);
  if (end == s || *end != '.') return v;
  s = end + 1;
  unsigned long patch = std::strtoul(s, &end, 10);
  if (end == s) return v;
  // Anything after patch must be a separator we choose to ignore ('-', '+', or end).
  if (*end != '\0' && *end != '-' && *end != '+') return v;

  v.major = static_cast<uint32_t>(major);
  v.minor = static_cast<uint32_t>(minor);
  v.patch = static_cast<uint32_t>(patch);
  v.valid = true;
  return v;
}

const char* rejectReasonText(ManifestReject r) {
  switch (r) {
    case ManifestReject::None: return "accepted";
    case ManifestReject::SchemaUnsupported: return "unsupported schema version";
    case ManifestReject::WrongProject: return "project mismatch";
    case ManifestReject::WrongTarget: return "target mismatch";
    case ManifestReject::WrongBoard: return "board mismatch";
    case ManifestReject::WrongFlashLayout: return "flash size mismatch";
    case ManifestReject::BadVersion: return "unparseable version";
    case ManifestReject::NotNewer: return "version not newer than running";
    case ManifestReject::BelowMinimum: return "running version below manifest minimum";
    case ManifestReject::ImageTooLarge: return "image too large for OTA slot";
    case ManifestReject::MissingSha: return "missing or malformed sha256";
    case ManifestReject::InsecureUrl: return "insecure firmware url";
  }
  return "unknown";
}

ManifestReject validateManifest(const OtaManifest& m, const ManifestContext& ctx) {
  if (m.schemaVersion != ctx.supportedSchemaVersion) return ManifestReject::SchemaUnsupported;
  if (std::strcmp(m.project, ctx.expectedProject) != 0) return ManifestReject::WrongProject;
  if (std::strcmp(m.target, ctx.expectedTarget) != 0) return ManifestReject::WrongTarget;
  if (std::strcmp(m.board, ctx.expectedBoard) != 0) return ManifestReject::WrongBoard;
  if (ctx.expectedFlashSizeBytes != 0 && m.flashSizeBytes != ctx.expectedFlashSizeBytes) {
    return ManifestReject::WrongFlashLayout;
  }

  const SemVer candidate = parseSemVer(m.version);
  if (!candidate.valid) return ManifestReject::BadVersion;
  if (!(candidate > ctx.currentVersion)) return ManifestReject::NotNewer;

  if (m.minimumCurrentVersion[0] != '\0') {
    const SemVer minReq = parseSemVer(m.minimumCurrentVersion);
    if (minReq.valid && ctx.currentVersion.compare(minReq) < 0) return ManifestReject::BelowMinimum;
  }

  // SHA must be exactly 64 lowercase hex chars.
  if (std::strlen(m.sha256) != kManifestShaHexLen) return ManifestReject::MissingSha;
  for (std::size_t i = 0; i < kManifestShaHexLen; ++i) {
    if (!isHexLower(m.sha256[i])) return ManifestReject::MissingSha;
  }

  if (m.appSizeBytes == 0 || (ctx.otaSlotSizeBytes != 0 && m.appSizeBytes > ctx.otaSlotSizeBytes)) {
    return ManifestReject::ImageTooLarge;
  }

  const bool https = startsWith(m.firmwareUrl, "https://");
  const bool http = startsWith(m.firmwareUrl, "http://");
  if (!https && !(http && ctx.allowInsecureHttp)) return ManifestReject::InsecureUrl;

  return ManifestReject::None;
}

}  // namespace rfsense
