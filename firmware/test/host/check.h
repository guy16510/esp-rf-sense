// Tiny dependency-free assertion harness for the host unit tests. Each test file has its own
// main(): run CHECK(...) freely, then `return SUMMARY();` to exit non-zero on any failure.
#pragma once

#include <cstdio>

namespace hosttest {
inline int g_failures = 0;
inline int g_checks = 0;
}  // namespace hosttest

#define CHECK(cond)                                                          \
  do {                                                                       \
    ++hosttest::g_checks;                                                    \
    if (!(cond)) {                                                           \
      ++hosttest::g_failures;                                                \
      std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);          \
    }                                                                        \
  } while (0)

#define SUMMARY()                                                                       \
  (std::printf("%s: %d checks, %d failures\n", __FILE__, hosttest::g_checks,             \
               hosttest::g_failures),                                                    \
   hosttest::g_failures == 0 ? 0 : 1)
