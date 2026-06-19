idf_component_register(
    SRCS "IdentifyLed.cpp"
    INCLUDE_DIRS "include"
    PRIV_REQUIRES esp_common freertos driver led_strip
)
