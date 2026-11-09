#include "spoon/spoon_client.hpp"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <httplib.h>
#include <windows.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <fstream>
#include <future>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

namespace {
using namespace std::chrono_literals;
using namespace std::string_literals;
using spoon::Json;
using spoon::SpoonClient;

void require(bool condition, const std::string& message) {
    if (!condition) throw std::runtime_error(message);
}

template<class Action> void fails(Action action, const std::string& message) {
    bool failed = false;
    try { action(); }
    catch (const std::exception& error) {
        failed = true;
        const std::string text = error.what();
        require(text.find("raw-secret") == std::string::npos && text.find("access-") == std::string::npos &&
                text.find("refresh-") == std::string::npos && text.find("client-secret") == std::string::npos,
                "An error disclosed credentials or remote response text");
    }
    require(failed, message);
}

template<class Predicate> void eventually(Predicate predicate, const std::string& message) {
    const auto deadline = std::chrono::steady_clock::now() + 3s;
    while (!predicate() && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(2ms);
    require(predicate(), message);
}

std::string decode(std::string_view input) {
    std::string value;
    const auto digit = [](char c) {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        return -1;
    };
    for (std::size_t i = 0; i < input.size(); ++i) {
        if (input[i] == '%') {
            require(i + 2 < input.size() && digit(input[i + 1]) >= 0 && digit(input[i + 2]) >= 0, "Invalid encoding");
            value += static_cast<char>(digit(input[i + 1]) * 16 + digit(input[i + 2]));
            i += 2;
        } else value += input[i] == '+' ? ' ' : input[i];
    }
    return value;
}

std::map<std::string, std::string> query(const std::string& url) {
    std::map<std::string, std::string> result;
    auto start = url.find('?');
    require(start != std::string::npos, "Missing authorization query");
    ++start;
    while (start < url.size()) {
        auto end = url.find('&', start);
        if (end == std::string::npos) end = url.size();
        const auto equals = url.find('=', start);
        require(equals < end, "Invalid authorization query");
        result[decode(std::string_view(url).substr(start, equals - start))] =
            decode(std::string_view(url).substr(equals + 1, end - equals - 1));
        start = end + 1;
    }
    return result;
}

Json connection(int port) {
    return {{"clientId", "client"}, {"clientSecret", "client-secret"}, {"region", "jp"}, {"port", port}};
}

std::filesystem::path temp_directory() {
    static std::atomic<unsigned> sequence{0};
    const auto name = "spoon-native-network-" + std::to_string(GetCurrentProcessId()) + "-" +
        std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + "-" +
        std::to_string(++sequence);
    return std::filesystem::temp_directory_path() / name;
}

int unused_port() {
    httplib::Server probe;
    const int port = probe.bind_to_any_port("127.0.0.1");
    require(port >= 1024, "Unable to reserve a callback port");
    std::jthread listener([&] { probe.listen_after_bind(); });
    probe.wait_until_ready();
    probe.stop();
    listener.join();
    return port;
}

struct Fixture {
    // Servers are always stopped before fields captured by handlers are destroyed.
    std::filesystem::path root = temp_directory();
    std::atomic<int> exchanges{0}, rest{0}, identity_calls{0}, event_calls{0};
    std::atomic<bool> fail_grant{false}, short_expiry{false}, reject_first{false}, reject_all{false};
    std::atomic<bool> fail_identity{false}, event_unauthorized{false}, bad_event_type{false};
    std::atomic<bool> slow_entered{false}, release_slow{false};
    std::mutex mutex;
    std::vector<std::map<std::string, std::string>> forms;
    std::vector<std::string> revoked, completions;
    bool valid_basic = true;
    std::string dj = "dj";
    httplib::Server api;
    std::jthread api_thread;
    int callback_port = unused_port();
    std::string origin;
    std::unique_ptr<SpoonClient> client;
    std::string callback_html, callback_policy;

    explicit Fixture(bool close_auth_tab = true) {
        api.new_task_queue = [] { return new httplib::ThreadPool(8); };
        api.set_read_timeout(3, 0);
        api.set_write_timeout(3, 0);
        api.Post("/v1/oauth/token", [&](const httplib::Request& request, httplib::Response& response) {
            const auto count = ++exchanges;
            {
                std::lock_guard lock(mutex);
                valid_basic &= request.get_header_value("Authorization") == "Basic Y2xpZW50OmNsaWVudC1zZWNyZXQ=";
                forms.emplace_back(request.params.begin(), request.params.end());
            }
            if (fail_grant.exchange(false)) {
                response.status = 401;
                response.set_content(R"({"error":"raw-secret"})", "application/json");
                return;
            }
            const auto suffix = std::to_string(count);
            const bool brief = short_expiry && request.get_param_value("grant_type") == "authorization_code";
            response.set_content(Json{{"access_token", "access-" + suffix}, {"refresh_token", "refresh-" + suffix},
                {"scope", "me.read live.read"}, {"token_type", "Bearer"}, {"expires_in", brief ? 10 : 3600}}.dump(),
                "application/json");
        });
        api.Get("/v1/me", [&](const httplib::Request&, httplib::Response& response) {
            ++identity_calls;
            if (fail_identity.exchange(false)) {
                response.status = 502;
                response.set_content("raw-secret", "text/plain");
                return;
            }
            std::lock_guard lock(mutex);
            response.set_content(Json{{"userId", dj}}.dump(), "application/json");
        });
        api.Post("/v1/oauth/revoke", [&](const httplib::Request& request, httplib::Response& response) {
            std::lock_guard lock(mutex);
            revoked.push_back(request.get_param_value("token"));
            response.status = 204;
        });
        api.Get("/v1/live", [&](const httplib::Request& request, httplib::Response& response) {
            ++rest;
            if (reject_all || (reject_first && request.get_header_value("Authorization") == "Bearer access-1")) {
                response.status = 401;
                response.set_content("raw-secret", "text/plain");
            } else response.set_content(R"({"liveId":123,"title":"Live"})", "application/json");
        });
        api.Get("/v1/live/listeners", [](const httplib::Request& request, httplib::Response& response) {
            response.set_content(Json{{"listeners", Json::array()}, {"nextCursor", nullptr},
                {"cursor", request.get_param_value("cursor")}}.dump(), "application/json");
        });
        api.Post("/v1/live/chat", [](const httplib::Request& request, httplib::Response& response) {
            response.set_content(request.body, "application/json");
        });
        api.Get("/v1/live/events", [&](const httplib::Request& request, httplib::Response& response) {
            ++event_calls;
            if (request.get_header_value("Accept") != "text/event-stream") {
                response.status = 400;
                return;
            }
            if (event_unauthorized.exchange(false)) { response.status = 401; return; }
            if (bad_event_type.exchange(false)) { response.set_content("raw-secret", "application/json"); return; }
            response.set_chunked_content_provider("text/event-stream; charset=utf-8",
                [](std::size_t offset, httplib::DataSink& sink) {
                    if (offset == 0) {
                        const std::string data = ": heartbeat\r\nid: e1\r\nevent: presence\r\ndata: {\"name\":\"\xE3\x81\x82\"}\r\n\r\n"
                                                 "event: end\ndata: {\"reason\":\"LIVE_ENDED\"}\n\n";
                        sink.write(data.data(), data.size());
                    }
                    sink.done();
                    return true;
                });
        });
        api.Get("/redirect", [](const httplib::Request&, httplib::Response& response) {
            response.set_redirect("/v1/me");
        });
        api.Get("/large", [](const httplib::Request&, httplib::Response& response) {
            response.set_chunked_content_provider("application/octet-stream",
                [](std::size_t offset, httplib::DataSink& sink) {
                    if (offset >= 17 * 1024 * 1024) { sink.done(); return true; }
                    const std::string block(16384, 'x');
                    return sink.write(block.data(), block.size());
                });
        });
        api.Get("/slow", [&](const httplib::Request&, httplib::Response& response) {
            slow_entered = true;
            while (!release_slow) std::this_thread::sleep_for(2ms);
            response.set_content("done", "text/plain");
        });
        api.Get("/idle-stream", [&](const httplib::Request&, httplib::Response& response) {
            response.set_chunked_content_provider("text/event-stream",
                [&](std::size_t offset, httplib::DataSink& sink) {
                    if (offset == 0) { sink.write(": ready\n\n", 9); return true; }
                    slow_entered = true;
                    while (!release_slow) std::this_thread::sleep_for(2ms);
                    sink.done();
                    return true;
                });
        });
        const auto port = api.bind_to_any_port("127.0.0.1");
        require(port > 0, "Unable to bind API fixture");
        origin = "http://127.0.0.1:" + std::to_string(port);
        api_thread = std::jthread([&] { api.listen_after_bind(); });
        eventually([&] { return api.is_running(); }, "API fixture did not start");
        auto config = connection(callback_port);
        config["closeAuthTab"] = close_auth_tab;
        client = std::make_unique<SpoonClient>(root, config, origin);
        client->start_callback([&](std::string message) {
            std::lock_guard lock(mutex);
            completions.push_back(std::move(message));
        });
    }
    ~Fixture() {
        release_slow = true;
        client.reset();
        api.stop();
        if (api_thread.joinable()) api_thread.join();
        std::error_code error;
        std::filesystem::remove_all(root, error);
    }
    int callback(const std::string& params, const httplib::Headers& headers = {}) {
        httplib::Client http("127.0.0.1", callback_port);
        http.set_read_timeout(5, 0);
        const auto result = http.Get("/oauth/callback?" + params, headers);
        require(static_cast<bool>(result), "Callback request failed");
        callback_html = result->body;
        callback_policy = result->get_header_value("Content-Security-Policy");
        require(result->body.find("raw-secret") == std::string::npos &&
                result->body.find("access-") == std::string::npos && result->body.find("refresh-") == std::string::npos,
                "Callback disclosed a secret");
        require(result->get_header_value("Cache-Control") == "no-store", "Callback is cacheable");
        return result->status;
    }
    void authorize() {
        const auto state = query(client->prepare_authorization(Json::object())).at("state");
        require(callback("state=" + state + "&code=single-use-code") == 200, "Code exchange failed");
    }
    Json saved() const {
        std::ifstream file(root / "spoon" / "tokens.json", std::ios::binary);
        require(static_cast<bool>(file), "Token cache is missing");
        return Json::parse(file);
    }
};

void test_config_and_origin() {
    const auto root = temp_directory();
    for (const auto& invalid : std::vector<Json>{Json::object(), connection(80), connection(70000),
         Json{{"clientId", "client"}, {"clientSecret", "client-secret"}, {"region", "xx"}, {"port", 17864}},
         Json{{"clientId", "client"}, {"clientSecret", "client-secret"}, {"port", "17864x"}}}) {
        fails([&] { SpoonClient client(root, invalid); }, "Invalid configuration was accepted");
    }
    auto valid = connection(17864);
    valid["port"] = "17864";
    valid["clientId"] = " client ";
    SpoonClient client(root, valid);
    require(!client.authorized(), "New client is authorized");
    for (const auto* origin : {"http://example.com", "https://127.0.0.1.evil/", "http://127.1:80",
                              "http://127.0.0.1:80/path", "http://localhost:80?query", "http://user@localhost:80",
                              "http://localhost:80#fragment", "http://localhost:80evil", "http://localhost:80:90",
                              "file:///tmp"}) {
        fails([&] { SpoonClient bad(root, valid, origin); }, "Non-loopback test origin accepted");
    }
    require(spoon::is_loopback_origin("http://127.0.0.1:12345"), "Loopback origin rejected");
    require(spoon::percent_encode("a+b /?\xE3\x81\x82") == "a%2Bb%20%2F%3F%E3%81%82", "Percent encoding failed");
}

void test_auth_tab_option() {
    Fixture fixture(false);
    fixture.client->start_callback({}); // Reopening consent reuses the listener.
    fixture.authorize();
    require(fixture.callback_html.find("window.close();") == std::string::npos, "Disabled tab closing was ignored");
    require(fixture.callback_html.find("history.replaceState") != std::string::npos, "Authorization query was retained");
}

void test_consent_and_callback() {
    Fixture f;
    const auto first_url = f.client->prepare_authorization(Json::object());
    require(first_url.starts_with("https://developers.spooncast.net/jp/oauth/authorize?"), "Wrong external consent origin");
    const auto first = query(first_url);
    require(first.at("state").size() == 64, "OAuth state has wrong entropy length");
    require(first.at("redirect_uri") == "http://localhost:" + std::to_string(f.callback_port) + "/oauth/callback",
            "Wrong redirect URI");
    require(!first.contains("client_secret"), "Consent URL leaked a secret");
    require(first.at("scope") == "me.read live.read listeners.read fans.read events.chat events.presence events.like events.donation events.follow donations.read chat.send dj.follow",
            "Initial consent must request every supported permission");
    const auto state = first.at("state");
    require(f.callback("state=" + state + "&code=once", {{"Host", "evil.example"}}) == 403, "Unexpected Host accepted");
    require(f.callback("state=" + state + "&code=once", {{"Origin", "http://evil.example"}}) == 403,
            "Unexpected Origin accepted");
    require(f.callback("state=" + state + "&error=access_denied") == 400, "Consent denial was accepted");
    require(f.callback("state=" + state + "&code=once") == 400, "Denied state was reusable");
    require(!f.client->authorized() && f.exchanges == 0, "Denial exchanged a code");
    const Json features{{"chat", true}, {"fans", true}, {"donations", true},
                        {"follow", true}, {"djFollow", true}};
    const auto next = query(f.client->prepare_authorization(Json{{"features", features}}));
    require(next.at("state") != state, "OAuth states were reused");
    for (const auto* scope : {"chat.send", "fans.read", "donations.read", "events.follow", "dj.follow"})
        require(next.at("scope").find(scope) != std::string::npos, "Selected scope is missing");
    require(f.callback("state=" + next.at("state") + "&code=once") == 200, "Valid callback failed");
    require(f.callback_html.find("window.close();") != std::string::npos && f.callback_html.find("history.replaceState") != std::string::npos,
            "Success page did not close the auth tab or remove the authorization query");
    require(f.callback_policy.find("script-src 'nonce-") != std::string::npos && f.callback_policy.find("unsafe-inline") == std::string::npos,
            "Callback completion script must use a nonce");
    require(f.callback("state=" + next.at("state") + "&code=once") == 400, "Successful state was replayed");
    require(f.exchanges == 1 && f.client->authorized(), "Unexpected code exchange count");
    std::lock_guard lock(f.mutex);
    require(f.valid_basic && f.forms.front().at("redirect_uri") == first.at("redirect_uri"), "Wrong OAuth form or Basic auth");
    const auto saved = f.saved();
    require(saved["clientId"] == "client" && saved["region"] == "jp" && saved["token"]["userId"] == "dj",
            "Token schema or identity differs from existing backend");
}

void test_pending_limit() {
    Fixture f;
    for (int count = 0; count < 20; ++count) f.client->prepare_authorization(Json::object());
    fails([&] { f.client->prepare_authorization(Json::object()); }, "Pending authorization limit is missing");
}

void test_parallel_refresh() {
    Fixture f;
    f.short_expiry = true;
    f.authorize();
    std::vector<std::future<Json>> pending;
    for (int index = 0; index < 6; ++index)
        pending.push_back(std::async(std::launch::async, [&] { return f.client->request("/live"); }));
    for (auto& future : pending) require(future.get()["liveId"] == 123, "Parallel API request failed");
    require(f.exchanges == 2, "Concurrent callers replayed a refresh token");
    require(f.saved()["token"]["refresh_token"] == "refresh-2" && f.saved()["token"]["userId"] == "dj",
            "Rotated token or identity was not saved");
    std::lock_guard lock(f.mutex);
    require(f.forms.size() == 2 && f.forms[1].at("grant_type") == "refresh_token" &&
            f.forms[1].at("refresh_token") == "refresh-1", "Wrong refresh grant");
}

void test_unauthorized_retry_and_json() {
    Fixture f;
    f.authorize();
    f.reject_first = true;
    require(f.client->request("/live")["liveId"] == 123, "401 was not refreshed and retried");
    require(f.exchanges == 2 && f.rest == 2, "401 request retried an unexpected number of times");
    require(f.client->request("/live/listeners?cursor=a%2Bb%20c")["cursor"] == "a+b c", "Cursor was altered");
    const Json body{{"liveId", 123}, {"message", "hello"}};
    require(f.client->request("/live/chat", "POST", body) == body, "JSON request body was altered");
    f.reject_all = true;
    const int before = f.rest;
    fails([&] { f.client->request("/live"); }, "Repeated 401 was accepted");
    require(f.rest == before + 2 && f.exchanges == 3, "Repeated 401 caused more than one retry");
    for (const auto* path : {"//evil.example", "/../oauth/token", "/%2e%2e/oauth/token", "/a\\b", "/a#fragment"})
        fails([&] { f.client->request(path); }, "Unsafe API path accepted");
}

void test_refresh_failure_and_reload() {
    Fixture f;
    f.authorize();
    f.reject_first = true;
    f.fail_grant = true;
    fails([&] { f.client->request("/live"); }, "Failed refresh was accepted");
    require(!f.client->authorized() && f.saved()["token"].is_null(), "Consumed refresh token was retained");
    fails([&] { f.client->request("/live"); }, "Failed refresh token was reusable");
    require(f.exchanges == 2, "Failed rotating grant was replayed");
    f.client.reset();
    f.client = std::make_unique<SpoonClient>(f.root, connection(f.callback_port), f.origin);
    require(!f.client->authorized(), "Invalidated authorization returned after restart");
    fails([&] { f.client->request("/live"); }, "Restart replayed an invalidated token");
    require(f.exchanges == 2, "Restart sent an invalid refresh grant");
}

void test_reauthorization_and_identity_failure() {
    Fixture f;
    f.authorize();
    f.authorize();
    {
        std::lock_guard lock(f.mutex);
        require(f.revoked == std::vector<std::string>{"refresh-1"}, "Previous same-DJ token was not revoked");
        f.dj = "another-dj";
    }
    f.authorize();
    {
        std::lock_guard lock(f.mutex);
        require(f.revoked.size() == 1, "Another DJ's token was revoked");
    }
    f.fail_identity = true;
    const auto state = query(f.client->prepare_authorization(Json::object())).at("state");
    require(f.callback("state=" + state + "&code=identity-fails") == 502, "Failed identity lookup was accepted");
    require(f.saved()["token"]["refresh_token"] == "refresh-4" && f.client->authorized(),
            "Identity failure discarded new rotating tokens");
    require(f.callback("state=" + state + "&code=identity-fails") == 400 && f.exchanges == 4,
            "Identity failure replayed the authorization code");
}

void test_sse_parser() {
    std::vector<spoon::SseFrame> frames;
    spoon::SseParser parser([&](const spoon::SseFrame& frame) { frames.push_back(frame); return true; });
    const std::string input = "\xEF\xBB\xBF: heartbeat\r\nid: 7\revent: chat\ndata: \xE3\x81\x82\r\ndata: second\r\n\r\n"
                              "id: ignored\0value\ndata:\n\n"s;
    // Feed one byte at a time, splitting CRLF, the BOM and every UTF-8 codepoint.
    for (const char byte : input) require(parser.feed(std::string_view(&byte, 1)), "Parser stopped unexpectedly");
    require(frames.size() == 2, "Wrong SSE frame count");
    require(frames[0].id == "7" && frames[0].event == "chat" && frames[0].data == "\xE3\x81\x82\nsecond",
            "Split SSE fields or UTF-8 were corrupted");
    require(frames[1].id.empty() && frames[1].event == "message" && frames[1].data.empty(),
            "SSE default event, empty data or NUL id handling failed");
    require(parser.feed("data: unfinished") && frames.size() == 2, "Unterminated frame was dispatched");
    int calls = 0;
    spoon::SseParser stop([&](const spoon::SseFrame&) { ++calls; return false; });
    require(!stop.feed("data: one\n\ndata: two\n\n") && calls == 1 && !stop.feed("data: three\n\n"),
            "Parser ignored handler backpressure");
    spoon::SseParser large([](const spoon::SseFrame&) { return true; });
    fails([&] { large.feed(std::string(1024 * 1024 + 1, 'x')); }, "Unbounded SSE line accepted");
    spoon::SseParser multiline([](const spoon::SseFrame&) { return true; });
    fails([&] { for (int i = 0; i < 2048; ++i) multiline.feed("data: " + std::string(1024, 'x') + "\n"); },
          "Unbounded multiline SSE frame accepted");
}

void test_live_stream() {
    Fixture f;
    f.authorize();
    f.event_unauthorized = true;
    std::vector<spoon::SseFrame> frames;
    f.client->events([&](const spoon::SseFrame& frame) { frames.push_back(frame); return true; });
    require(frames.size() == 2 && frames[0].id == "e1" && frames[1].event == "end", "HTTP SSE stream was not parsed");
    require(f.exchanges == 2 && f.event_calls == 2, "SSE 401 refresh did not retry once");
    int count = 0;
    f.client->events([&](const spoon::SseFrame&) { ++count; return false; });
    require(count == 1, "Event handler false did not stop delivery");
    f.bad_event_type = true;
    fails([&] { f.client->events([](const spoon::SseFrame&) { return true; }); }, "Non-SSE MIME type accepted");
    const int streams_before = f.event_calls;
    const int grants_before = f.exchanges;
    fails([&] {
        f.client->events([](const spoon::SseFrame&) -> bool { throw spoon::HttpError(401, "Handler failed."); });
    }, "Handler exception was swallowed");
    require(f.event_calls == streams_before + 1 && f.exchanges == grants_before,
            "A handler exception replayed an event stream or refreshed a token");
    const auto before = f.identity_calls.load();
    fails([&] { spoon::HttpClient{}.request("GET", f.origin + "/redirect"); }, "Redirect was followed");
    require(f.identity_calls == before, "Redirect destination received the request");
    fails([&] { spoon::HttpClient{}.request("GET", f.origin + "/large"); }, "Unbounded HTTP response accepted");
    fails([&] {
        spoon::HttpClient{}.request("GET", f.origin + "/v1/me", {{"X-Test", "a\r\nb"}});
    }, "Header injection accepted");
}

void test_cancellation() {
    Fixture f;
    std::stop_source already;
    already.request_stop();
    fails([&] { spoon::HttpClient{}.request("GET", f.origin + "/v1/me", {}, {}, already.get_token()); },
          "Pre-cancelled HTTP request was sent");
    std::stop_source stop;
    auto pending = std::async(std::launch::async, [&] {
        fails([&] { spoon::HttpClient{}.request("GET", f.origin + "/slow", {}, {}, stop.get_token()); },
              "Cancelled header wait succeeded");
    });
    eventually([&] { return f.slow_entered.load(); }, "Slow fixture was not reached");
    stop.request_stop();
    const bool prompt = pending.wait_for(2s) == std::future_status::ready;
    f.release_slow = true;
    pending.get();
    require(prompt, "HTTP cancellation did not interrupt a pending header read");

    f.slow_entered = false;
    f.release_slow = false;
    std::stop_source stream_stop;
    auto stream = std::async(std::launch::async, [&] {
        fails([&] {
            spoon::HttpClient{}.stream(f.origin + "/idle-stream", {{"Accept", "text/event-stream"}},
                [](std::string_view) { return true; }, stream_stop.get_token());
        }, "Cancelled event read succeeded");
    });
    eventually([&] { return f.slow_entered.load(); }, "Idle SSE fixture was not reached");
    stream_stop.request_stop();
    const bool stream_prompt = stream.wait_for(2s) == std::future_status::ready;
    f.release_slow = true;
    stream.get();
    require(stream_prompt, "HTTP cancellation did not interrupt a pending stream read");
}

void test_live_delivery_before_close() {
    Fixture f;
    std::atomic<bool> delivered{false};
    std::stop_source stop;
    auto stream = std::async(std::launch::async, [&] {
        try {
            spoon::HttpClient{}.stream(f.origin + "/idle-stream", {{"Accept", "text/event-stream"}},
                [&](std::string_view chunk) { delivered = chunk.find(": ready") != std::string_view::npos; return true; }, stop.get_token());
        } catch (const spoon::HttpError&) { if (!stop.stop_requested()) throw; }
    });
    eventually([&] { return f.slow_entered.load(); }, "Streaming fixture was not reached");
    const auto deadline = std::chrono::steady_clock::now() + 1500ms;
    while (!delivered && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(2ms);
    const bool immediate = delivered;
    stop.request_stop(); f.release_slow = true; stream.get();
    require(immediate, "Small SSE frames were buffered until the connection closed");
}
}

int main() {
    const std::vector<std::pair<const char*, void(*)()>> tests{
        {"configuration and loopback origin", test_config_and_origin},
        {"OAuth consent, callback security and single use", test_consent_and_callback},
        {"Optional authentication-tab closing", test_auth_tab_option},
        {"pending authorization limit", test_pending_limit},
        {"parallel refresh serialization and persistence", test_parallel_refresh},
        {"401 retry, paths and JSON", test_unauthorized_retry_and_json},
        {"failed refresh and restart", test_refresh_failure_and_reload},
        {"reauthorization and identity failure", test_reauthorization_and_identity_failure},
        {"incremental SSE parser and limits", test_sse_parser},
        {"real loopback SSE stream and redirects", test_live_stream},
        {"small SSE frames arrive while connection stays open", test_live_delivery_before_close},
        {"in-flight HTTP and SSE cancellation", test_cancellation}
    };
    int failed = 0;
    for (const auto& [name, run] : tests) {
        try { run(); std::cout << "PASS " << name << '\n'; }
        catch (const std::exception& error) { ++failed; std::cerr << "FAIL " << name << ": " << error.what() << '\n'; }
        catch (...) { ++failed; std::cerr << "FAIL " << name << ": unexpected exception\n"; }
    }
    std::cout << tests.size() - failed << '/' << tests.size() << " network tests passed\n";
    return failed == 0 ? 0 : 1;
}
