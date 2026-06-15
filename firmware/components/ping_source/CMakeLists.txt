idf_component_register(
    SRCS "PingSource.cpp"
    INCLUDE_DIRS "include"
    REQUIRES esp_netif
    PRIV_REQUIRES lwip device_health esp_common
)
