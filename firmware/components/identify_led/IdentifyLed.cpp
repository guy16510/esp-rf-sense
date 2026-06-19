#include "IdentifyLed.h"

#include <algorithm>

#include "driver/gpio.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

#if defined(CONFIG_RF_SENSE_IDENTIFY_LED_TYPE_WS2812)
#include "led_strip.h"
#endif

namespace rfsense {
namespace {
constexpr char kTag[] = "identify_led";
constexpr uint32_t kMinDurationMs = 250;
constexpr uint32_t kMaxDurationMs = 30000;
constexpr uint32_t kBlinkPeriodMs = 250;

uint32_t boundedDuration(uint32_t durationMs) {
  return std::min(kMaxDurationMs, std::max(kMinDurationMs, durationMs));
}

struct IdentifyTaskArgs {
  uint32_t durationMs;
};

#if defined(CONFIG_RF_SENSE_IDENTIFY_LED_TYPE_GPIO)
void gpioIdentifyTask(void* ctx) {
  const uint32_t durationMs = static_cast<IdentifyTaskArgs*>(ctx)->durationMs;
  delete static_cast<IdentifyTaskArgs*>(ctx);
  const gpio_num_t pin = static_cast<gpio_num_t>(CONFIG_RF_SENSE_IDENTIFY_LED_GPIO);
  gpio_config_t config{};
  config.pin_bit_mask = 1ULL << CONFIG_RF_SENSE_IDENTIFY_LED_GPIO;
  config.mode = GPIO_MODE_OUTPUT;
  config.pull_up_en = GPIO_PULLUP_DISABLE;
  config.pull_down_en = GPIO_PULLDOWN_DISABLE;
  config.intr_type = GPIO_INTR_DISABLE;
  gpio_config(&config);
  const int on = CONFIG_RF_SENSE_IDENTIFY_LED_ACTIVE_HIGH ? 1 : 0;
  const int off = on ? 0 : 1;
  const TickType_t step = pdMS_TO_TICKS(kBlinkPeriodMs);
  const uint32_t cycles = std::max<uint32_t>(1, durationMs / kBlinkPeriodMs);
  for (uint32_t index = 0; index < cycles; ++index) {
    gpio_set_level(pin, (index % 2 == 0) ? on : off);
    vTaskDelay(step);
  }
  gpio_set_level(pin, off);
  vTaskDelete(nullptr);
}
#endif

#if defined(CONFIG_RF_SENSE_IDENTIFY_LED_TYPE_WS2812)
void ws2812IdentifyTask(void* ctx) {
  const uint32_t durationMs = static_cast<IdentifyTaskArgs*>(ctx)->durationMs;
  delete static_cast<IdentifyTaskArgs*>(ctx);

  led_strip_config_t stripConfig{};
  stripConfig.strip_gpio_num = CONFIG_RF_SENSE_IDENTIFY_LED_GPIO;
  stripConfig.max_leds = 1;
  stripConfig.led_pixel_format = LED_PIXEL_FORMAT_GRB;
  stripConfig.led_model = LED_MODEL_WS2812;

  led_strip_rmt_config_t rmtConfig{};
  rmtConfig.clk_src = RMT_CLK_SRC_DEFAULT;
  rmtConfig.resolution_hz = 10 * 1000 * 1000;
  rmtConfig.mem_block_symbols = 64;

  led_strip_handle_t strip = nullptr;
  esp_err_t err = led_strip_new_rmt_device(&stripConfig, &rmtConfig, &strip);
  if (err != ESP_OK) {
    ESP_LOGW(kTag, "led_strip init failed: %s", esp_err_to_name(err));
    vTaskDelete(nullptr);
    return;
  }

  const TickType_t step = pdMS_TO_TICKS(kBlinkPeriodMs);
  const uint32_t cycles = std::max<uint32_t>(1, durationMs / kBlinkPeriodMs);
  for (uint32_t index = 0; index < cycles; ++index) {
    if (index % 2 == 0) {
      led_strip_set_pixel(strip, 0, 0, 48, 255);
      led_strip_refresh(strip);
    } else {
      led_strip_clear(strip);
    }
    vTaskDelay(step);
  }
  led_strip_clear(strip);
  led_strip_del(strip);
  vTaskDelete(nullptr);
}
#endif

}  // namespace

IdentifyLed& IdentifyLed::instance() {
  static IdentifyLed led;
  return led;
}

IdentifyLedStatus IdentifyLed::status(uint32_t durationMs) const {
#if defined(CONFIG_RF_SENSE_IDENTIFY_LED_TYPE_GPIO) || defined(CONFIG_RF_SENSE_IDENTIFY_LED_TYPE_WS2812)
  return {
      true,
#if defined(CONFIG_RF_SENSE_IDENTIFY_LED_TYPE_WS2812)
      "ws2812",
#else
      "gpio",
#endif
      CONFIG_RF_SENSE_IDENTIFY_LED_GPIO,
      durationMs,
      "identify LED is configured",
  };
#else
  return {false, "none", -1, durationMs, "identify LED is not configured for this target"};
#endif
}

esp_err_t IdentifyLed::identify(uint32_t durationMs) {
  durationMs = boundedDuration(durationMs);
  const IdentifyLedStatus current = status(durationMs);
  if (!current.supported) return ESP_ERR_NOT_SUPPORTED;

  auto* args = new IdentifyTaskArgs{durationMs};
  if (!args) return ESP_ERR_NO_MEM;
#if defined(CONFIG_RF_SENSE_IDENTIFY_LED_TYPE_WS2812)
  const BaseType_t ok =
      xTaskCreate(ws2812IdentifyTask, "identify_led", 3072, args, tskIDLE_PRIORITY + 1, nullptr);
#elif defined(CONFIG_RF_SENSE_IDENTIFY_LED_TYPE_GPIO)
  const BaseType_t ok =
      xTaskCreate(gpioIdentifyTask, "identify_led", 2048, args, tskIDLE_PRIORITY + 1, nullptr);
#else
  const BaseType_t ok = pdFAIL;
#endif
  if (ok != pdPASS) {
    delete args;
    return ESP_ERR_NO_MEM;
  }
  return ESP_OK;
}

}  // namespace rfsense
