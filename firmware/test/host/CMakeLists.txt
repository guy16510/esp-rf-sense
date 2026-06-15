# Host (non-ESP-IDF) unit tests for the pure firmware logic. Build with a normal C++17
# toolchain on CI or a developer machine:
#
#   cmake -S firmware/test/host -B build/host-test
#   cmake --build build/host-test
#   ctest --test-dir build/host-test --output-on-failure
#
# These cover the dependency-free cores: protocol (de)serialization + CRC, config codec,
# OTA semver/validation, and the SPSC frame ring. ESP-IDF-bound logic (HTTPS OTA, NVS,
# Wi-Fi) is exercised separately on the IDF linux target / hardware.
cmake_minimum_required(VERSION 3.16)
project(rf_sense_host_tests CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
enable_testing()

set(COMPONENTS ${CMAKE_CURRENT_SOURCE_DIR}/../../components)

include_directories(
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${COMPONENTS}/protocol/include
    ${COMPONENTS}/config_store/include
    ${COMPONENTS}/ota_manager/include
    ${COMPONENTS}/frame_pipeline/include
)

add_compile_options(-Wall -Wextra -Werror)

function(add_host_test name)
    add_executable(${name} ${name}.cpp ${ARGN})
    add_test(NAME ${name} COMMAND ${name})
endfunction()

add_host_test(test_protocol      ${COMPONENTS}/protocol/Protocol.cpp)
add_host_test(test_config_codec  ${COMPONENTS}/protocol/Protocol.cpp
                                 ${COMPONENTS}/config_store/ConfigCodec.cpp)
add_host_test(test_ota_manifest  ${COMPONENTS}/ota_manager/OtaManifest.cpp)
add_host_test(test_frame_ring)
