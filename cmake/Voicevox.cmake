# Reviewed, pinned CPU-only runtime. No GPU driver or external VOICEVOX app.
set(spoon_voicevox_root "${PROJECT_SOURCE_DIR}/.local/voicevox")
set(spoon_voicevox_manifest "${PROJECT_SOURCE_DIR}/licenses/voicevox-manifest.json")
file(READ "${spoon_voicevox_manifest}" spoon_builtin_catalog)
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${spoon_voicevox_manifest}")
string(JSON spoon_vvm_count LENGTH "${spoon_builtin_catalog}" models)
math(EXPR spoon_vvm_last "${spoon_vvm_count} - 1")
if(NOT EXISTS "${spoon_voicevox_root}/catalog.json")
    execute_process(COMMAND powershell -NoProfile -ExecutionPolicy Bypass -File
        "${PROJECT_SOURCE_DIR}/scripts/prepare-voicevox.ps1" RESULT_VARIABLE spoon_voicevox_result)
    if(NOT spoon_voicevox_result EQUAL 0)
        message(FATAL_ERROR "Unable to prepare VOICEVOX. Run scripts/prepare-voicevox.ps1 and retry.")
    endif()
endif()
set(spoon_voicevox_files runtime/voicevox_core.dll runtime/voicevox_onnxruntime.dll
    licenses/CORE-LICENSE.txt licenses/ONNX-TERMS.txt licenses/ONNX-third-party-notices.html
    licenses/OpenJTalk-dictionary-COPYING.txt)
foreach(index RANGE ${spoon_vvm_last})
    string(JSON name GET "${spoon_builtin_catalog}" models ${index} name)
    string(JSON expected_hash GET "${spoon_builtin_catalog}" models ${index} sha256)
    if(name MATCHES "\\.vvm$")
        set(relative "models/${name}")
    else()
        set(relative "licenses/${name}")
    endif()
    if(NOT EXISTS "${spoon_voicevox_root}/${relative}")
        message(FATAL_ERROR "Missing reviewed VOICEVOX file ${relative}; run scripts/prepare-voicevox.ps1.")
    endif()
    file(SHA256 "${spoon_voicevox_root}/${relative}" actual_hash)
    if(NOT actual_hash STREQUAL expected_hash)
        message(FATAL_ERROR "VOICEVOX checksum mismatch: ${relative}")
    endif()
    list(APPEND spoon_voicevox_files "${relative}")
endforeach()
foreach(name IN ITEMS char.bin COPYING left-id.def matrix.bin pos-id.def rewrite.def right-id.def sys.dic unk.dic)
    list(APPEND spoon_voicevox_files "open_jtalk_dic_utf_8-1.11/${name}")
endforeach()
file(MAKE_DIRECTORY "${CMAKE_BINARY_DIR}/generated")
# MSVC 2019 limits each string literal to 16 KiB. Keep the manifest bytes
# unchanged while emitting one adjacent raw string literal per JSON line.
string(REPLACE "\n" ")spoon\" \"\\n\"\nR\"spoon(" spoon_builtin_catalog_cpp "${spoon_builtin_catalog}")
configure_file("${PROJECT_SOURCE_DIR}/native/resources/builtin_catalog.hpp.in"
    "${CMAKE_BINARY_DIR}/generated/builtin_catalog.hpp" @ONLY)
set(spoon_voicevox_sources "${spoon_voicevox_manifest}" "${PROJECT_SOURCE_DIR}/licenses/VOICEVOX-MODEL-REVIEW.md")
set(spoon_voicevox_copy_commands "")
foreach(relative IN LISTS spoon_voicevox_files)
    if(NOT EXISTS "${spoon_voicevox_root}/${relative}")
        message(FATAL_ERROR "Missing VOICEVOX dependency: ${relative}")
    endif()
    get_filename_component(parent "${relative}" DIRECTORY)
    list(APPEND spoon_voicevox_sources "${spoon_voicevox_root}/${relative}")
    list(APPEND spoon_voicevox_copy_commands COMMAND "${CMAKE_COMMAND}" -E make_directory "${CMAKE_BINARY_DIR}/bin/voicevox/${parent}"
        COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${spoon_voicevox_root}/${relative}" "${CMAKE_BINARY_DIR}/bin/voicevox/${relative}")
    install(FILES "${spoon_voicevox_root}/${relative}" DESTINATION "voicevox/${parent}")
endforeach()
add_custom_command(OUTPUT "${CMAKE_BINARY_DIR}/voicevox.stamp"
    ${spoon_voicevox_copy_commands}
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${spoon_voicevox_manifest}" "${CMAKE_BINARY_DIR}/bin/voicevox/catalog.json"
    COMMAND "${CMAKE_COMMAND}" -E copy_if_different "${PROJECT_SOURCE_DIR}/licenses/VOICEVOX-MODEL-REVIEW.md" "${CMAKE_BINARY_DIR}/bin/voicevox/licenses/VOICEVOX-MODEL-REVIEW.md"
    COMMAND "${CMAKE_COMMAND}" -E touch "${CMAKE_BINARY_DIR}/voicevox.stamp"
    DEPENDS ${spoon_voicevox_sources} "${PROJECT_SOURCE_DIR}/cmake/Voicevox.cmake"
    COMMENT "Staging verified VOICEVOX runtime, models and licenses" VERBATIM)
add_custom_target(spoon-voicevox ALL DEPENDS "${CMAKE_BINARY_DIR}/voicevox.stamp")
install(FILES "${spoon_voicevox_manifest}" DESTINATION voicevox RENAME catalog.json)
install(FILES "${PROJECT_SOURCE_DIR}/licenses/VOICEVOX-MODEL-REVIEW.md" DESTINATION voicevox/licenses)
