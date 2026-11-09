#include "spoon/application.hpp"
#include "spoon/storage.hpp"
#include <windows.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace {
void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}
template<class F> void rejects(F action, const char* message) {
    bool rejected = false;
    try { action(); } catch (const std::exception&) { rejected = true; }
    require(rejected, message);
}
struct Fixture {
    std::filesystem::path root = std::filesystem::temp_directory_path() /
        (L"spoon-cpp-app-tests-" + std::to_wstring(GetCurrentProcessId()) + L"-" + std::to_wstring(GetTickCount64()));
    Fixture() { std::filesystem::create_directories(root); }
    ~Fixture() { std::error_code error; std::filesystem::remove_all(root, error); }
};
}

int main() {
    try {
        Fixture fixture;
        const auto root = fixture.root;
        const spoon::Json original = {{"futureField", {{"preserved", true}}},
            {"settings", {{"volume", 0.4}, {"futureSetting", 17}}},
            {"manager", {{"preferences", {{"futurePreference", 23}}}, {"sessions", spoon::Json::array()}}}};
        spoon::write_json_atomic(root / L"state.json", original);
        {
            spoon::Application app(root);
            auto state = app.snapshot();
            require(state["futureField"]["preserved"] == true, "unknown root fields lost");
            require(state["settings"]["futureSetting"] == 17, "unknown settings lost");
            require(state["_native"]["receiving"] == false, "unexpected automatic live connection");
            rejects([&] { app.start_receiving(); }, "must require authorization before connecting");
            rejects([&] { app.configure({{"clientId", ""}}); }, "must reject invalid connection");
            require(!std::filesystem::exists(root / L"connection.json"), "invalid credentials persisted");
            rejects([&] { app.save_settings({{"volume", 4}}, spoon::Json::object()); }, "volume validation missing");
            rejects([&] { app.save_settings({{"engineUrl", "https://user:pass@example.com"}}, spoon::Json::object()); }, "credential-bearing engine URL accepted");
            app.save_settings({{"volume", 0.8}}, {{"heartGoal", 500}});
            state = app.snapshot();
            require(state["settings"]["volume"] == 0.8, "settings not changed");
            require(state["settings"]["futureSetting"] == 17, "settings patch removed unknown field");
            require(state["manager"]["preferences"]["futurePreference"] == 23, "preference patch removed unknown field");
            app.import_demo_events();
            const auto first = app.snapshot()["manager"]["sessions"][0]["totals"];
            app.import_demo_events();
            state = app.snapshot();
            require(state["manager"]["sessions"][0]["totals"] == first, "demo events duplicated counts");
            require(first["comments"] == 1 && first["hearts"] == 10 && first["spoons"] == 5, "demo pipeline aggregates incorrect");
            app.export_csv(root / L"participants.csv", "participants", "api:demo:1");
            app.export_csv(root / L"logs.csv", "logs", "api:demo:1");
            app.export_csv(root / L"analytics.csv", "analytics", "api:demo:1");
            require(std::filesystem::file_size(root / L"participants.csv") > 50, "participants CSV empty");
            rejects([&] { app.export_csv(root / L"invalid.csv", "credentials", "api:demo:1"); }, "unknown export permitted");
            app.stop_receiving(); app.stop_audio();
        }
        {
            spoon::Application reopened(root);
            require(reopened.snapshot()["manager"]["sessions"].size() == 1, "saved records not reloaded");
            require(reopened.snapshot()["settings"]["futureSetting"] == 17, "unknown setting lost after reload");
        }
        spoon::write_text_atomic(root / L"state.json", "secret-corrupt-payload");
        bool corrupt_rejected = false;
        try { spoon::Application app(root); }
        catch (const std::exception& error) {
            corrupt_rejected = true;
            require(std::string(error.what()).find("secret-corrupt-payload") == std::string::npos, "corrupt file content leaked");
        }
        require(corrupt_rejected, "corrupt storage was silently replaced");
        require(std::filesystem::file_size(root / L"state.json") == 22, "corrupt storage was overwritten");
        std::cout << "Application/storage integration checks passed (isolated data, no live API, no playback).\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL: " << error.what() << '\n'; return 1;
    }
}
