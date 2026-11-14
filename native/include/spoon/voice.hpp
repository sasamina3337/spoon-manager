#pragma once

#include <nlohmann/json.hpp>
#include "spoon/builtin_speech.hpp"
#include <optional>
#include <regex>
#include <string>

namespace spoon {
// Keep the source in the persisted ID: VOICEVOX and the bridge reuse style IDs.
struct CoeiroinkVoice { std::string uuid, style; };
inline std::optional<CoeiroinkVoice> coeiroink_voice(const nlohmann::json& id) {
    if (!id.is_string()) return {};
    const auto& value = id.get_ref<const std::string&>();
    if (value.size() > 60) return {};
    static const std::regex pattern(R"(^coeiroink:([0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}):(0|[1-9][0-9]{0,9})$)");
    std::smatch match;
    if (!std::regex_match(value, match, pattern) || std::stoull(match[3].str()) > 2147483647ULL) return {};
    return CoeiroinkVoice{match[1].str(), match[3].str()};
}
inline bool voice_enabled(const nlohmann::json& id, const nlohmann::json& settings) {
    if (id.is_number_integer()) return id.get<double>() >= 0 && id.get<double>() <= 9'007'199'254'740'991.0 &&
        (settings.value("provider", std::string()) != "builtin" || builtin_voice_allowed(id, settings));
    return (settings.value("coeiroinkEnabled", false) || settings.value("coeiroinkDirectEnabled", false)) && coeiroink_voice(id).has_value();
}
}
