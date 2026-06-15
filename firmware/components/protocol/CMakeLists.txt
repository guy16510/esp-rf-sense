# Pure, ESP-IDF-independent wire protocol. Also compiled by the host test harness.
idf_component_register(
    SRCS "Protocol.cpp"
    INCLUDE_DIRS "include"
)

# Treat as portable C++17; no warnings tolerated in the shared contract.
target_compile_options(${COMPONENT_LIB} PRIVATE -Wall -Wextra)
