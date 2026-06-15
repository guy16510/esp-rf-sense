idf_component_register(
    SRCS "NetworkStreamer.cpp"
    INCLUDE_DIRS "include"
    REQUIRES protocol frame_pipeline
    PRIV_REQUIRES device_health lwip esp_psram freertos
)
