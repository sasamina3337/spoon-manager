#pragma once

#include <filesystem>
#include <functional>
#include <memory>
#include <string>
#include <stop_token>
#include <nlohmann/json.hpp>

namespace spoon {
using Json = nlohmann::json;

// The UI only speaks to this facade. Network and audio work run off the UI thread.
class Application {
public:
    explicit Application(std::filesystem::path data_directory, std::string test_api_origin = {});
    ~Application();
    Application(const Application&) = delete;
    Application& operator=(const Application&) = delete;

    Json snapshot() const;
    Json connection() const;
    void configure(const Json& connection);
    void save_settings(const Json& settings, const Json& preferences);
    std::string authorization_url();
    void start_receiving();
    void stop_receiving();
    void send_chat(const std::string& text);
    void send_generated(const std::string& key, const std::string& text, const std::string& kind, const std::string& speech_kind);
    Json manager_action(const std::string& action, const std::string& key, const Json& payload);
    void save_runtime(const Json& runtime);
    Json voice_catalog();
    Json weather(const std::string& place, int day);
    Json participation(const std::string& action, const Json& input);
    void export_csv(const std::filesystem::path& file, const std::string& kind,
                    const std::string& session_key);
    Json audio_devices() const;
    void test_voice(std::stop_token stop = {});
    Json diagnose_speech(std::stop_token stop = {});
    void stop_audio();
    void set_status(const std::string& message);
    void import_demo_events(); // Explicit demo action; never called on ordinary startup.
    const std::filesystem::path& data_directory() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

std::filesystem::path default_data_directory();
}
