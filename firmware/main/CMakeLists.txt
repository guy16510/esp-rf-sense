idf_component_register(
    SRCS "app_main.cpp"
    INCLUDE_DIRS "."
    REQUIRES
        protocol
        config_store
        wifi_manager
        provisioning
        csi_capture
        ping_source
        frame_pipeline
        network_stream
        control_api
        ota_manager
        device_health
        mdns_service
        nvs_flash
        esp_event
        esp_timer
        esp_wifi
        esp_netif
        esp_hw_support
)

# Inject single-source build metadata (defined in firmware/CMakeLists.txt).
target_compile_definitions(${COMPONENT_LIB} PRIVATE
    RF_SENSE_VERSION="${RF_SENSE_VERSION}"
    RF_SENSE_GIT_COMMIT="${RF_SENSE_GIT_COMMIT}"
    RF_SENSE_BUILD_TIMESTAMP="${RF_SENSE_BUILD_TIMESTAMP}"
    RF_SENSE_PARTITION_TABLE_HASH="${RF_SENSE_PARTITION_TABLE_HASH}"
)
