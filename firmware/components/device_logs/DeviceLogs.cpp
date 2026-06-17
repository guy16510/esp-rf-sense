#include "DeviceLogs.h"

#include <cstring>

#include "esp_timer.h"

namespace rfsense {
namespace {
constexpr std::size_t kEntryCount = 96;
}  // namespace

DeviceLogs& DeviceLogs::instance() {
  static DeviceLogs logs;
  return logs;
}

void DeviceLogs::install() {
  portENTER_CRITICAL(&lock_);
  if (!installed_) {
    installed_ = true;
  }
  portEXIT_CRITICAL(&lock_);
  appendNow("device log buffer online");
}

void DeviceLogs::append(const char* line, uint32_t uptimeMs) {
  if (!line || line[0] == '\0') return;
  portENTER_CRITICAL(&lock_);
  DeviceLogEntry& entry = entries_[nextSequence_ % kEntryCount];
  entry.sequence = nextSequence_++;
  entry.uptimeMs = uptimeMs;
  std::strncpy(entry.line, line, sizeof(entry.line) - 1);
  entry.line[sizeof(entry.line) - 1] = '\0';
  portEXIT_CRITICAL(&lock_);
}

void DeviceLogs::appendNow(const char* line) {
  append(line, static_cast<uint32_t>(esp_timer_get_time() / 1000));
}

std::size_t DeviceLogs::readSince(
    uint32_t afterSequence, DeviceLogEntry* out, std::size_t capacity) const {
  if (!out || capacity == 0) return 0;
  portENTER_CRITICAL(&lock_);
  const uint32_t latest = nextSequence_ > 0 ? nextSequence_ - 1 : 0;
  uint32_t first = latest >= kEntryCount ? latest - static_cast<uint32_t>(kEntryCount) + 1 : 1;
  if (afterSequence >= first) first = afterSequence + 1;
  std::size_t count = 0;
  for (uint32_t seq = first; seq <= latest && count < capacity; ++seq) {
    const DeviceLogEntry& entry = entries_[seq % kEntryCount];
    if (entry.sequence == seq) out[count++] = entry;
  }
  portEXIT_CRITICAL(&lock_);
  return count;
}

uint32_t DeviceLogs::latestSequence() const {
  portENTER_CRITICAL(&lock_);
  const uint32_t latest = nextSequence_ > 0 ? nextSequence_ - 1 : 0;
  portEXIT_CRITICAL(&lock_);
  return latest;
}

uint32_t DeviceLogs::dropped() const {
  portENTER_CRITICAL(&lock_);
  const uint32_t dropped = dropped_;
  portEXIT_CRITICAL(&lock_);
  return dropped;
}

}  // namespace rfsense
