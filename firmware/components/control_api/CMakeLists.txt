idf_component_register(
    SRCS "ControlApi.cpp"
    INCLUDE_DIRS "include"
    REQUIRES esp_http_server json
    PRIV_REQUIRES config_store device_health ota_manager esp_common
)

target_compile_definitions(${COMPONENT_LIB} PRIVATE
    RF_SENSE_VERSION="${RF_SENSE_VERSION}"
    RF_SENSE_GIT_COMMIT="${RF_SENSE_GIT_COMMIT}"
    RF_SENSE_BUILD_TIMESTAMP="${RF_SENSE_BUILD_TIMESTAMP}"
    RF_SENSE_PARTITION_TABLE_HASH="${RF_SENSE_PARTITION_TABLE_HASH}"
)
