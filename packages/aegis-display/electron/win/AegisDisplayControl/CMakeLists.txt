# AegisDisplayControl — Windows virtual display control CLI
#
# Phase 3 scaffold (2026-05-14). Built by ../build.ps1, or standalone:
#   cmake -S . -B build -A x64
#   cmake --build build --config Release
#
# C++17, Win32 API only, no third-party dependencies.

cmake_minimum_required(VERSION 3.20)
project(AegisDisplayControl LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(AegisDisplayControl src/main.cpp)

if(MSVC)
  target_compile_options(AegisDisplayControl PRIVATE /W4 /permissive-)
  # Unicode Win32 APIs (CreateFileW, named pipes, etc.)
  target_compile_definitions(AegisDisplayControl PRIVATE UNICODE _UNICODE)
endif()

# Driver IPC (named pipe) uses only kernel32 — linked by default.
# user32 is needed for SetDisplayConfig/QueryDisplayConfig (primary monitor reassignment).
target_link_libraries(AegisDisplayControl PRIVATE user32)

