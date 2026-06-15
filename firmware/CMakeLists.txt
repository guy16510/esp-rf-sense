# Top-level ESP-IDF project for esp32-rf-sense-lab firmware.
# Produces build/rf-sense.bin (the OTA application image).
cmake_minimum_required(VERSION 3.16)

# Single-source semantic version.
file(STRINGS "${CMAKE_CURRENT_LIST_DIR}/version.txt" RF_SENSE_VERSION LIMIT_COUNT 1)
string(STRIP "${RF_SENSE_VERSION}" RF_SENSE_VERSION)
set(PROJECT_VER "${RF_SENSE_VERSION}")

# Git commit (short). Falls back to env (CI sets RF_SENSE_GIT_COMMIT) then "unknown".
execute_process(
    COMMAND git rev-parse --short=8 HEAD
    WORKING_DIRECTORY "${CMAKE_CURRENT_LIST_DIR}"
    OUTPUT_VARIABLE RF_SENSE_GIT_COMMIT
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET
)
if(NOT RF_SENSE_GIT_COMMIT)
    if(DEFINED ENV{RF_SENSE_GIT_COMMIT})
        set(RF_SENSE_GIT_COMMIT "$ENV{RF_SENSE_GIT_COMMIT}")
    else()
        set(RF_SENSE_GIT_COMMIT "unknown")
    endif()
endif()

string(TIMESTAMP RF_SENSE_BUILD_TIMESTAMP "%Y-%m-%dT%H:%M:%SZ" UTC)

# Partition-table hash binds a build to the exact flash layout it was compiled against.
file(SHA256 "${CMAKE_CURRENT_LIST_DIR}/partitions.csv" RF_SENSE_PARTITION_TABLE_HASH)

# Expose to the main component (firmware/main/CMakeLists.txt).
set(RF_SENSE_VERSION "${RF_SENSE_VERSION}" CACHE INTERNAL "")
set(RF_SENSE_GIT_COMMIT "${RF_SENSE_GIT_COMMIT}" CACHE INTERNAL "")
set(RF_SENSE_BUILD_TIMESTAMP "${RF_SENSE_BUILD_TIMESTAMP}" CACHE INTERNAL "")
set(RF_SENSE_PARTITION_TABLE_HASH "${RF_SENSE_PARTITION_TABLE_HASH}" CACHE INTERNAL "")

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(rf-sense)

message(STATUS "rf-sense version ${RF_SENSE_VERSION} (commit ${RF_SENSE_GIT_COMMIT})")
message(STATUS "partition-table sha256 ${RF_SENSE_PARTITION_TABLE_HASH}")
