#pragma once

#include <filesystem>
#include <chrono>

namespace spoon {
struct DesktopOptions {
    std::chrono::steady_clock::time_point started = std::chrono::steady_clock::now();
    std::filesystem::path data_directory;
    bool smoke = false;
    bool demo = false;
};

int run_desktop(const DesktopOptions& options);
}
