#include "CsiMetadata.h"

#include "Protocol.h"

namespace rfsense::csi {

uint16_t linkIdForMac(const uint8_t mac[6]) {
  return static_cast<uint16_t>(proto::crc32(mac, 6) & 0xFFFFu);
}

uint8_t phyModeFromRx(uint8_t sigMode, uint8_t cwb, uint8_t rate) {
  // ESP-IDF rx_ctrl sig_mode: 0 = non-HT, 1 = HT. cwb: 0 = 20 MHz, 1 = 40 MHz.
  if (sigMode == 1) {
    return cwb == 1 ? kPhyHt40 : kPhyHt20;
  }
  return rate <= 3 ? kPhy11b : kPhy11g;
}

uint16_t clippedCsiLen(int len, uint16_t maxLen) {
  if (len <= 0) return 0;
  const auto n = static_cast<uint16_t>(len);
  return n > maxLen ? maxLen : n;
}

}  // namespace rfsense::csi
