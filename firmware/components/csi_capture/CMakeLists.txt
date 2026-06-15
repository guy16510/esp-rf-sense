idf_component_register(
    SRCS "CsiCapture.cpp"
    INCLUDE_DIRS "include"
    REQUIRES protocol frame_pipeline esp_wifi
    PRIV_REQUIRES device_health esp_timer esp_common
)
