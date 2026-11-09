#include "spoon/web_bridge.hpp"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <atomic>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace {
using spoon::Json;

void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

template<class Action> void rejects(Action action, const char* message) {
    bool rejected = false;
    try { action(); }
    catch (const std::exception& error) {
        rejected = true;
        require(std::string(error.what()).find("bridge-test-secret") == std::string::npos,
                "Renderer input appeared in an error");
    }
    require(rejected, message);
}

struct Fixture {
    const std::filesystem::path parent = std::filesystem::temp_directory_path();
    const std::filesystem::path root = parent /
        (L"spoon-web-bridge-tests-" + std::to_wstring(GetCurrentProcessId()) + L"-" +
         std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(++sequence));
    static inline std::atomic<unsigned> sequence{0};

    Fixture() {
        require(std::filesystem::create_directory(root), "Unable to create isolated bridge test directory");
    }
    ~Fixture() {
        // Remove only this test's new direct child of the system temporary folder.
        std::error_code error;
        if (std::filesystem::equivalent(root.parent_path(), parent, error) && !error &&
            root.filename().wstring().starts_with(L"spoon-web-bridge-tests-")) {
            std::filesystem::remove_all(root, error);
        }
    }
};

Json read_json(const std::filesystem::path& file) {
    std::ifstream stream(file, std::ios::binary);
    require(static_cast<bool>(stream), "Expected persisted bridge data is missing");
    return Json::parse(stream);
}

void test_snapshot_and_allowlist() {
    Fixture fixture;
    spoon::Application application(fixture.root);
    spoon::WebBridge bridge(application);
    const auto state = bridge.dispatch("snapshot");
    require(state == application.snapshot(), "Snapshot was changed by the bridge");
    require(state["settings"].is_object() && state["manager"].is_object() && state["_native"].is_object(),
            "Raw native snapshot shape was lost");
    require(state["_native"]["receiving"] == false && state["_native"]["authorized"] == false,
            "Bridge started a live connection");
    require(bridge.dispatch("connection") == application.connection(), "Connection result was changed");
    require(bridge.dispatch("stop-receiving").is_null(), "Stop receiving must return null");
    require(bridge.dispatch("stop-audio").is_null(), "Stop audio must return null");

    for (const auto* operation : {"", "fetch", "request", "open-url", "read-file", "write-file",
                                 "GET_STATE", "import-demo", "bridge-test-secret"}) {
        rejects([&] { bridge.dispatch(operation); }, "Unsupported operation was accepted");
    }
    rejects([&] { bridge.dispatch("authorization-url"); }, "Consent must require configured credentials");
    rejects([&] { bridge.dispatch("start-receiving"); }, "Receiving must require configured authorization");
    rejects([&] { bridge.dispatch("send-chat", {{"text", "hello"}}); }, "Chat must require an active broadcast");
    require(!std::filesystem::exists(fixture.root / L"connection.json"), "Read operations wrote connection settings");
    require(!std::filesystem::exists(fixture.root / L"spoon" / L"tokens.json"), "Bridge wrote OAuth tokens");
}

void test_payload_validation() {
    Fixture fixture;
    spoon::Application application(fixture.root);
    spoon::WebBridge bridge(application);
    const auto original = bridge.dispatch("snapshot");
    for (const auto* operation : {"snapshot", "connection", "authorization-url", "start-receiving",
                                 "stop-receiving", "audio-devices", "test-voice", "diagnose-speech", "stop-audio"}) {
        for (const auto& bad : std::vector<Json>{nullptr, Json::array(), "bridge-test-secret", 7,
                                               Json{{"url", "https://bridge-test-secret.example"}}}) {
            rejects([&] { bridge.dispatch(operation, bad); }, "Operation accepted a malformed payload");
        }
    }
    for (const auto& bad : std::vector<Json>{Json::object(), Json{{"config", nullptr}},
             Json{{"config", Json::array()}}, Json{{"config", "bridge-test-secret"}},
             Json{{"config", Json::object()}, {"path", "bridge-test-secret"}},
             Json{{"clientId", "x"}, {"clientSecret", "bridge-test-secret"}}}) {
        rejects([&] { bridge.dispatch("configure", bad); }, "Malformed configure payload accepted");
    }
    rejects([&] { bridge.dispatch("configure", {{"config", Json::object()}}); }, "Invalid credentials accepted");
    for (const auto& bad : std::vector<Json>{Json::object(), Json{{"settings", Json::object()}},
             Json{{"preferences", Json::object()}}, Json{{"settings", nullptr}, {"preferences", Json::object()}},
             Json{{"settings", Json::object()}, {"preferences", Json::array()}},
             Json{{"settings", Json::object()}, {"preferences", Json::object()}, {"path", "bridge-test-secret"}}}) {
        rejects([&] { bridge.dispatch("save-settings", bad); }, "Malformed settings payload accepted");
    }
    rejects([&] { bridge.dispatch("save-settings", {{"settings", {{"volume", 5}}}, {"preferences", Json::object()}}); },
            "Invalid volume bypassed facade validation");
    for (const auto& bad : std::vector<Json>{Json::object(), Json{{"text", 9}}, Json{{"text", ""}},
             Json{{"text", " \r\n\t"}}, Json{{"text", std::string(801, 'x')}},
             Json{{"text", std::string("a\0b", 3)}}, Json{{"text", "hello"}, {"url", "bridge-test-secret"}}}) {
        rejects([&] { bridge.dispatch("send-chat", bad); }, "Malformed chat payload accepted");
    }
    require(bridge.dispatch("snapshot") == original, "Rejected payload changed application state");
    require(!std::filesystem::exists(fixture.root / L"connection.json"), "Rejected configure payload was saved");
    require(!std::filesystem::exists(fixture.root / L"state.json"), "Rejected settings payload was saved");
}

void test_speech_diagnostic() {
    Fixture fixture;
    spoon::Application application(fixture.root);
    spoon::WebBridge bridge(application);
    bridge.dispatch("save-settings", {{"settings", {{"provider", "legacy"}, {"apiKey", ""}}}, {"preferences", Json::object()}});
    const auto diagnostic = bridge.dispatch("diagnose-speech");
    require(diagnostic["ok"] == false && diagnostic["requests"].empty(), "Diagnostic reached an external API without a saved key");
    require(diagnostic["message"].is_string(), "Diagnostic response lost its explanation");
}

void test_settings_and_connection_persistence() {
    Fixture fixture;
    const Json config{{"clientId", "bridge-test-client"}, {"clientSecret", "bridge-test-secret"},
                      {"region", "jp"}, {"port", 17864}};
    {
        spoon::Application application(fixture.root);
        spoon::WebBridge bridge(application);
        require(bridge.dispatch("configure", {{"config", config}}).is_null(), "Configure must return null");
        require(bridge.dispatch("connection") == config, "Configure did not update the facade");
        require(read_json(fixture.root / L"connection.json") == config, "Connection was not persisted");

        const Json settings{{"volume", 0.6}, {"speed", 1.2}, {"enabled", false}, {"futureBridgeSetting", 17}};
        const Json preferences{{"heartGoal", 500}, {"futureBridgePreference", 23}};
        require(bridge.dispatch("save-settings", {{"settings", settings}, {"preferences", preferences}}).is_null(),
                "Save settings must return null");
        require(bridge.dispatch("save-settings", {{"settings", {{"volume", 0.8}}},
                                                  {"preferences", {{"heartGoal", 750}}}}).is_null(),
                "Settings patch must return null");
        const auto state = bridge.dispatch("snapshot");
        require(state["settings"]["volume"] == 0.8 && state["settings"]["speed"] == 1.2 &&
                state["settings"]["futureBridgeSetting"] == 17, "Settings patch lost existing values");
        require(state["manager"]["preferences"]["heartGoal"] == 750 &&
                state["manager"]["preferences"]["futureBridgePreference"] == 23, "Preferences patch lost existing values");
        const auto saved = read_json(fixture.root / L"state.json");
        require(saved["settings"] == state["settings"] && saved["manager"] == state["manager"],
                "Bridge settings and persisted state differ");
        require(!std::filesystem::exists(fixture.root / L"spoon" / L"tokens.json"), "Configure contacted OAuth");
    }
    {
        spoon::Application reopened(fixture.root);
        spoon::WebBridge bridge(reopened);
        require(bridge.dispatch("connection") == config, "Connection did not survive restart");
        const auto state = bridge.dispatch("snapshot");
        require(state["settings"]["volume"] == 0.8 && state["settings"]["futureBridgeSetting"] == 17,
                "Settings did not survive restart");
        require(state["manager"]["preferences"]["heartGoal"] == 750, "Preferences did not survive restart");
        require(state["_native"]["receiving"] == false && state["_native"]["authorized"] == false,
                "Restart unexpectedly connected to Spoon");
    }
}

void test_export_requires_host() {
    Fixture fixture;
    spoon::Application application(fixture.root);
    spoon::WebBridge bridge(application);
    const auto destination = fixture.root / L"renderer-must-not-create.csv";
    const auto before = bridge.dispatch("snapshot");
    for (const auto& input : std::vector<Json>{Json::object(),
             Json{{"kind", "analytics"}, {"sessionKey", ""}},
             Json{{"kind", "logs"}, {"sessionKey", "api:test:1"}, {"path", destination.string()}},
             Json{{"kind", "participants"}, {"sessionKey", "api:test:1"}, {"file", destination.string()}}}) {
        rejects([&] { bridge.dispatch("export-csv", input); }, "Renderer export bypassed the native save dialog");
    }
    require(!std::filesystem::exists(destination), "Renderer-controlled file was created");
    require(bridge.dispatch("snapshot") == before, "Rejected export changed application state");
}
}

int main() {
    const std::vector<std::pair<const char*, void(*)()>> tests{
        {"snapshot and operation allowlist", test_snapshot_and_allowlist},
        {"payload validation without side effects", test_payload_validation},
        {"settings and connection persistence", test_settings_and_connection_persistence},
        {"Native speech diagnostic", test_speech_diagnostic},
        {"CSV export requires trusted host", test_export_requires_host}
    };
    int failures = 0;
    for (const auto& [name, run] : tests) {
        try { run(); std::cout << "PASS " << name << '\n'; }
        catch (const std::exception& error) { ++failures; std::cerr << "FAIL " << name << ": " << error.what() << '\n'; }
        catch (...) { ++failures; std::cerr << "FAIL " << name << ": unexpected exception\n"; }
    }
    std::cout << tests.size() - failures << '/' << tests.size() << " web bridge tests passed\n";
    return failures == 0 ? 0 : 1;
}
