idf_component_register(
    SRCS "ConfigStore.cpp" "ConfigCodec.cpp"
    INCLUDE_DIRS "include"
    REQUIRES protocol nvs_flash
    PRIV_REQUIRES esp_common
)
