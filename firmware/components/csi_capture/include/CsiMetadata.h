// Pure metadata helpers for Espressif CSI frames.
//
// This file intentionally has no ESP-IDF includes so the CSI adapter behavior can be
// unit-tested on the host. The ESP-IDF callback adapter is the only layer that knows
// about wifi_csi_info_t / wifi_pkt_rx_ctrl_t.
#pragma once

#include <cstdint>

namespace rfsense::csi {

// Stable compact phy codes used by the RFCS binary protocol.
inline constexpr uint8_t kPhy11b = 0;
inline constexpr uint8_t kPhy11g = 1;
inline constexpr uint8_t kPhyHt20 = 2;
inline constexpr uint8_t kPhyHt40 = 3;

// Link id for a 6-byte BSSID/MAC: low 16 bits of IEEE CRC32. This lets the
// collector align all receivers on the same transmitter without storing raw MACs.
uint16_t linkIdForMac(const uint8_t mac[6]);

// Convert ESP-IDF rx_ctrl fields into the protocol phyMode code.
uint8_t phyModeFromRx(uint8_t sigMode, uint8_t cwb, uint8_t rate);

// Clip CSI payloads to the on-wire protocol maximum instead of trusting the driver.
uint16_t clippedCsiLen(int len, uint16_t maxLen);

}  // namespace rfsense::csi
