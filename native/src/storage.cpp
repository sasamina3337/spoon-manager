#include "spoon/storage.hpp"
#include <windows.h>
#include <bcrypt.h>
#include <array>
#include <chrono>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>

namespace spoon {
nlohmann::json read_json(const std::filesystem::path& file, const nlohmann::json& fallback) {
    std::error_code error;
    if (!std::filesystem::exists(file, error) && !error) return fallback;
    std::ifstream input(file, std::ios::binary);
    if (!input) throw std::runtime_error("保存ファイルを読み込めません。アクセス権を確認してください。");
    try {
        return nlohmann::json::parse(input);
    } catch (const nlohmann::json::exception&) {
        throw std::runtime_error("保存データが壊れています。元のファイルは変更していません。");
    }
}

void write_text_atomic(const std::filesystem::path& file, const std::string& value) {
    if (!file.parent_path().empty()) std::filesystem::create_directories(file.parent_path());
    std::array<unsigned char, 8> random{};
    if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()),
                        BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
        throw std::runtime_error("保存用の一時ファイルを準備できません。");
    std::ostringstream suffix;
    for (auto byte : random) suffix << std::hex << std::setw(2) << std::setfill('0') << static_cast<int>(byte);
    auto temporary = file;
    temporary += L"." + std::filesystem::path(suffix.str()).wstring() + L".tmp";
    HANDLE handle = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                                 FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE) throw std::runtime_error("保存用の一時ファイルを作成できません。");
    bool closed = false;
    try {
        std::size_t offset = 0;
        while (offset < value.size()) {
            DWORD written = 0;
            const DWORD count = static_cast<DWORD>(std::min<std::size_t>(value.size() - offset, 1024 * 1024));
            if (!WriteFile(handle, value.data() + offset, count, &written, nullptr) || !written)
                throw std::runtime_error("保存できません。空き容量とアクセス権を確認してください。");
            offset += written;
        }
        if (!FlushFileBuffers(handle)) throw std::runtime_error("保存データを確定できません。");
        CloseHandle(handle);
        closed = true;
        if (!MoveFileExW(temporary.c_str(), file.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
            throw std::runtime_error("保存ファイルを置き換えられません。");
    } catch (...) {
        if (!closed) CloseHandle(handle);
        DeleteFileW(temporary.c_str());
        throw;
    }
}

void write_json_atomic(const std::filesystem::path& file, const nlohmann::json& value) {
    write_text_atomic(file, value.dump(2) + "\n");
}

std::string iso_now() {
    const auto now = std::chrono::system_clock::now();
    const auto time = std::chrono::system_clock::to_time_t(now);
    std::tm utc{};
    gmtime_s(&utc, &time);
    const auto millis = std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count() % 1000;
    std::ostringstream output;
    output << std::put_time(&utc, "%Y-%m-%dT%H:%M:%S") << '.' << std::setw(3) << std::setfill('0') << millis << 'Z';
    return output.str();
}
}
