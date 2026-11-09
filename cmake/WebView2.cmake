# Official stable Microsoft NuGet SDK. This embeds the x64 loader, not the browser
# runtime; Evergreen must already be installed on development and client machines.
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8 OR CMAKE_GENERATOR_PLATFORM MATCHES "[Aa][Rr][Mm]"
    OR CMAKE_CXX_COMPILER_ARCHITECTURE_ID MATCHES "[Aa][Rr][Mm]")
    message(FATAL_ERROR "Spoon Manager requires an x64 toolchain for the WebView2 static loader.")
endif()

set(SPOON_WEBVIEW2_VERSION "1.0.4314.35")
set(SPOON_WEBVIEW2_SHA256 "90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4")
FetchContent_Declare(webview2
    BINARY_DIR "${CMAKE_BINARY_DIR}/_deps/webview2-build"
    URL "https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/${SPOON_WEBVIEW2_VERSION}/microsoft.web.webview2.${SPOON_WEBVIEW2_VERSION}.nupkg"
    DOWNLOAD_NAME "Microsoft.Web.WebView2.${SPOON_WEBVIEW2_VERSION}.zip"
    URL_HASH "SHA256=${SPOON_WEBVIEW2_SHA256}"
    TLS_VERIFY ON)
FetchContent_MakeAvailable(webview2)

set(webview2_include "${webview2_SOURCE_DIR}/build/native/include")
set(webview2_loader "${webview2_SOURCE_DIR}/build/native/x64/WebView2LoaderStatic.lib")
if(NOT EXISTS "${webview2_include}/WebView2.h" OR NOT EXISTS "${webview2_loader}"
    OR NOT EXISTS "${webview2_SOURCE_DIR}/LICENSE.txt")
    message(FATAL_ERROR "The pinned WebView2 SDK is incomplete: ${webview2_SOURCE_DIR}")
endif()
add_library(WebView2::WebView2 STATIC IMPORTED GLOBAL)
set_target_properties(WebView2::WebView2 PROPERTIES
    IMPORTED_LOCATION "${webview2_loader}"
    INTERFACE_INCLUDE_DIRECTORIES "${webview2_include}"
    INTERFACE_LINK_LIBRARIES "user32;ole32;shlwapi;version;advapi32;userenv;oleaut32")
message(STATUS "WebView2 SDK: ${SPOON_WEBVIEW2_VERSION} (SHA256=${SPOON_WEBVIEW2_SHA256})")
message(STATUS "WebView2 x64 static loader: ${webview2_loader}")
