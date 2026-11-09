#pragma once
#include <filesystem>
#include <string>
#include <nlohmann/json.hpp>

namespace spoon {
nlohmann::json read_json(const std::filesystem::path& file,
                         const nlohmann::json& fallback = nlohmann::json::object());
void write_json_atomic(const std::filesystem::path& file, const nlohmann::json& value);
void write_text_atomic(const std::filesystem::path& file, const std::string& value);
std::string iso_now();
}
