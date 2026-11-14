cmake_minimum_required(VERSION 3.25)
if(POLICY CMP0168)
    cmake_policy(SET CMP0168 NEW)
endif()
project(SpoonManager VERSION 2.9.0 LANGUAGES C CXX RC)

if(NOT WIN32)
    message(FATAL_ERROR "Spoon Manager requires Windows (WinHTTP and Windows audio).")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# Sources use headers rather than C++ modules; avoid unnecessary MSVC module scans.
set(CMAKE_CXX_SCAN_FOR_MODULES OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
if(MSVC AND CMAKE_GENERATOR MATCHES "Ninja")
    # Some installations have only Japanese compiler resources. Detect the actual
    # UTF-8 prefix instead of relying on a localized value decoded as ANSI by an
    # earlier CMake compiler probe; Ninja must match these bytes exactly.
    file(CONFIGURE OUTPUT "${CMAKE_BINARY_DIR}/include-probe.cpp"
        CONTENT "#include <stddef.h>\n" @ONLY)
    execute_process(COMMAND "${CMAKE_CXX_COMPILER}" /nologo /Zs /showIncludes /utf-8 /TP
        "${CMAKE_BINARY_DIR}/include-probe.cpp"
        OUTPUT_VARIABLE spoon_includes ERROR_VARIABLE spoon_include_errors
        RESULT_VARIABLE spoon_include_result ENCODING UTF-8)
    string(REGEX MATCH "(^|\n)([^\r\n]*: +)[^\r\n]*stddef\\.h" spoon_include_match "${spoon_includes}")
    if(NOT spoon_include_result EQUAL 0 OR NOT spoon_include_match)
        message(FATAL_ERROR "Cannot detect the MSVC include prefix: ${spoon_include_errors}")
    endif()
    set(CMAKE_CL_SHOWINCLUDES_PREFIX "${CMAKE_MATCH_2}")
endif()
include(FetchContent)
include(CTest)

# Pinned source archives and SDK, verified before extraction. No npm or Cargo.
set(JSON_BuildTests OFF CACHE BOOL "" FORCE)
FetchContent_Declare(nlohmann_json
    BINARY_DIR "${CMAKE_BINARY_DIR}/_deps/nlohmann_json-build"
    URL https://github.com/nlohmann/json/releases/download/v3.11.3/json.tar.xz
    URL_HASH SHA256=d6c65aca6b1ed68e7a182f4757257b107ae403032760ed6ef121c9d55e81757d)
set(HTTPLIB_USE_OPENSSL_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
set(HTTPLIB_USE_ZLIB_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
set(HTTPLIB_USE_BROTLI_IF_AVAILABLE OFF CACHE BOOL "" FORCE)
set(HTTPLIB_COMPILE OFF CACHE BOOL "" FORCE)
set(HTTPLIB_INSTALL OFF CACHE BOOL "" FORCE)
FetchContent_Declare(httplib
    BINARY_DIR "${CMAKE_BINARY_DIR}/_deps/httplib-build"
    URL https://codeload.github.com/yhirose/cpp-httplib/tar.gz/refs/tags/v0.18.3
    URL_HASH SHA256=a0567bcd6c3fe5cef1b329b96245119047f876b49e06cc129a36a7a8dffe173e)

FetchContent_MakeAvailable(nlohmann_json httplib)
include(cmake/WebView2.cmake)
include(cmake/Voicevox.cmake)

add_library(spoon-core STATIC
    native/src/model.cpp
    native/src/http.cpp
    native/src/spoon_client.cpp
    native/src/audio.cpp
    native/src/builtin_speech.cpp
    native/src/storage.cpp
    native/src/application.cpp
    native/src/participation.cpp
    native/src/web_bridge.cpp)
target_include_directories(spoon-core PUBLIC native/include)
target_include_directories(spoon-core PRIVATE "${CMAKE_BINARY_DIR}/generated"
    "${PROJECT_SOURCE_DIR}/.local/voicevox-cache/core/voicevox_core-windows-x64-0.17.1/include")
target_link_libraries(spoon-core PUBLIC nlohmann_json::nlohmann_json httplib::httplib
    winhttp bcrypt winmm mfplat mfreadwrite mfuuid propsys shlwapi ole32 ws2_32 crypt32 shell32 uuid)
target_compile_definitions(spoon-core PUBLIC UNICODE _UNICODE NOMINMAX WIN32_LEAN_AND_MEAN)
if(MSVC)
    target_compile_options(spoon-core PUBLIC /utf-8 /permissive- /Zc:__cplusplus)
    target_compile_options(spoon-core PRIVATE /W4 /EHsc)
endif()

configure_file(native/resources/app.rc.in "${CMAKE_BINARY_DIR}/app.rc" @ONLY)
add_executable(spoon-manager WIN32 native/src/main.cpp native/src/webview_host.cpp "${CMAKE_BINARY_DIR}/app.rc")
target_link_libraries(spoon-manager PRIVATE spoon-core WebView2::WebView2
    user32 gdi32 comdlg32 ole32 shlwapi version shell32 uuid advapi32 userenv oleaut32
    comctl32 dwmapi)
set_target_properties(spoon-manager PROPERTIES OUTPUT_NAME SpoonManager
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin/$<0:>")
# Track renderer outputs independently: HTML/JS edits must not relink the app.
file(GLOB_RECURSE spoon_ui_assets CONFIGURE_DEPENDS "${PROJECT_SOURCE_DIR}/desktop/renderer/*")
set(spoon_ui_manifest "")
set(spoon_ui_outputs "")
foreach(asset IN LISTS spoon_ui_assets)
    file(RELATIVE_PATH relative "${PROJECT_SOURCE_DIR}/desktop/renderer" "${asset}")
    string(APPEND spoon_ui_manifest "${relative}\n")
    list(APPEND spoon_ui_outputs "${CMAKE_BINARY_DIR}/bin/ui/${relative}")
endforeach()
file(CONFIGURE OUTPUT "${CMAKE_BINARY_DIR}/ui-inputs.txt" CONTENT "${spoon_ui_manifest}" @ONLY)
add_custom_command(OUTPUT "${CMAKE_BINARY_DIR}/ui.stamp"
    BYPRODUCTS ${spoon_ui_outputs} "${CMAKE_BINARY_DIR}/bin/ui/.spoon-assets.txt"
    COMMAND "${CMAKE_COMMAND}"
        "-DSOURCE=${PROJECT_SOURCE_DIR}/desktop/renderer"
        "-DDESTINATION=${CMAKE_BINARY_DIR}/bin/ui"
        "-DMANIFEST=${CMAKE_BINARY_DIR}/ui-inputs.txt"
        -P "${PROJECT_SOURCE_DIR}/cmake/SyncRenderer.cmake"
    COMMAND "${CMAKE_COMMAND}" -E touch "${CMAKE_BINARY_DIR}/ui.stamp"
    DEPENDS ${spoon_ui_assets} "${CMAKE_BINARY_DIR}/ui-inputs.txt"
        "${PROJECT_SOURCE_DIR}/cmake/SyncRenderer.cmake"
    COMMENT "Updating changed renderer assets"
    VERBATIM)
add_custom_target(spoon-ui ALL DEPENDS "${CMAKE_BINARY_DIR}/ui.stamp")
add_dependencies(spoon-manager spoon-ui)
add_dependencies(spoon-manager spoon-voicevox)

# Listener participation uses a pinned portable Cloudflare helper, started only
# when the user publishes a temporary URL. Fixed HTTPS reverse proxies also work.
set(spoon_tunnel_helper "${FETCHCONTENT_BASE_DIR}/cloudflared-2026.10.7.exe")
if(NOT EXISTS "${spoon_tunnel_helper}")
    file(DOWNLOAD https://github.com/cloudflare/cloudflared/releases/download/2026.10.7/cloudflared-windows-amd64.exe
        "${spoon_tunnel_helper}" EXPECTED_HASH SHA256=2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343
        TLS_VERIFY ON)
endif()
file(SHA256 "${spoon_tunnel_helper}" spoon_tunnel_hash)
if(NOT spoon_tunnel_hash STREQUAL "2493dbc168923bb3e59e5e7716f71deced92992eea9acd6e9d74f84ac7751343")
    message(FATAL_ERROR "Cloudflare helper checksum mismatch.")
endif()
set(spoon_tunnel_license "${FETCHCONTENT_BASE_DIR}/cloudflared-LICENSE.txt")
if(NOT EXISTS "${spoon_tunnel_license}")
    file(DOWNLOAD https://raw.githubusercontent.com/cloudflare/cloudflared/2026.10.7/LICENSE
        "${spoon_tunnel_license}" EXPECTED_HASH SHA256=58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd TLS_VERIFY ON)
endif()
file(SHA256 "${spoon_tunnel_license}" spoon_tunnel_license_hash)
if(NOT spoon_tunnel_license_hash STREQUAL "58d1e17ffe5109a7ae296caafcadfdbe6a7d176f0bc4ab01e12a689b0499d8bd")
    message(FATAL_ERROR "Cloudflare license checksum mismatch.")
endif()
add_custom_command(TARGET spoon-manager POST_BUILD COMMAND "${CMAKE_COMMAND}" -E copy_if_different
    "${spoon_tunnel_helper}" "$<TARGET_FILE_DIR:spoon-manager>/cloudflared.exe")

if(BUILD_TESTING)
    add_executable(spoon-builtin-tests native/tests/builtin_tests.cpp)
    target_link_libraries(spoon-builtin-tests PRIVATE spoon-core)
    set_target_properties(spoon-builtin-tests PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin/$<0:>")
    add_dependencies(spoon-builtin-tests spoon-voicevox)
    add_test(NAME native-builtin COMMAND spoon-builtin-tests)
    set_tests_properties(native-builtin PROPERTIES TIMEOUT 180)
    add_test(NAME native-renderer-assets COMMAND "${CMAKE_COMMAND}"
        "-DPROJECT_ROOT=${PROJECT_SOURCE_DIR}" "-DTEST_ROOT=${CMAKE_BINARY_DIR}/test-data"
        -P "${PROJECT_SOURCE_DIR}/native/tests/renderer_assets_test.cmake")
    foreach(suite IN ITEMS model network audio application features)
        add_executable(spoon-${suite}-tests native/tests/${suite}_tests.cpp)
        target_link_libraries(spoon-${suite}-tests PRIVATE spoon-core)
        target_compile_definitions(spoon-${suite}-tests PRIVATE SPOON_SOURCE_DIR="${PROJECT_SOURCE_DIR}")
        add_test(NAME native-${suite} COMMAND spoon-${suite}-tests)
        set_tests_properties(native-${suite} PROPERTIES TIMEOUT 60)
    endforeach()
    add_executable(spoon-web-bridge-tests native/tests/web_bridge_tests.cpp)
    target_link_libraries(spoon-web-bridge-tests PRIVATE spoon-core)
    add_test(NAME native-web-bridge COMMAND spoon-web-bridge-tests)
    set_tests_properties(native-web-bridge PROPERTIES TIMEOUT 60)
    add_test(NAME native-ui-smoke COMMAND spoon-manager --smoke
        --data-dir "${CMAKE_BINARY_DIR}/test-data/ui-smoke")
    set_tests_properties(native-ui-smoke PROPERTIES TIMEOUT 90 RUN_SERIAL TRUE)
endif()

install(TARGETS spoon-manager RUNTIME DESTINATION .)
install(FILES "${spoon_tunnel_helper}" DESTINATION . RENAME cloudflared.exe)
install(FILES "${spoon_tunnel_license}" DESTINATION licenses RENAME cloudflared.txt)
install(FILES LICENSE DESTINATION .)
install(DIRECTORY desktop/renderer/ DESTINATION ui)
install(FILES README.md FEATURES.md COMMANDS.md THIRD_PARTY_NOTICES.md DESTINATION documentation)
install(FILES native/README.md DESTINATION documentation RENAME Development.md)
install(FILES "${webview2_SOURCE_DIR}/LICENSE.txt" DESTINATION licenses RENAME WebView2.txt)
install(FILES "${webview2_SOURCE_DIR}/NOTICE.txt" DESTINATION licenses RENAME WebView2-NOTICE.txt)
install(FILES "${nlohmann_json_SOURCE_DIR}/LICENSE.MIT" DESTINATION licenses RENAME nlohmann-json.txt)
install(FILES "${httplib_SOURCE_DIR}/LICENSE" DESTINATION licenses RENAME cpp-httplib.txt)
file(GLOB spoon_redistribution_notices CONFIGURE_DEPENDS "${PROJECT_SOURCE_DIR}/licenses/*.txt" "${PROJECT_SOURCE_DIR}/licenses/*.json")
install(FILES ${spoon_redistribution_notices} DESTINATION licenses)
set(CMAKE_INSTALL_SYSTEM_RUNTIME_DESTINATION .)
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(CMAKE_INSTALL_DEBUG_LIBRARIES TRUE)
endif()
include(InstallRequiredSystemLibraries)

# Portable NSIS: build the installer without a machine-wide NSIS installation.
find_program(SPOON_MAKENSIS_EXECUTABLE makensis HINTS
    "$ENV{ProgramFiles\(x86\)}/NSIS" "$ENV{ProgramFiles}/NSIS")
if(NOT SPOON_MAKENSIS_EXECUTABLE)
    set(nsis_tools "${FETCHCONTENT_BASE_DIR}/nsis-tools")
    set(nsis_archive "${FETCHCONTENT_BASE_DIR}/nsis-3.11.zip")
    if(NOT EXISTS "${nsis_tools}/nsis-3.11/makensis.exe")
        file(DOWNLOAD
            "https://downloads.sourceforge.net/project/nsis/NSIS%203/3.11/nsis-3.11.zip"
            "${nsis_archive}"
            EXPECTED_HASH SHA256=c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1
            TLS_VERIFY ON SHOW_PROGRESS)
        file(ARCHIVE_EXTRACT INPUT "${nsis_archive}" DESTINATION "${nsis_tools}")
    endif()
    set(SPOON_MAKENSIS_EXECUTABLE "${nsis_tools}/nsis-3.11/makensis.exe")
endif()
set(spoon_installer_suffix "")
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    set(spoon_installer_suffix "-debug")
endif()
# Separate outputs keep one configuration from reusing another's cached Setup.
set(SPOON_INSTALLER_FILE "${PROJECT_SOURCE_DIR}/dist/installers/SpoonManager-${PROJECT_VERSION}-win64${spoon_installer_suffix}-Setup.exe")
configure_file(cmake/BuildInstaller.cmake.in "${CMAKE_BINARY_DIR}/BuildInstaller.cmake" @ONLY)
add_custom_command(OUTPUT "${SPOON_INSTALLER_FILE}"
    COMMAND "${CMAKE_COMMAND}" -P "${CMAKE_BINARY_DIR}/BuildInstaller.cmake"
    DEPENDS spoon-manager ${spoon_ui_assets} ${CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS}
        "${CMAKE_BINARY_DIR}/ui-inputs.txt"
        "${CMAKE_BINARY_DIR}/BuildInstaller.cmake"
        "${CMAKE_BINARY_DIR}/cmake_install.cmake"
        "${PROJECT_SOURCE_DIR}/installer/spoon-manager.nsi"
        "${PROJECT_SOURCE_DIR}/desktop/renderer/icons/reader.ico"
        "${PROJECT_SOURCE_DIR}/README.md" "${PROJECT_SOURCE_DIR}/FEATURES.md"
        "${PROJECT_SOURCE_DIR}/LICENSE" "${PROJECT_SOURCE_DIR}/THIRD_PARTY_NOTICES.md"
        "${PROJECT_SOURCE_DIR}/COMMANDS.md" "${PROJECT_SOURCE_DIR}/native/README.md"
        "${webview2_SOURCE_DIR}/LICENSE.txt" "${nlohmann_json_SOURCE_DIR}/LICENSE.MIT"
        "${webview2_SOURCE_DIR}/NOTICE.txt" "${httplib_SOURCE_DIR}/LICENSE"
        ${spoon_redistribution_notices} ${spoon_voicevox_sources}
    COMMENT "Building per-user NSIS installer (does not install the application)"
    VERBATIM)
add_custom_target(spoon-installer ALL DEPENDS "${SPOON_INSTALLER_FILE}")

# Build both release formats from the same clean, allowlisted install payload.
if(CMAKE_BUILD_TYPE STREQUAL "Release")
    set(SPOON_PORTABLE_NAME "SpoonManager-${PROJECT_VERSION}-win64")
    set(SPOON_PORTABLE_FILE "${PROJECT_SOURCE_DIR}/dist/releases/${SPOON_PORTABLE_NAME}.zip")
    configure_file(cmake/BuildPortable.cmake.in "${CMAKE_BINARY_DIR}/BuildPortable.cmake" @ONLY)
    add_custom_command(OUTPUT "${SPOON_PORTABLE_FILE}"
        COMMAND "${CMAKE_COMMAND}" -P "${CMAKE_BINARY_DIR}/BuildPortable.cmake"
        DEPENDS "${SPOON_INSTALLER_FILE}" "${CMAKE_BINARY_DIR}/BuildPortable.cmake"
        COMMENT "Packaging Release portable ZIP from the verified installer payload"
        VERBATIM)
    add_custom_target(spoon-release ALL DEPENDS "${SPOON_PORTABLE_FILE}")
    add_dependencies(spoon-release spoon-installer)
endif()

if(BUILD_TESTING)
    add_test(NAME native-installer COMMAND powershell -NoProfile -ExecutionPolicy Bypass
        -File "${PROJECT_SOURCE_DIR}/scripts/test-installer.ps1"
        -Installer "${SPOON_INSTALLER_FILE}"
        -Root "${CMAKE_BINARY_DIR}/test-data/installer")
    set_tests_properties(native-installer PROPERTIES TIMEOUT 270 RUN_SERIAL TRUE)
    # Exercise public Release artifacts even when the IDE currently selects Debug.
    add_test(NAME native-release-package COMMAND powershell -NoProfile -ExecutionPolicy Bypass
        -File "${PROJECT_SOURCE_DIR}/scripts/test-release.ps1"
        -ProjectRoot "${PROJECT_SOURCE_DIR}"
        -Root "${CMAKE_BINARY_DIR}/test-data/release-package")
    set_tests_properties(native-release-package PROPERTIES TIMEOUT 360 RUN_SERIAL TRUE SKIP_RETURN_CODE 77)
endif()

set(CPACK_GENERATOR ZIP)
set(CPACK_PACKAGE_FILE_NAME "SpoonManager-${PROJECT_VERSION}-win64")
include(CPack)
