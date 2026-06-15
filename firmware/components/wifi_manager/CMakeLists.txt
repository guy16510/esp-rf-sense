idf_component_register(
    SRCS "WifiManager.cpp"
    INCLUDE_DIRS "include"
    REQUIRES esp_wifi esp_netif esp_event device_health
    PRIV_REQUIRES esp_common freertos
)
