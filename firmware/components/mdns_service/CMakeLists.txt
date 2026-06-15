idf_component_register(
    SRCS "MdnsService.cpp"
    INCLUDE_DIRS "include"
    REQUIRES espressif__mdns
    PRIV_REQUIRES esp_common
)
