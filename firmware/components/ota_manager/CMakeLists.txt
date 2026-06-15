idf_component_register(
    SRCS "OtaManifest.cpp" "OtaManifestJson.cpp" "BootGuard.cpp" "OtaManager.cpp"
    INCLUDE_DIRS "include"
    REQUIRES esp_https_ota json
    PRIV_REQUIRES esp_http_client app_update mbedtls esp-tls esp_common
                  nvs_flash device_health protocol config_store
    EMBED_TXTFILES "certs/ota_root_ca.pem"
)
