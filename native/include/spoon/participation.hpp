#pragma once
#include <filesystem>
#include <memory>
#include <nlohmann/json.hpp>

namespace spoon {
// A separate, capability-scoped listener server. It never exposes the desktop
// bridge, credentials, filesystem paths, or management API operations.
class Participation {
public:
    Participation(std::filesystem::path assets, std::filesystem::path helper, std::filesystem::path data);
    ~Participation();
    nlohmann::json action(const std::string& action, const nlohmann::json& input);
    void stop();
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
