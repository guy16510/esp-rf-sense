// Semantic version parsing/ordering and OTA manifest accept/reject decisions.
#include <cstring>

#include "OtaManifest.h"
#include "check.h"

using namespace rfsense;

namespace {
constexpr uint32_t kFlash = 4u * 1024u * 1024u;
constexpr uint32_t kSlot = 0x1f0000u;

OtaManifest goodManifest() {
  OtaManifest m{};
  m.schemaVersion = 1;
  std::strcpy(m.project, "rf-sense");
  std::strcpy(m.target, "esp32s3");
  std::strcpy(m.board, "esp32-s3-wroom-1-n4r8");
  m.flashSizeBytes = kFlash;
  m.appSizeBytes = 1'000'000;
  std::strcpy(m.version, "1.0.1");
  for (int i = 0; i < 64; ++i) m.sha256[i] = 'a';
  m.sha256[64] = '\0';
  std::strcpy(m.firmwareUrl, "https://ota.local/firmware/1.0.1/rf-sense.bin");
  return m;
}

ManifestContext baseCtx() {
  ManifestContext ctx;
  ctx.expectedFlashSizeBytes = kFlash;
  ctx.otaSlotSizeBytes = kSlot;
  ctx.currentVersion = parseSemVer("1.0.0");
  return ctx;
}
}  // namespace

int main() {
  // SemVer parsing + ordering.
  CHECK(parseSemVer("1.2.3").valid);
  CHECK(parseSemVer("v1.2.3").major == 1);
  CHECK(parseSemVer("2.0.0-rc1").valid);
  CHECK(parseSemVer("1.0.0+build7").valid);
  CHECK(!parseSemVer("1.2").valid);
  CHECK(!parseSemVer("abc").valid);
  CHECK(parseSemVer("1.2.3").compare(parseSemVer("1.2.4")) < 0);
  CHECK(parseSemVer("1.3.0") > parseSemVer("1.2.9"));
  CHECK(parseSemVer("2.0.0") > parseSemVer("1.99.99"));
  CHECK(parseSemVer("1.2.3").compare(parseSemVer("1.2.3")) == 0);

  const ManifestContext ctx = baseCtx();
  CHECK(validateManifest(goodManifest(), ctx) == ManifestReject::None);

  auto rej = [&](void (*mut)(OtaManifest&)) {
    OtaManifest m = goodManifest();
    mut(m);
    return validateManifest(m, ctx);
  };

  CHECK(rej([](OtaManifest& m) { m.schemaVersion = 2; }) == ManifestReject::SchemaUnsupported);
  CHECK(rej([](OtaManifest& m) { std::strcpy(m.project, "other"); }) == ManifestReject::WrongProject);
  CHECK(rej([](OtaManifest& m) { std::strcpy(m.target, "esp32"); }) == ManifestReject::WrongTarget);
  CHECK(rej([](OtaManifest& m) { std::strcpy(m.board, "nope"); }) == ManifestReject::WrongBoard);
  CHECK(rej([](OtaManifest& m) { m.flashSizeBytes = 8u * 1024 * 1024; }) ==
        ManifestReject::WrongFlashLayout);
  CHECK(rej([](OtaManifest& m) { std::strcpy(m.version, "notaversion"); }) ==
        ManifestReject::BadVersion);
  CHECK(rej([](OtaManifest& m) { m.appSizeBytes = kSlot + 1; }) == ManifestReject::ImageTooLarge);
  CHECK(rej([](OtaManifest& m) { m.appSizeBytes = 0; }) == ManifestReject::ImageTooLarge);
  CHECK(rej([](OtaManifest& m) { m.sha256[10] = '\0'; }) == ManifestReject::MissingSha);
  CHECK(rej([](OtaManifest& m) { m.sha256[0] = 'A'; }) == ManifestReject::MissingSha);  // uppercase
  CHECK(rej([](OtaManifest& m) { std::strcpy(m.firmwareUrl, "http://ota.local/fw.bin"); }) ==
        ManifestReject::InsecureUrl);

  // Not newer than the running version.
  {
    ManifestContext c2 = ctx;
    c2.currentVersion = parseSemVer("1.0.1");
    CHECK(validateManifest(goodManifest(), c2) == ManifestReject::NotNewer);
  }
  // Below the manifest's stated minimum current version.
  {
    OtaManifest m = goodManifest();
    std::strcpy(m.minimumCurrentVersion, "2.0.0");  // running is 1.0.0
    CHECK(validateManifest(m, ctx) == ManifestReject::BelowMinimum);
  }
  // Plain HTTP accepted only when explicitly allowed.
  {
    OtaManifest m = goodManifest();
    std::strcpy(m.firmwareUrl, "http://ota.local/fw.bin");
    ManifestContext c2 = ctx;
    c2.allowInsecureHttp = true;
    CHECK(validateManifest(m, c2) == ManifestReject::None);
  }

  return SUMMARY();
}
