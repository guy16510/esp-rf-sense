idf_component_register(
    SRCS "FrameQueue.cpp"
    INCLUDE_DIRS "include"
    REQUIRES protocol
    PRIV_REQUIRES esp_psram esp_common freertos
)
