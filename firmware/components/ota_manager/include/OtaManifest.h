// OTA manifest model + validation. Pure C++ (no ESP-IDF) so the accept/reject decision and
// the semver comparison are unit-tested on the host. The only firmware-specific dependency
// is the JSON parser, kept in its own translation unit (parseManifest below uses cJSON).
//
// The manifest is downloaded and fully validated BEFORE any firmware bytes are fetched.
#pragma once

#include <cstddef>
#include <cstdint>

namespace rfsense {

// Parsed semantic version (MAJOR.MINOR.PATCH). Build metadata / prerelease tags are ignored
// for ordering; only the numeric triple decides "newer".
struct SemVer {
  uint32_t major = 0;
  uint32_t minor = 0;
  uint32_t patch = 0;
  bool valid = false;

  // -1 if *this < other, 0 if equal, +1 if greater. Invalid versions sort lowest.
  int compare(const SemVer& other) const;
  bool operator>(const SemVer& o) const { return compare(o) > 0; }
};

// Parses "1.2.3" (leading 'v' tolerated, trailing "-rc1"/"+meta" ignored). valid=false on junk.
SemVer parseSemVer(const char* s);

// Maximum string lengths we keep from a manifest (bounded, heap-free).
inline constexpr std::size_t kManifestUrlMax = 256;
inline constexpr std::size_t kManifestVersionMax = 32;
inline constexpr std::size_t kManifestShaHexLen = 64;  // SHA-256 hex

struct OtaManifest {
  uint32_t schemaVersion = 0;
  char project[32] = {0};
  char channel[16] = {0};
  char version[kManifestVersionMax] = {0};
  char buildId[40] = {0};
  char target[16] = {0};   // e.g. "esp32s3"
  char board[40] = {0};    // e.g. "esp32-s3-wroom-1-n4r8"
  uint32_t flashSizeBytes = 0;
  uint32_t appSizeBytes = 0;
  char sha256[kManifestShaHexLen + 1] = {0};  // lowercase hex, 64 chars
  char firmwareUrl[kManifestUrlMax] = {0};
  char releasedAt[32] = {0};
  char minimumCurrentVersion[kManifestVersionMax] = {0};
  bool mandatory = false;
};

// Everything validateManifest needs to know about *this* device and build.
struct ManifestContext {
  uint32_t supportedSchemaVersion = 1;
  const char* expectedProject = "rf-sense";
  const char* expectedTarget = "esp32s3";
  const char* expectedBoard = "esp32-s3-wroom-1-n4r8";
  uint32_t expectedFlashSizeBytes = 0;
  uint32_t otaSlotSizeBytes = 0;  // max bytes the inactive app slot can hold
  SemVer currentVersion{};
  bool allowInsecureHttp = false;
};

// Ordered so the first failing check wins; None means accept.
enum class ManifestReject {
  None = 0,
  SchemaUnsupported,
  WrongProject,
  WrongTarget,
  WrongBoard,
  WrongFlashLayout,
  BadVersion,
  NotNewer,
  BelowMinimum,
  ImageTooLarge,
  MissingSha,
  InsecureUrl,
};

const char* rejectReasonText(ManifestReject r);

// Pure decision: does this device accept this manifest? No I/O.
ManifestReject validateManifest(const OtaManifest& m, const ManifestContext& ctx);

// Parses a JSON manifest document into out. Returns true on success. Implemented with cJSON
// (firmware/host-test only; not used by the pure validation tests). Missing optional fields
// leave their defaults; missing required fields still parse but fail validateManifest.
bool parseManifest(const char* json, std::size_t len, OtaManifest& out);

}  // namespace rfsense
