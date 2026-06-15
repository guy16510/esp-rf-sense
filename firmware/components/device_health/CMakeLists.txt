idf_component_register(
    SRCS "DeviceHealth.cpp"
    INCLUDE_DIRS "include"
    REQUIRES esp_timer
    PRIV_REQUIRES esp_system esp_hw_support
)
