#pragma once
#include <nlohmann/json.hpp>
#include <stop_token>
#include <string>

namespace spoon {
const nlohmann::json& builtin_voice_manifest();
const nlohmann::json& builtin_voices();
bool builtin_voice_known(const nlohmann::json& id);
bool builtin_additional_terms_accepted(const nlohmann::json& settings);
bool builtin_voice_allowed(const nlohmann::json& id, const nlohmann::json& settings);
nlohmann::json builtin_available_voices(const nlohmann::json& settings);
bool builtin_terms_accepted(const nlohmann::json& settings);
std::string synthesize_builtin(const std::string& text, unsigned style, double speed,
                               std::stop_token stop = {});
}
