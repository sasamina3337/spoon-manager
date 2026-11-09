#include "spoon/spoon_client.hpp"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <httplib.h>
#include <windows.h>
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cmath>
#include <fstream>
#include <limits>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

#ifdef _MSC_VER
#pragma comment(lib, "bcrypt.lib")
#endif

namespace spoon {
namespace {
constexpr std::size_t max_frame = 1024 * 1024;
using SteadyClock = std::chrono::steady_clock;

[[noreturn]] void auth_error() { throw HttpError(401, "Spoon authorization is required. Please authorize again."); }
[[noreturn]] void storage_error() { throw HttpError(500, "Unable to save Spoon authorization."); }
void check_stop(std::stop_token stop) {
    if (stop.stop_requested()) throw HttpError(0, "Request cancelled.");
}

std::uint64_t now_ms() {
    return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count());
}

std::string random_hex() {
    std::array<unsigned char, 32> bytes{};
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
                        BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0)
        throw HttpError(500, "Unable to prepare secure authorization.");
    constexpr char digits[] = "0123456789abcdef";
    std::string result;
    for (const auto byte : bytes) { result += digits[byte >> 4]; result += digits[byte & 15]; }
    return result;
}

std::string text(const Json& value, const char* key) {
    if (!value.is_object()) return {};
    const auto found = value.find(key);
    return found != value.end() && found->is_string() ? found->get<std::string>() : std::string{};
}

std::string trim(std::string value) {
    constexpr auto spaces = " \t\r\n\f\v";
    const auto first = value.find_first_not_of(spaces);
    if (first == std::string::npos) return {};
    return value.substr(first, value.find_last_not_of(spaces) - first + 1);
}

struct Config {
    std::string client_id, client_secret, region;
    int port = 0;
    bool close_auth_tab = true;
    explicit Config(const Json& connection) {
        client_id = trim(text(connection, "clientId"));
        for (const auto* option : {"closeAuthTab", "returnToApp"}) {
            if (connection.contains(option) && !connection[option].is_boolean()) throw HttpError(400, "認証後の動作設定を確認してください。");
        }
        close_auth_tab = connection.is_object() ? connection.value("closeAuthTab", true) : true;
        client_secret = trim(text(connection, "clientSecret"));
        region = connection.is_object() && connection.contains("region") ? text(connection, "region") : "jp";
        if (connection.is_object() && connection.contains("port")) {
            const auto& value = connection["port"];
            if (value.is_number_integer()) {
                if (value.is_number_unsigned()) {
                    const auto number = value.get<std::uint64_t>();
                    if (number <= 65535) port = static_cast<int>(number);
                } else {
                    const auto number = value.get<std::int64_t>();
                    if (number >= 0 && number <= 65535) port = static_cast<int>(number);
                }
            } else if (value.is_string()) {
                const auto number = value.get<std::string>();
                const auto parsed = std::from_chars(number.data(), number.data() + number.size(), port);
                if (parsed.ec != std::errc{} || parsed.ptr != number.data() + number.size()) port = 0;
            }
        }
        const auto control = [](const std::string& value) {
            return std::any_of(value.begin(), value.end(), [](unsigned char c) { return c < 32 || c == 127; });
        };
        if (client_id.empty() || client_secret.empty() || client_id.size() > 4096 || client_secret.size() > 4096 ||
            client_id.find(':') != std::string::npos || control(client_id) || control(client_secret) ||
            (region != "jp" && region != "kr") || port < 1024 || port > 65535)
            throw HttpError(400, "Check Spoon client credentials, region and callback port.");
    }
    std::string redirect_uri() const { return "http://localhost:" + std::to_string(port) + "/oauth/callback"; }
};

std::string base64(std::string_view value) {
    constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string result;
    unsigned buffer = 0;
    int bits = 0;
    for (unsigned char c : value) {
        buffer = (buffer << 8) | c;
        bits += 8;
        while (bits >= 6) { bits -= 6; result += alphabet[(buffer >> bits) & 63]; }
    }
    if (bits) result += alphabet[(buffer << (6 - bits)) & 63];
    while (result.size() % 4) result += '=';
    return result;
}

Json parse_json(const std::string& body) {
    auto value = Json::parse(body, nullptr, false);
    if (value.is_discarded()) throw HttpError(502, "Invalid Spoon API response.");
    return value;
}

void successful(const HttpResponse& response) {
    if (response.status >= 200 && response.status < 300) return;
    std::uint64_t retry = 0;
    if (const auto it = response.headers.find("retry-after"); it != response.headers.end()) {
        const auto parsed = std::from_chars(it->second.data(), it->second.data() + it->second.size(), retry);
        if (parsed.ec != std::errc{} || parsed.ptr != it->second.data() + it->second.size()) retry = 0;
    }
    const char* message = "Spoon API request failed.";
    if (response.status == 401) message = "Spoon authorization is required. Please authorize again.";
    if (response.status == 403) message = "Check Spoon permissions and manager access.";
    if (response.status == 404) message = "Waiting for the Spoon broadcast to start.";
    if (response.status == 429) message = "Spoon API rate limit reached. Please wait before retrying.";
    throw HttpError(response.status, message, retry);
}

Json read_saved(const std::filesystem::path& path) {
    std::error_code error;
    const bool exists = std::filesystem::exists(path, error);
    if (error) throw HttpError(500, "Unable to read Spoon authorization.");
    if (!exists) return nullptr;
    const auto size = std::filesystem::file_size(path, error);
    if (error || size > 1024 * 1024) throw HttpError(500, "Unable to read Spoon authorization.");
    std::ifstream file(path, std::ios::binary);
    if (!file) throw HttpError(500, "Unable to read Spoon authorization.");
    const std::string body((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    if (file.bad()) throw HttpError(500, "Unable to read Spoon authorization.");
    auto saved = Json::parse(body, nullptr, false);
    // A damaged or incompatible cache requires reauthorization.
    return saved.is_discarded() ? Json(nullptr) : saved;
}

void atomic_save(const std::filesystem::path& path, const Json& saved) {
    std::error_code error;
    std::filesystem::create_directories(path.parent_path(), error);
    if (error) storage_error();
    const auto temporary = path.parent_path() / (L"tokens." + std::filesystem::path(random_hex()).wstring() + L".tmp");
    const auto bytes = saved.dump();
    HANDLE file = CreateFileW(temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
                              FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr);
    if (file == INVALID_HANDLE_VALUE) storage_error();
    DWORD written = 0;
    const bool wrote = bytes.size() <= std::numeric_limits<DWORD>::max() &&
        WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size();
    const bool flushed = wrote && FlushFileBuffers(file);
    const bool closed = CloseHandle(file) != FALSE;
    if (!flushed || !closed || !MoveFileExW(temporary.c_str(), path.c_str(),
                                          MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        DeleteFileW(temporary.c_str());
        storage_error();
    }
}

bool valid_token(const Json& value) {
    const auto access = text(value, "access_token"), refresh = text(value, "refresh_token");
    const auto safe = [](const std::string& token) {
        return !token.empty() && token.size() <= 32768 &&
            std::all_of(token.begin(), token.end(), [](unsigned char c) { return c >= 33 && c < 127; });
    };
    return safe(access) && safe(refresh);
}

// Lock wait is cancellable too, so a second caller does not wait for another
// caller's token exchange after its own stop request.
std::unique_lock<std::timed_mutex> token_lock(std::timed_mutex& mutex, std::stop_token stop) {
    std::unique_lock lock(mutex, std::defer_lock);
    while (!lock.try_lock_for(std::chrono::milliseconds(25))) check_stop(stop);
    check_stop(stop);
    return lock;
}

void validate_path(const std::string& path) {
    if (path.empty() || path.front() != '/' || path.starts_with("//") || path.size() > 8192 ||
        path.find_first_of("#\\") != std::string::npos ||
        std::any_of(path.begin(), path.end(), [](unsigned char c) { return c <= 32 || c == 127; }))
        throw HttpError(400, "Invalid Spoon API path.");
    // Reject traversal even when percent encoded. Query values are opaque.
    const auto end = path.find('?');
    std::string decoded;
    const auto hex = [](char c) -> int {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    };
    const auto route = path.substr(0, end);
    for (std::size_t i = 0; i < route.size(); ++i) {
        unsigned char c = route[i];
        if (c == '%') {
            if (i + 2 >= route.size() || hex(route[i + 1]) < 0 || hex(route[i + 2]) < 0)
                throw HttpError(400, "Invalid Spoon API path.");
            c = static_cast<unsigned char>((hex(route[i + 1]) << 4) | hex(route[i + 2]));
            i += 2;
        }
        if (c <= 32 || c == 127 || c == '\\' || c == '%' || c == '?' || c == '#')
            throw HttpError(400, "Invalid Spoon API path.");
        decoded += static_cast<char>(c);
    }
    std::size_t start = 0;
    while (start <= decoded.size()) {
        const auto next = decoded.find('/', start);
        const auto segment = decoded.substr(start, next - start);
        if (segment == "." || segment == "..") throw HttpError(400, "Invalid Spoon API path.");
        if (next == std::string::npos) break;
        start = next + 1;
    }
}
}

SseParser::SseParser(std::function<bool(const SseFrame&)> handler) : handler_(std::move(handler)) {
    if (!handler_) throw HttpError(400, "An event handler is required.");
}

bool SseParser::line() {
    if (line_.empty()) {
        if (data_seen_) {
            if (!frame_.data.empty()) frame_.data.pop_back();
            if (frame_.event.empty()) frame_.event = "message";
            stopped_ = !handler_(frame_);
        }
        frame_ = {};
        frame_size_ = 0;
        data_seen_ = false;
        return !stopped_;
    }
    if (line_.front() != ':') {
        const auto colon = line_.find(':');
        const auto field = std::string_view(line_).substr(0, colon);
        auto value = colon == std::string::npos ? std::string_view{} : std::string_view(line_).substr(colon + 1);
        if (value.starts_with(' ')) value.remove_prefix(1);
        if (field == "event") frame_.event = value;
        if (field == "id" && value.find('\0') == std::string_view::npos) frame_.id = value;
        if (field == "data") { frame_.data.append(value); frame_.data += '\n'; data_seen_ = true; }
        frame_size_ = frame_.id.size() + frame_.event.size() + frame_.data.size();
        if (frame_size_ > max_frame) throw HttpError(502, "Spoon event is too large.");
    }
    line_.clear();
    return true;
}

bool SseParser::feed(std::string_view bytes) {
    if (stopped_) return false;
    for (const char c : bytes) {
        // Strip an optional UTF-8 BOM once, including a BOM split across chunks.
        if (!prefix_done_) {
            prefix_ += c;
            constexpr std::string_view bom = "\xEF\xBB\xBF";
            if (bom.starts_with(prefix_)) {
                if (prefix_.size() == 3) { prefix_.clear(); prefix_done_ = true; }
                continue;
            }
            prefix_done_ = true;
            auto prefix = std::move(prefix_);
            prefix_.clear();
            if (!feed(prefix)) return false;
            continue;
        }
        if (skip_lf_) { skip_lf_ = false; if (c == '\n') continue; }
        if (c == '\r' || c == '\n') {
            skip_lf_ = c == '\r';
            if (!line()) return false;
        } else {
            if (line_.size() + frame_size_ >= max_frame) throw HttpError(502, "Spoon event is too large.");
            line_ += c;
        }
    }
    return true;
}

struct SpoonClient::Impl {
    Config config;
    std::string base;
    std::filesystem::path token_path;
    HttpClient http;
    mutable std::timed_mutex token_mutex;
    Json token = nullptr;
    std::mutex pending_mutex, callback_busy, server_mutex;
    std::map<std::string, SteadyClock::time_point> pending;
    std::unique_ptr<httplib::Server> server;
    std::jthread server_thread;
    std::stop_source shutdown;

    Impl(std::filesystem::path data_dir, const Json& connection, const std::string& test_origin)
        : config(connection), base("https://" + config.region + "-openapi.spooncast.net"),
          token_path(std::move(data_dir) / "spoon" / "tokens.json") {
        if (!test_origin.empty()) {
            if (!is_loopback_origin(test_origin)) throw HttpError(400, "Test API origin must be loopback.");
            base = test_origin;
            if (base.back() == '/') base.pop_back();
        }
        const auto saved = read_saved(token_path);
        if (text(saved, "clientId") == config.client_id && text(saved, "region") == config.region &&
            saved.contains("token") && valid_token(saved["token"])) token = saved["token"];
    }

    ~Impl() {
        shutdown.request_stop();
        if (server) server->stop();
        if (server_thread.joinable()) server_thread.join();
    }

    void persist(const Json& value) {
        atomic_save(token_path, Json{{"clientId", config.client_id}, {"region", config.region}, {"token", value}});
    }

    std::map<std::string, std::string> grant_headers() const {
        return {{"Authorization", "Basic " + base64(config.client_id + ":" + config.client_secret)},
                {"Content-Type", "application/x-www-form-urlencoded"}, {"Accept", "application/json"}};
    }

    Json exchange(const std::string& form, std::stop_token stop) {
        const auto response = http.request("POST", base + "/v1/oauth/token", grant_headers(), form, stop);
        if (response.status < 200 || response.status >= 300) auth_error();
        auto value = parse_json(response.body);
        if (!valid_token(value) || !value.contains("scope") || !value["scope"].is_string() ||
            !value.contains("expires_in") || !value["expires_in"].is_number()) auth_error();
        const auto seconds = value["expires_in"].get<double>();
        // Bound before conversion to avoid undefined conversion or overflow.
        if (!std::isfinite(seconds) || seconds <= 0 || seconds > 315360000.0) auth_error();
        value["expiresAt"] = now_ms() + static_cast<std::uint64_t>(seconds * 1000.0);
        return value;
    }

    std::string identify(const std::string& access, std::stop_token stop) {
        const auto response = http.request("GET", base + "/v1/me", {{"Authorization", "Bearer " + access}}, {}, stop);
        successful(response);
        const auto id = text(parse_json(response.body), "userId");
        if (id.empty()) throw HttpError(502, "Invalid Spoon identity response.");
        return id;
    }

    void authorize(const std::string& code, std::stop_token stop) {
        auto lock = token_lock(token_mutex, stop);
        const auto previous = token;
        auto next = exchange("grant_type=authorization_code&code=" + percent_encode(code) +
                             "&redirect_uri=" + percent_encode(config.redirect_uri()), stop);
        // Never reuse the code. Persist issued credentials before identity lookup.
        token = next;
        persist(token);
        const auto user_id = identify(text(next, "access_token"), stop);
        token["userId"] = user_id;
        persist(token);
        if (!previous.is_null() && text(previous, "refresh_token") != text(token, "refresh_token")) {
            auto previous_id = text(previous, "userId");
            if (previous_id.empty()) {
                try { previous_id = identify(text(previous, "access_token"), stop); }
                catch (const HttpError&) { check_stop(stop); }
            }
            if (previous_id == user_id) {
                const auto revoked = http.request("POST", base + "/v1/oauth/revoke", grant_headers(),
                    "token=" + percent_encode(text(previous, "refresh_token")), stop);
                if (revoked.status < 200 || revoked.status >= 300)
                    throw HttpError(502, "New authorization saved, but previous tokens could not be revoked.");
            }
        }
    }

    std::string access_token(const std::string* stale, std::stop_token stop) {
        auto lock = token_lock(token_mutex, stop);
        if (token.is_null()) auth_error();
        bool refresh = stale ? text(token, "access_token") == *stale : true;
        if (!stale && token.contains("expiresAt") && token["expiresAt"].is_number_unsigned())
            refresh = token["expiresAt"].get<std::uint64_t>() <= now_ms() + 300000;
        if (refresh) {
            const auto old = token;
            // Invalidate durably before sending a rotating credential. On any
            // failure it stays invalid, even across a process restart.
            token = nullptr;
            persist(token);
            auto next = exchange("grant_type=refresh_token&refresh_token=" +
                                 percent_encode(text(old, "refresh_token")), stop);
            if (old.contains("userId")) next["userId"] = old["userId"];
            persist(next);
            token = std::move(next);
        }
        return text(token, "access_token");
    }

    void callback(const httplib::Request& request) {
        if (request.get_param_value_count("state") != 1) throw HttpError(400, "Invalid authorization state.");
        const auto state = request.get_param_value("state");
        {
            std::lock_guard lock(pending_mutex);
            const auto found = pending.find(state);
            if (found == pending.end()) throw HttpError(400, "Invalid or expired authorization state.");
            const auto expiry = found->second;
            pending.erase(found); // Consume on success, denial and malformed callbacks.
            if (expiry <= SteadyClock::now()) throw HttpError(400, "Invalid or expired authorization state.");
        }
        std::unique_lock busy(callback_busy, std::try_to_lock);
        if (!busy.owns_lock()) throw HttpError(400, "Another authorization is already in progress.");
        if (request.has_param("error") || request.get_param_value_count("code") != 1 ||
            request.get_param_value("code").empty() || request.get_param_value("code").size() > 8192)
            throw HttpError(400, "Spoon consent was not completed.");
        authorize(request.get_param_value("code"), shutdown.get_token());
    }
};

SpoonClient::SpoonClient(std::filesystem::path data_dir, Json connection, std::string test_api_origin)
    : impl_(std::make_unique<Impl>(std::move(data_dir), connection, test_api_origin)) {}
SpoonClient::~SpoonClient() = default;

bool SpoonClient::authorized() const {
    std::lock_guard lock(impl_->token_mutex);
    return !impl_->token.is_null();
}

std::string SpoonClient::prepare_authorization(const Json&) {
    std::lock_guard lock(impl_->pending_mutex);
    const auto now = SteadyClock::now();
    std::erase_if(impl_->pending, [now](const auto& pair) { return pair.second <= now; });
    if (impl_->pending.size() >= 20) throw HttpError(429, "Too many pending authorizations. Please wait.");
    const auto state = random_hex();
    impl_->pending.emplace(state, now + std::chrono::minutes(10));
    // Consent is completed up front; feature switches only control app behavior.
    // Keep in sync with desktop/renderer/shared/spoon-permissions.js.
    const std::string scopes = "me.read live.read listeners.read fans.read events.chat events.presence events.like events.donation events.follow donations.read chat.send dj.follow";
    return "https://developers.spooncast.net/" + impl_->config.region + "/oauth/authorize?response_type=code&client_id=" +
        percent_encode(impl_->config.client_id) + "&redirect_uri=" + percent_encode(impl_->config.redirect_uri()) +
        "&state=" + percent_encode(state) + "&scope=" + percent_encode(scopes);
}

void SpoonClient::start_callback(std::function<void(std::string)> completed) {
    std::lock_guard lock(impl_->server_mutex);
    if (impl_->server) return; // Reuse the listener when the user opens consent again.
    auto server = std::make_unique<httplib::Server>();
    server->set_read_timeout(5, 0);
    server->set_write_timeout(5, 0);
    server->set_payload_max_length(16384);
    server->set_keep_alive_max_count(1);
    // The callback processes one grant at a time and accepts no remote socket.
    server->new_task_queue = [] { return new httplib::ThreadPool(2, 16); };
    server->Get("/oauth/callback", [this, completed = std::move(completed)](
                    const httplib::Request& request, httplib::Response& response) {
        response.set_header("Cache-Control", "no-store");
        response.set_header("Referrer-Policy", "no-referrer");
        response.set_header("X-Content-Type-Options", "nosniff");
        response.set_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
        const auto port = std::to_string(impl_->config.port);
        if (request.get_header_value_count("Host") != 1 || request.has_header("Origin") ||
            (request.get_header_value("Host") != "localhost:" + port &&
             request.get_header_value("Host") != "127.0.0.1:" + port)) {
            response.status = 403;
            response.set_content("Callback source is not allowed.", "text/plain; charset=utf-8");
            return;
        }
        std::string error;
        try {
            impl_->callback(request);
            const auto nonce = random_hex();
            response.headers.erase("Content-Security-Policy");
            response.set_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; script-src 'nonce-" + nonce + "'");
            response.set_content("<!doctype html><html lang=\"ja\"><meta charset=\"utf-8\">"
                "<title>Spoon Manager：連携完了</title><h1>Spoonとの連携が完了しました</h1>"
                "<p>アプリで受信を開始できます。この認証用タブは閉じてかまいません。</p>"
                "<p id=\"close-help\">自動で閉じない場合は、ブラウザーのタブを閉じてアプリに戻ってください。</p>"
                "<script nonce=\"" + nonce + "\">history.replaceState(null,'','/oauth/callback');" +
                (impl_->config.close_auth_tab ? "window.close();" : "") + "</script></html>", "text/html; charset=utf-8");
        } catch (const HttpError& failure) {
            response.status = failure.status >= 400 && failure.status < 600 ? failure.status : 500;
            error = failure.what();
            response.set_content(error, "text/plain; charset=utf-8");
        } catch (...) {
            response.status = 500;
            error = "Spoon authorization failed.";
            response.set_content(error, "text/plain; charset=utf-8");
        }
        if (completed) { try { completed(error); } catch (...) { /* Do not unwind through the server. */ } }
    });
    if (!server->bind_to_port("127.0.0.1", impl_->config.port))
        throw HttpError(500, "Authorization callback port is already in use.");
    impl_->server = std::move(server);
    try {
        impl_->server_thread = std::jthread([impl = impl_.get()] { impl->server->listen_after_bind(); });
        const auto deadline = SteadyClock::now() + std::chrono::seconds(5);
        while (!impl_->server->is_running() && SteadyClock::now() < deadline)
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        if (!impl_->server->is_running())
            throw HttpError(500, "Unable to start authorization callback.");
    } catch (...) {
        impl_->server->stop();
        if (impl_->server_thread.joinable()) impl_->server_thread.join();
        impl_->server.reset();
        throw;
    }
}

Json SpoonClient::request(const std::string& path, const std::string& method, const Json& body, std::stop_token stop) {
    validate_path(path);
    auto access = impl_->access_token(nullptr, stop);
    for (int attempt = 0; attempt < 2; ++attempt) {
        std::map<std::string, std::string> headers{{"Authorization", "Bearer " + access}, {"Accept", "application/json"}};
        if (!body.is_null()) headers["Content-Type"] = "application/json";
        const auto response = impl_->http.request(method, impl_->base + "/v1" + path, headers,
                                                   body.is_null() ? std::string{} : body.dump(), stop);
        if (response.status == 401 && attempt == 0) { access = impl_->access_token(&access, stop); continue; }
        successful(response);
        return response.status == 204 ? Json(nullptr) : parse_json(response.body);
    }
    auth_error();
}

std::string SpoonClient::granted_scopes() const {
    auto lock = token_lock(impl_->token_mutex, {});
    return text(impl_->token, "scope");
}

void SpoonClient::events(const std::function<bool(const SseFrame&)>& handler, std::stop_token stop,
                         const std::function<void()>& activity) {
    SseParser parser(handler);
    auto access = impl_->access_token(nullptr, stop);
    for (int attempt = 0; attempt < 2; ++attempt) {
        bool received = false;
        try {
            impl_->http.stream(impl_->base + "/v1/live/events",
                {{"Authorization", "Bearer " + access}, {"Accept", "text/event-stream"}},
                [&](std::string_view chunk) { received = true; if (activity) activity(); return parser.feed(chunk); }, stop);
            return;
        } catch (const HttpError& error) {
            // A handler exception must never be mistaken for a response 401,
            // nor may an already delivered event stream be replayed here.
            if (received || error.status != 401 || attempt != 0) throw;
            access = impl_->access_token(&access, stop);
        }
    }
}
}
