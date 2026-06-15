// JSON parsing for the OTA manifest, isolated from OtaManifest.cpp so the pure semver +
// validation logic stays free of cJSON and is unit-tested on the host with a plain compiler.
#include <cstring>

#include "OtaManifest.h"
#include "cJSON.h"

namespace rfsense {
namespace {

void copyField(char* dst, std::size_t cap, const char* src) {
  if (!src) {
    dst[0] = '\0';
    return;
  }
  std::strncpy(dst, src, cap - 1);
  dst[cap - 1] = '\0';
}

const char* jStr(const cJSON* obj, const char* key) {
  const cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
  return (item && cJSON_IsString(item)) ? item->valuestring : nullptr;
}

void jUint(const cJSON* obj, const char* key, uint32_t& out) {
  const cJSON* item = cJSON_GetObjectItemCaseSensitive(obj, key);
  if (item && cJSON_IsNumber(item) && item->valuedouble >= 0) {
    out = static_cast<uint32_t>(item->valuedouble);
  }
}

}  // namespace

bool parseManifest(const char* json, std::size_t len, OtaManifest& out) {
  cJSON* root = cJSON_ParseWithLength(json, len);
  if (!root) return false;

  out = OtaManifest{};
  jUint(root, "schemaVersion", out.schemaVersion);
  copyField(out.project, sizeof(out.project), jStr(root, "project"));
  copyField(out.channel, sizeof(out.channel), jStr(root, "channel"));
  copyField(out.version, sizeof(out.version), jStr(root, "version"));
  copyField(out.buildId, sizeof(out.buildId), jStr(root, "buildId"));
  copyField(out.target, sizeof(out.target), jStr(root, "target"));
  copyField(out.board, sizeof(out.board), jStr(root, "board"));
  jUint(root, "flashSizeBytes", out.flashSizeBytes);
  jUint(root, "appSizeBytes", out.appSizeBytes);
  copyField(out.sha256, sizeof(out.sha256), jStr(root, "sha256"));
  copyField(out.firmwareUrl, sizeof(out.firmwareUrl), jStr(root, "firmwareUrl"));
  copyField(out.releasedAt, sizeof(out.releasedAt), jStr(root, "releasedAt"));
  copyField(out.minimumCurrentVersion, sizeof(out.minimumCurrentVersion),
            jStr(root, "minimumCurrentVersion"));
  const cJSON* mandatory = cJSON_GetObjectItemCaseSensitive(root, "mandatory");
  out.mandatory = mandatory && cJSON_IsBool(mandatory) && cJSON_IsTrue(mandatory);

  cJSON_Delete(root);
  return true;
}

}  // namespace rfsense
