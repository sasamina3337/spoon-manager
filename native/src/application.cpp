#include "spoon/application.hpp"
#include "spoon/audio.hpp"
#include "spoon/model.hpp"
#include "spoon/spoon_client.hpp"
#include "spoon/storage.hpp"
#include "spoon/participation.hpp"
#include <windows.h>
#include <shlobj.h>
#include <shellapi.h>
#include <winhttp.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <set>
#include <stdexcept>
#include <thread>
#include <tuple>

namespace spoon {
namespace {
using namespace std::chrono_literals;

Json default_settings() {
    return {{"schemaVersion", 1}, {"provider", "engine"}, {"apiKey", ""},
        {"engineUrl", "http://127.0.0.1:50021"}, {"systemSpeaker", 3},
        {"commentSpeakers", Json::array({0, 2, 8, 10})}, {"speed", 1.0}, {"volume", 1.0},
        {"outputDeviceId", ""}, {"outputDeviceLabel", ""}, {"enabled", false},
        {"readNames", false}, {"eventEnabled", {{"comment", true}, {"entry", true},
            {"heart", true}, {"spoon", true}, {"follow", true}}}};
}

std::string text(const Json& value, const char* key, const std::string& fallback = "") {
    const auto it = value.is_object() ? value.find(key) : value.end();
    return it != value.end() && it->is_string() ? it->get<std::string>() : fallback;
}

bool wait_for(std::stop_token stop, std::chrono::milliseconds duration) {
    std::mutex mutex;
    std::condition_variable_any condition;
    std::unique_lock lock(mutex);
    condition.wait_for(lock, stop, duration, [] { return false; });
    return !stop.stop_requested();
}

Json api_user(const Json& raw, const std::string& owner) {
    if (!raw.is_object() || !raw.contains("id") || !raw["id"].is_string()) return nullptr;
    if (raw["id"].get_ref<const std::string&>().empty()) return nullptr;
    Json user = {{"id", "api:" + owner + ":" + raw["id"].get<std::string>()},
                 {"name", text(raw, "nickname", "匿名")}};
    if (raw.contains("subscription")) user["subscription"] = raw["subscription"];
    return user;
}

Json api_event(const SseFrame& frame, const std::string& owner) {
    if (frame.id.empty()) return nullptr;
    auto input = Json::parse(frame.data, nullptr, false);
    if (input.is_discarded() || !input.is_object()) return nullptr;
    auto user = api_user(input.value("user", Json()), owner);
    if (user.is_null()) return nullptr;
    Json event = {{"id", "api:" + frame.id}, {"user", user},
        {"time", text(input, "sentTime", text(input, "time", iso_now()))},
        {"isDj", input.value("isDj", false)}};
    const auto name = text(user, "name");
    if (frame.event == "chat" && input.contains("message") && input["message"].is_string()) {
        event["type"] = "comment"; event["text"] = input["message"];
    } else if (frame.event == "presence" && text(input, "type") == "JOIN") {
        event["type"] = "entry"; event["text"] = name + "さんが入室しました。";
    } else if (frame.event == "like" || frame.event == "donation") {
        const auto field = frame.event == "like" ? "totalAmount" : "amount";
        if (!input.contains(field) || !input[field].is_number() || input[field].get<double>() < 0) return nullptr;
        event["amount"] = input[field];
        event["type"] = frame.event == "like" ? "heart" : "spoon";
        event["text"] = frame.event == "like" && input[field] == 0
            ? name + "さんが心ばかりの粗品を送りました。"
            : name + "さんが" + input[field].dump() + (frame.event == "like" ? "ハート" : "スプーン") + "送りました。";
    } else if (frame.event == "follow") {
        event["type"] = "follow"; event["text"] = name + "さんがフォローしました。";
    } else return nullptr;
    return event;
}

void validate_settings(const Json& settings) {
    if (!settings.is_object()) throw std::runtime_error("設定の形式を確認してください。");
    const auto provider = text(settings, "provider", "engine");
    if (provider != "engine" && provider != "legacy") throw std::runtime_error("未対応の音声APIです。");
    for (const auto& [name, low, high] : {std::tuple{"speed", 0.5, 2.0}, std::tuple{"volume", 0.0, 1.0}}) {
        if (settings.contains(name) && (!settings[name].is_number() ||
            settings[name].get<double>() < low || settings[name].get<double>() > high))
            throw std::runtime_error("速度は0.5〜2、音量は0〜1で指定してください。");
    }
    const auto url = text(settings, "engineUrl", "http://127.0.0.1:50021");
    if ((!url.starts_with("http://") && !url.starts_with("https://")) ||
        url.find_first_of("?#@\r\n\\") != std::string::npos)
        throw std::runtime_error("VOICEVOXのURLは認証情報・クエリを含まないhttp/httpsで指定してください。");
}
}

struct Application::Impl {
    std::filesystem::path root;
    mutable std::mutex mutex;
    std::mutex lifecycle;
    Model model;
    Json config;
    std::string test_origin;
    std::shared_ptr<SpoonClient> client;
    Audio audio;
    std::unique_ptr<Participation> participation;
    std::jthread receiver;
    std::jthread speaker;
    std::condition_variable_any speech_ready;
    struct Utterance { std::string text; Json settings; std::uint64_t generation; std::stop_token cancel; };
    std::deque<Utterance> speech;
    std::stop_source speech_cancel;
    std::uint64_t generation = 0;
    std::string message = "受信停止中";
    std::string connection_state = "stopped", last_activity, last_event, receive_error, audio_error;
    Json current_listeners = Json::array();
    std::string active_key;
    bool receiving = false;
    std::uint64_t authorization_completed = 0;

    explicit Impl(std::filesystem::path directory, std::string api_origin)
        : root(std::move(directory)), model(read_json(root / L"state.json")),
          config(read_json(root / L"connection.json")), test_origin(std::move(api_origin)) {
        if (!test_origin.empty() && !is_loopback_origin(test_origin)) throw std::invalid_argument("Test API origin must be loopback.");
        const auto saved = model.snapshot();
        auto settings = default_settings();
        if (saved.contains("settings") && saved["settings"].is_object()) settings.update(saved["settings"]);
        model.set_settings(settings);
        std::wstring executable(32768, L'\0');
        const auto length = GetModuleFileNameW(nullptr, executable.data(), static_cast<DWORD>(executable.size()));
        executable.resize(length); const auto directory_path = std::filesystem::path(executable).parent_path();
        participation = std::make_unique<Participation>(directory_path / L"ui/portal", directory_path / L"cloudflared.exe", root / L"participation");
        if (config.is_object() && !config.empty()) client = std::make_shared<SpoonClient>(root, config, test_origin);
        speaker = std::jthread([this](std::stop_token stop) {
            while (!stop.stop_requested()) {
                Utterance item;
                {
                    std::unique_lock lock(mutex);
                    if (!speech_ready.wait(lock, stop, [this] { return !speech.empty(); })) return;
                    item = std::move(speech.front()); speech.pop_front();
                    if (item.generation != generation) continue;
                }
                try { audio.speak(item.text, item.settings, item.cancel); std::lock_guard lock(mutex); if (item.generation == generation) audio_error.clear(); }
                catch (const std::exception& error) {
                    std::lock_guard lock(mutex);
                    if (item.generation == generation && !stop.stop_requested()) audio_error = error.what();
                }
            }
        });
    }

    ~Impl() {
        stop_receiving();
        speaker.request_stop(); speech_ready.notify_all(); audio.stop();
        if (speaker.joinable()) speaker.join();
        // Callback workers may still report status. Join them before members die.
        client.reset();
    }

    void persist() { write_json_atomic(root / L"state.json", model.snapshot()); }

    // Called with mutex held; tokens also cancel a job dequeued just before stop.
    void cancel_speech() {
        speech_cancel.request_stop(); speech_cancel = std::stop_source{};
        ++generation; speech.clear(); audio.stop();
    }

    void stop_receiving() {
        std::lock_guard lifecycle_lock(lifecycle);
        receiver.request_stop();
        audio.stop();
        if (receiver.joinable()) receiver.join();
        if (participation) participation->stop();
        std::lock_guard lock(mutex);
        receiving = false; cancel_speech();
        connection_state = "stopped"; current_listeners = Json::array();
        message = "API受信は停止中です。";
    }

    void record(const std::string& key, const Json& event) {
        std::lock_guard lock(mutex);
        if (!receiving || active_key != key || !model.record(key, event)) return;
        last_event = iso_now();
        persist();
        const auto state = model.snapshot();
        auto settings = state.value("settings", Json::object());
        const auto kind = text(event, "type");
        const auto enabled = settings.value("eventEnabled", Json::object());
        if (settings.value("enabled", false) && enabled.value(kind, true) && speech.size() < 500) {
            std::string content = text(event, "text");
            if (kind == "comment") {
                if (settings.value("readNames", false)) content = text(event["user"], "name") + "さん、" + content;
                auto choices = settings.value("commentSpeakers", Json::array());
                const auto assignments = state.value("runtime", Json::object()).value("assignments", Json::object());
                const auto id = text(event["user"], "id");
                const auto system_voice = settings.value("systemSpeaker", 3);
                const auto voices = state.value("runtime", Json::object()).value("voices", Json::array());
                const auto character = [&voices](int speaker_id) {
                    for (const auto& voice : voices) if (voice.value("id", -1) == speaker_id) {
                        auto name = text(voice, "name"); if (name.starts_with("VOICEVOX:")) name.erase(0, 8);
                        name = name.substr(0, std::min(name.find("（"), name.find('('))); return name;
                    }
                    return std::string{};
                };
                const auto reserved = [&](const Json& voice) {
                    if (!voice.is_number_integer()) return true;
                    const auto selected = voice.get<int>(); const auto name = character(selected), system_name = character(system_voice);
                    return selected == system_voice || (!name.empty() && name == system_name) ||
                        (voices.empty() && ((system_voice <= 3 && system_voice >= 0) && (selected == (system_voice ^ 2))));
                };
                if (!choices.is_array()) choices = Json::array();
                choices.erase(std::remove_if(choices.begin(), choices.end(), reserved), choices.end());
                if (choices.empty()) choices.push_back(system_voice == 0 || system_voice == 2 ? 1 : 0);
                if (assignments.contains(id) && assignments[id].is_number_integer() && !reserved(assignments[id])) settings["systemSpeaker"] = assignments[id];
                else if (choices.is_array() && !choices.empty()) {
                    std::uint32_t hash = 2166136261u;
                    for (const unsigned char byte : id) hash = (hash ^ byte) * 16777619u;
                    settings["systemSpeaker"] = choices[hash % choices.size()];
                }
            }
            speech.push_back({std::move(content), std::move(settings), generation, speech_cancel.get_token()});
            speech_ready.notify_one();
        }
    }

    void page_listeners(const std::shared_ptr<SpoonClient>& service, const std::string& key,
                        const std::string& owner, std::stop_token stop) {
        Json users = Json::array();
        std::string cursor;
        std::set<std::string> seen;
        for (int page = 0; page < 1000 && !stop.stop_requested(); ++page) {
            const auto response = service->request("/live/listeners" + (cursor.empty() ? "" : "?cursor=" + percent_encode(cursor)), "GET", nullptr, stop);
            if (!response.contains("listeners") || !response["listeners"].is_array())
                throw std::runtime_error("リスナー一覧の形式を確認できません。");
            for (const auto& raw : response["listeners"]) {
                auto user = api_user(raw, owner);
                if (!user.is_null() && users.size() < 1000) users.push_back(std::move(user));
            }
            if (!response.contains("nextCursor") || response["nextCursor"].is_null()) break;
            if (!response["nextCursor"].is_string()) throw std::runtime_error("リスナー一覧のページ情報が不正です。");
            cursor = response["nextCursor"].get<std::string>();
            if (cursor.empty() || !seen.insert(cursor).second || page == 999)
                throw std::runtime_error("リスナー一覧の取得を完了できません。");
        }
        if (stop.stop_requested()) return;
        std::lock_guard lock(mutex);
        if (receiving && active_key == key) { current_listeners = users; model.observe(key, users); persist(); }
    }

    void run(const std::shared_ptr<SpoonClient>& service, std::stop_token stop) {
        while (!stop.stop_requested()) {
            auto retry_delay = 3s;
            try {
                { std::lock_guard lock(mutex); connection_state = "connecting"; receive_error.clear(); }
                const auto me = service->request("/me", "GET", nullptr, stop);
                const auto live = service->request("/live", "GET", nullptr, stop);
                const auto owner = text(me, "userId");
                if (owner.empty() || !live.contains("liveId") || !live["liveId"].is_number_integer())
                    throw std::runtime_error("配信情報の形式を確認できません。");
                const auto key = "api:" + owner + ":" + live["liveId"].dump();
                {
                    std::lock_guard lock(mutex);
                    active_key = key; model.begin_session(key, live); persist();
                    message = "API接続中 · " + text(live, "title");
                }
                std::jthread listeners([this, service, key, owner](std::stop_token page_stop) {
                    do {
                        try {
                            page_listeners(service, key, owner, page_stop);
                            const auto live_info = service->request("/live", "GET", nullptr, page_stop);
                            std::lock_guard lock(mutex);
                            if (receiving && active_key == key && live_info.contains("liveId") && "api:" + owner + ":" + live_info["liveId"].dump() == key) {model.begin_session(key, live_info); persist();}
                        }
                        catch (const std::exception& error) {
                            if (!page_stop.stop_requested()) { std::lock_guard lock(mutex); message = error.what(); }
                        }
                    } while (wait_for(page_stop, 60s));
                });
                std::stop_callback cancel_pages(stop, [&listeners] { listeners.request_stop(); });
                try {
                    service->events([this, &key, &owner, stop](const SseFrame& frame) {
                        if (stop.stop_requested()) return false;
                        if (frame.event == "end") {
                            const auto detail = Json::parse(frame.data, nullptr, false);
                            if (detail.is_object() && text(detail, "reason") == "LIVE_ENDED") {
                                std::lock_guard lock(mutex);
                                model.finish_session(key); persist();
                                cancel_speech();
                                active_key.clear(); message = "配信が終了しました。次の配信を待っています。";
                                connection_state = "waiting"; participation->stop();
                            }
                            if (detail.is_object() && text(detail, "reason") == "DUPLICATE_CONNECTION") {
                                std::lock_guard lock(mutex); receiving = false; connection_state = "stopped";
                                cancel_speech(); message = "別のSpoon Managerが接続しました。使用するアプリを1つにして受信開始を押してください。";
                                participation->stop();
                            }
                            return false;
                        }
                        const auto event = api_event(frame, owner);
                        if (!event.is_null()) record(key, event);
                        return true;
                    }, stop, [this, &key] {
                        std::lock_guard lock(mutex);
                        if (receiving && active_key == key) {
                            connection_state = "connected"; last_activity = iso_now(); receive_error.clear();
                            message = "コメントを受信中です。";
                        }
                    });
                } catch (...) { listeners.request_stop(); throw; }
                listeners.request_stop();
                {std::lock_guard lock(mutex); if (!receiving) return;}
            } catch (const std::exception& error) {
                if (!stop.stop_requested()) {
                    std::lock_guard lock(mutex); receive_error = error.what();
                    const auto* http = dynamic_cast<const HttpError*>(&error);
                    if (http && http->status == 429) retry_delay = std::chrono::seconds(std::clamp<std::uint64_t>(http->retry_after, 30, 3600));
                    connection_state = http && http->status == 404 ? "waiting" : "error";
                    if (http && (http->status == 401 || http->status == 403)) {
                        connection_state = "unauthorized"; receiving = false; cancel_speech();
                        participation->stop();
                        message = "Spoonの再ログインが必要です。「受信開始」を押してください。"; return;
                    }
                    message = connection_state == "waiting" ? "配信の開始を待っています。" : receive_error;
                }
            }
            if (!wait_for(stop, retry_delay)) return;
        }
    }
};

Application::Application(std::filesystem::path directory, std::string test_api_origin) : impl_(std::make_unique<Impl>(std::move(directory), std::move(test_api_origin))) {}
Application::~Application() = default;

Json Application::snapshot() const {
    std::shared_ptr<SpoonClient> client;
    Json result;
    {
        std::lock_guard lock(impl_->mutex);
        result = impl_->model.snapshot(); client = impl_->client;
        result["_native"] = {{"message", impl_->message}, {"receiving", impl_->receiving},
            {"connectionState", impl_->connection_state}, {"lastActivity", impl_->last_activity},
            {"lastEvent", impl_->last_event}, {"receiveError", impl_->receive_error}, {"audioError", impl_->audio_error},
            {"listeners", impl_->current_listeners},
            {"activeKey", impl_->active_key}, {"pendingSpeech", impl_->speech.size()},
            {"authorizationCompleted", impl_->authorization_completed}, {"returnToApp", impl_->config.is_object() ? impl_->config.value("returnToApp", true) : true}};
    }
    result["_native"]["authorized"] = client && client->authorized();
    result["_native"]["scopes"] = client ? client->granted_scopes() : "";
    return result;
}

Json Application::connection() const { std::lock_guard lock(impl_->mutex); return impl_->config; }

void Application::configure(const Json& connection) {
    auto service = std::make_shared<SpoonClient>(impl_->root, connection, impl_->test_origin); // Validate first.
    stop_receiving();
    write_json_atomic(impl_->root / L"connection.json", connection);
    std::shared_ptr<SpoonClient> previous;
    {
        std::lock_guard lock(impl_->mutex);
        previous = std::move(impl_->client); impl_->client = std::move(service);
        impl_->config = connection; impl_->message = "接続設定を保存しました。DJの同意を開いてください。";
    }
    previous.reset();
}

void Application::save_settings(const Json& settings, const Json& preferences) {
    validate_settings(settings);
    if (!preferences.is_object()) throw std::runtime_error("目標・定型文の形式を確認してください。");
    std::lock_guard lock(impl_->mutex);
    auto previous = impl_->model;
    try {
        impl_->model.set_settings(settings); impl_->model.set_preferences(preferences); impl_->persist();
    } catch (...) { impl_->model = std::move(previous); throw; }
    impl_->cancel_speech();
    impl_->audio_error.clear();
    impl_->message = "設定を保存しました。";
}

std::string Application::authorization_url() {
    std::shared_ptr<SpoonClient> service;
    Json features;
    {
        std::lock_guard lock(impl_->mutex);
        service = impl_->client;
        if (!service) throw std::runtime_error("先に接続設定を保存してください。");
        const auto saved = impl_->model.snapshot();
        features = saved["manager"].value("preferences", Json::object()).value("features", Json::object());
    }
    service->start_callback([state = impl_.get()](const std::string& error) {
        std::lock_guard lock(state->mutex);
        state->message = error.empty() ? "DJの同意が完了しました。受信を開始できます。" : error;
        if (error.empty()) {++state->authorization_completed; state->receive_error.clear(); if (!state->receiving) state->connection_state = "stopped";}
    });
    return service->prepare_authorization(features);
}

void Application::start_receiving() {
    stop_receiving();
    std::lock_guard lifecycle_lock(impl_->lifecycle);
    std::shared_ptr<SpoonClient> service;
    {
        std::lock_guard lock(impl_->mutex); service = impl_->client;
    }
    if (!service || !service->authorized()) throw std::runtime_error("先に接続設定を保存し、DJの同意を完了してください。");
    { std::lock_guard lock(impl_->mutex); impl_->receiving = true; impl_->connection_state = "connecting"; impl_->receive_error.clear(); impl_->audio_error.clear(); impl_->message = "Spoon APIに接続しています…"; }
    impl_->receiver = std::jthread([state = impl_.get(), service](std::stop_token stop) { state->run(service, stop); });
}

void Application::stop_receiving() { impl_->stop_receiving(); }

void Application::send_chat(const std::string& content) {
    const auto text_length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, content.data(), static_cast<int>(content.size()), nullptr, 0);
    if (text_length < 1 || text_length > 200 || content.find_first_not_of(" \r\n\t") == std::string::npos)
        throw std::runtime_error("コメントは1〜200文字で入力してください。");
    std::shared_ptr<SpoonClient> service;
    Json live;
    std::string key;
    {
        std::lock_guard lock(impl_->mutex); service = impl_->client; key = impl_->active_key;
        const auto state = impl_->model.snapshot();
        for (const auto& session : state["manager"]["sessions"])
            if (text(session, "key") == key) live = session["live"];
    }
    if (!service || !live.is_object() || key.empty()) throw std::runtime_error("受信中の配信を確認してください。");
    service->request("/live/chat", "POST", {{"liveId", live["liveId"]}, {"message", content}});
    std::lock_guard lock(impl_->mutex);
    if (impl_->active_key == key) {
        impl_->model.record(key, {{"id", "manual:" + iso_now()}, {"type", "manual"}, {"time", iso_now()}, {"text", content}});
        impl_->persist(); impl_->message = "コメントを送信しました。";
    }
}

void Application::send_generated(const std::string& key, const std::string& content, const std::string& kind, const std::string& speech_kind) {
    if (kind != "automatic" && kind != "bot") throw std::invalid_argument("送信種別を確認してください。");
    const auto length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, content.data(), static_cast<int>(content.size()), nullptr, 0);
    if (length < 1 || length > 200) throw std::invalid_argument("コメントは1〜200文字で入力してください。");
    std::shared_ptr<SpoonClient> service; Json live, settings;
    {
        std::lock_guard lock(impl_->mutex);
        if (!impl_->receiving || impl_->active_key != key) throw std::runtime_error("配信が切り替わったため送信を中止しました。");
        service = impl_->client; const auto state = impl_->model.snapshot(); settings = state["settings"];
        if (!state["manager"]["preferences"].value("features", Json::object()).value("chat", false)) throw std::runtime_error("チャット送信を有効にしてください。");
        if (kind == "automatic" && state.value("runtime", Json::object()).value("sessions", Json::object()).value(key, Json::object()).value("automationPaused", false)) return;
        for (const auto& session : state["manager"]["sessions"]) if (text(session, "key") == key) live = session["live"];
    }
    if (!service || !live.is_object()) throw std::runtime_error("配信に接続してください。");
    try { service->request("/live/chat", "POST", {{"liveId", live["liveId"]}, {"message", content}}); }
    catch (...) {
        std::lock_guard lock(impl_->mutex);
        impl_->model.record(key, {{"id", kind + ":error:" + iso_now()}, {"type", kind + "-error"}, {"time", iso_now()}, {"text", "チャット送信に失敗しました。権限と接続状態を確認してください。"}}); impl_->persist(); throw;
    }
    std::lock_guard lock(impl_->mutex);
    impl_->model.record(key, {{"id", kind + ":" + iso_now()}, {"type", kind}, {"time", iso_now()}, {"text", content}}); impl_->persist();
    if (kind == "bot" && settings.value("enabled", false) && !speech_kind.empty() && settings.value("commandSpeech", Json::object()).value(speech_kind, false) && impl_->speech.size() < 500) {
        impl_->speech.push_back({content, settings, impl_->generation, impl_->speech_cancel.get_token()}); impl_->speech_ready.notify_one();
    }
}

Json Application::participation(const std::string& action, const Json& input) {
    if (action == "open") {
        const auto status = impl_->participation->action("status", Json::object());
        const auto url = text(input, "url"); bool allowed = false;
        for (const auto& link : status["links"]) if (link["url"] == url) allowed = true;
        if (!allowed) throw std::runtime_error("現在公開中の参加URLを選んでください。");
        const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, url.data(), static_cast<int>(url.size()), nullptr, 0);
        std::wstring wide_url(size, L'\0'); MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, url.data(), static_cast<int>(url.size()), wide_url.data(), size);
        if (reinterpret_cast<INT_PTR>(ShellExecuteW(nullptr, L"open", wide_url.c_str(), nullptr, nullptr, SW_SHOWNORMAL)) <= 32) throw std::runtime_error("参加ページを開けませんでした。");
        return {{"ok", true}};
    }
    if (action == "start" || action == "link") {
        std::lock_guard lock(impl_->mutex);
        if (!impl_->receiving || impl_->active_key.empty()) throw std::runtime_error("配信に接続してから参加URLを公開してください。");
    }
    return impl_->participation->action(action, input);
}

void Application::save_runtime(const Json& runtime) {
    std::lock_guard lock(impl_->mutex);
    auto previous = impl_->model;
    try { impl_->model.set_runtime(runtime); impl_->persist(); }
    catch (...) { impl_->model = std::move(previous); throw; }
}

Json Application::manager_action(const std::string& action, const std::string& key, const Json&) {
    if (action != "refresh" && action != "fans" && action != "donations" && action != "follow")
        throw std::invalid_argument("配信操作を確認してください。");
    std::shared_ptr<SpoonClient> service;
    {
        std::lock_guard lock(impl_->mutex);
        if (!impl_->receiving || key.empty() || key != impl_->active_key)
            throw std::runtime_error("受信中の現在の配信を選択してください。");
        service = impl_->client;
    }
    if (!service) throw std::runtime_error("Spoonとの連携を確認してください。");
    const auto owner = key.substr(4, key.rfind(':') - 4);
    if (action == "follow") { service->request("/live/follow", "POST", Json::object()); return {{"ok", true}}; }
    if (action == "fans") {
        auto response = service->request("/live/fans");
        if (!response.contains("fans") || !response["fans"].is_array()) throw std::runtime_error("ランキングを取得できませんでした。");
        return {{"fans", response["fans"]}, {"sessionKey", key}};
    }
    if (action == "refresh") {
        auto live = service->request("/live");
        if (!live.contains("liveId") || "api:" + owner + ":" + live["liveId"].dump() != key)
            throw std::runtime_error("配信が切り替わりました。再接続してから更新してください。");
        impl_->page_listeners(service, key, owner, {});
        std::lock_guard lock(impl_->mutex);
        if (key != impl_->active_key) throw std::runtime_error("配信が切り替わりました。");
        impl_->model.begin_session(key, live); impl_->persist();
        return {{"listeners", impl_->current_listeners}};
    }
    Json rows = Json::array(); std::string cursor; std::set<std::string> seen;
    for (int page = 0; page < 1000; ++page) {
        Json response;
        try { response = service->request("/live/donations" + (cursor.empty() ? "" : "?cursor=" + percent_encode(cursor))); }
        catch (const HttpError& error) {
            if (error.status == 403) throw HttpError(403, "ギフト履歴の取得権限（donations.read）がありません。開発者センターで権限を登録し、公式ギフト履歴の「DJの追加同意を取得」から同意を更新してください。");
            throw;
        }
        if (!response.contains("donations") || !response["donations"].is_array()) throw std::runtime_error("ギフト履歴を取得できませんでした。");
        for (auto item : response["donations"]) {
            auto user = api_user(item.value("user", Json()), owner);
            if (user.is_null()) continue;
            if (rows.size() >= 10000) throw std::runtime_error("ギフト履歴が保存上限の10000件を超えました。");
            item["user"] = std::move(user); rows.push_back(std::move(item));
        }
        const auto next = text(response, "nextCursor");
        if (next.empty()) break;
        if (!seen.insert(next).second || page == 999) throw std::runtime_error("ギフト履歴のページ情報が不正です。");
        cursor = next;
    }
    std::lock_guard lock(impl_->mutex);
    if (key != impl_->active_key) throw std::runtime_error("配信が切り替わりました。もう一度取得してください。");
    impl_->model.set_donations(key, rows); impl_->persist();
    return {{"ok", true}};
}

Json Application::voice_catalog() {
    Json settings;
    { std::lock_guard lock(impl_->mutex); settings = impl_->model.snapshot()["settings"]; }
    auto url = text(settings, "provider") == "engine" ? text(settings, "engineUrl", "http://127.0.0.1:50021") : "https://static.tts.quest/voicevox_speakers_utf8.json";
    if (text(settings, "provider") == "engine") { while (url.ends_with('/')) url.pop_back(); url += "/speakers"; }
    auto response = HttpClient{}.request("GET", url);
    if (response.status != 200) throw std::runtime_error("音声一覧を取得できませんでした。音声APIの接続先を確認してください。");
    auto body = Json::parse(response.body, nullptr, false); Json voices = Json::array();
    if (body.is_object() && body.contains("speakers")) body = body["speakers"];
    if (body.is_array()) for (std::size_t i = 0; i < body.size() && voices.size() < 2000; ++i) {
        const auto& item = body[i];
        if (item.is_string()) voices.push_back({{"id", i}, {"name", item}});
        else if (item.is_object() && item.contains("styles") && item["styles"].is_array()) {
            for (const auto& style : item["styles"]) if (style.contains("id") && style["id"].is_number_integer())
                voices.push_back({{"id", style["id"]}, {"name", text(item, "name") + "（" + text(style, "name") + "）"}});
        }
    }
    if (body.is_object()) for (const auto& [id, name] : body.items()) if (name.is_string()) {
        try { voices.push_back({{"id", std::stoi(id)}, {"name", name}}); } catch (...) {}
    }
    if (voices.empty()) throw std::runtime_error("音声APIから有効な話者一覧を取得できませんでした。");
    return voices;
}

Json Application::weather(const std::string& place, int day) {
    if (place.empty() || place.size() > 240 || day < 0 || day > 2) throw std::invalid_argument("地域と今日・明日・明後日を指定してください。");
    const auto get = [](const std::string& url) {
        const auto response = HttpClient{}.request("GET", url);
        if (response.status != 200) throw std::runtime_error("天気情報を取得できませんでした。時間をおいて再度お試しください。");
        auto body = Json::parse(response.body, nullptr, false);
        if (!body.is_object()) throw std::runtime_error("天気情報の形式を確認できませんでした。");
        return body;
    };
    const auto geocode = get("https://geocoding-api.open-meteo.com/v1/search?name=" + percent_encode(place) + "&count=1&language=ja&format=json");
    if (!geocode.contains("results") || !geocode["results"].is_array() || geocode["results"].empty()) throw std::runtime_error("地域が見つかりませんでした。市区町村名で指定してください。");
    const auto location = geocode["results"][0];
    auto forecast = get("https://api.open-meteo.com/v1/forecast?latitude=" + location.at("latitude").dump() + "&longitude=" + location.at("longitude").dump() + "&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=Asia%2FTokyo&forecast_days=3");
    return {{"place", text(location, "name", place)}, {"day", day}, {"daily", forecast.at("daily")}};
}

void Application::export_csv(const std::filesystem::path& file, const std::string& kind, const std::string& key) {
    std::string csv;
    {
        std::lock_guard lock(impl_->mutex);
        if (kind == "participants" || kind == "users") csv = impl_->model.participants_csv(key);
        else if (kind == "logs" || kind == "events") csv = impl_->model.logs_csv(key);
        else if (kind == "analytics") csv = impl_->model.analytics_csv();
        else throw std::runtime_error("未対応のCSV形式です。");
    }
    write_text_atomic(file, csv);
}

Json Application::audio_devices() const { return impl_->audio.devices(); }
void Application::test_voice(std::stop_token stop) {
    Json settings;
    { std::lock_guard lock(impl_->mutex); settings = impl_->model.snapshot()["settings"]; }
    impl_->audio.speak("音声の接続テストです。", settings, stop);
    {std::lock_guard lock(impl_->mutex); impl_->audio_error.clear();}
    if (!stop.stop_requested()) set_status("保存済みの声で再生しました。");
}
Json Application::diagnose_speech(std::stop_token stop) {
    Json settings;
    { std::lock_guard lock(impl_->mutex); settings = impl_->model.snapshot()["settings"]; }
    return impl_->audio.diagnose(settings, stop);
}
void Application::stop_audio() {
    std::lock_guard lock(impl_->mutex); impl_->cancel_speech();
}
void Application::set_status(const std::string& message) { std::lock_guard lock(impl_->mutex); impl_->message = message; }
const std::filesystem::path& Application::data_directory() const { return impl_->root; }

void Application::import_demo_events() {
    std::lock_guard lock(impl_->mutex);
    if (impl_->receiving) throw std::runtime_error("受信中にはテストデータを追加できません。");
    const auto stamp = iso_now();
    const std::string key = "api:demo:1";
    impl_->model.begin_session(key, {{"liveId", 1}, {"title", "ネイティブ画面テスト（デモ）"}, {"startedAt", stamp}});
    const Json user = {{"id", "api:demo:listener1"}, {"name", "テスト参加者"}};
    impl_->model.record(key, {{"id", "demo:entry"}, {"type", "entry"}, {"text", "テスト参加者さんが入室しました。"}, {"user", user}, {"time", stamp}});
    impl_->model.record(key, {{"id", "demo:comment"}, {"type", "comment"}, {"text", "画面の表示テストです。"}, {"user", user}, {"time", stamp}});
    impl_->model.record(key, {{"id", "demo:heart"}, {"type", "heart"}, {"amount", 10}, {"text", "ハート10個"}, {"user", user}, {"time", stamp}});
    impl_->model.record(key, {{"id", "demo:spoon"}, {"type", "spoon"}, {"amount", 5}, {"text", "スプーン5個"}, {"user", user}, {"time", stamp}});
    impl_->active_key = key; impl_->message = "デモデータを表示中（実際の配信には接続していません）";
    impl_->persist();
}

std::filesystem::path default_data_directory() {
    if (const auto size = GetEnvironmentVariableW(L"SPOON_MANAGER_DATA_DIR", nullptr, 0); size) {
        std::wstring value(size, L'\0');
        GetEnvironmentVariableW(L"SPOON_MANAGER_DATA_DIR", value.data(), size);
        value.resize(size - 1); return value;
    }
    PWSTR roaming = nullptr;
    if (FAILED(SHGetKnownFolderPath(FOLDERID_RoamingAppData, 0, nullptr, &roaming)))
        throw std::runtime_error("ユーザーデータの保存先を取得できません。");
    const auto directory = std::filesystem::path(roaming) / L"Spoon Manager Desktop";
    CoTaskMemFree(roaming);
    return directory;
}
}
