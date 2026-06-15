idf_component_register(
    SRCS "Provisioning.cpp"
    INCLUDE_DIRS "include"
    REQUIRES esp_http_server
    PRIV_REQUIRES config_store wifi_manager esp_common
)
