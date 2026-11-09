#include "spoon/application.hpp"
#include "spoon/storage.hpp"
#include "spoon/webview_host.hpp"
#include <windows.h>
#include <shellapi.h>
#include <filesystem>
#include <stdexcept>
#include <string>

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    spoon::DesktopOptions options;
    bool explicit_directory = false;
    try {
        int count = 0;
        LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &count);
        if (!arguments) throw std::runtime_error("コマンドラインを読み込めません。");
        struct Arguments { LPWSTR* value; ~Arguments() { LocalFree(value); } } cleanup{arguments};
        for (int i = 1; i < count; ++i) {
            const std::wstring argument(arguments[i]);
            if (argument == L"--smoke") options.smoke = true;
            else if (argument == L"--demo") options.demo = true;
            else if (argument == L"--data-dir" && i + 1 < count && arguments[i + 1][0]) {
                options.data_directory = arguments[++i];
                explicit_directory = true;
            } else throw std::runtime_error("未対応の起動引数です。");
        }
        if ((options.smoke || options.demo) && !explicit_directory)
            throw std::runtime_error("--smoke / --demo には隔離した --data-dir の指定が必要です。");
        if (!explicit_directory) options.data_directory = spoon::default_data_directory();
        options.data_directory = std::filesystem::absolute(options.data_directory);
        std::filesystem::create_directories(options.data_directory);
        return spoon::run_desktop(options);
    } catch (const std::exception& error) {
        if (options.smoke && explicit_directory) {
            try {
                spoon::write_json_atomic(options.data_directory / L"smoke-result.json",
                    {{"ok", false}, {"phase", "startup"}, {"error", error.what()}, {"networkActions", false}});
            } catch (...) {}
        } else {
            const std::string message(error.what());
            const int length = MultiByteToWideChar(CP_UTF8, 0, message.data(), static_cast<int>(message.size()), nullptr, 0);
            std::wstring wide(length, L'\0');
            MultiByteToWideChar(CP_UTF8, 0, message.data(), static_cast<int>(message.size()), wide.data(), length);
            MessageBoxW(nullptr, wide.c_str(), L"Spoon Manager", MB_OK | MB_ICONERROR);
        }
        return 1;
    }
}
