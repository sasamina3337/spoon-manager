#include "spoon/http.hpp"

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <winhttp.h>
#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <condition_variable>
#include <limits>
#include <mutex>
#include <utility>
#include <vector>

#ifdef _MSC_VER
#pragma comment(lib, "winhttp.lib")
#endif

namespace spoon {
HttpError::HttpError(int code, const std::string& message, std::uint64_t retry)
    : std::runtime_error(message), status(code), retry_after(retry) {}

namespace {
using Clock = std::chrono::steady_clock;
constexpr std::size_t max_body = 16 * 1024 * 1024;
constexpr std::size_t max_headers = 64 * 1024;

[[noreturn]] void network_error() { throw HttpError(502, "通信に失敗しました。ネットワークと接続先を確認してください。"); }
void check_stop(std::stop_token stop) {
    if (stop.stop_requested()) throw HttpError(0, "Request cancelled.");
}

std::wstring wide(std::string_view input) {
    if (input.empty()) return {};
    if (input.size() > static_cast<std::size_t>(std::numeric_limits<int>::max()))
        throw HttpError(400, "Invalid request text.");
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS,
                                       input.data(), static_cast<int>(input.size()), nullptr, 0);
    if (!size) throw HttpError(400, "Invalid request text.");
    std::wstring result(size, L'\0');
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, input.data(),
                            static_cast<int>(input.size()), result.data(), size)) network_error();
    return result;
}

std::string utf8(std::wstring_view input) {
    if (input.empty()) return {};
    const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.data(),
                                        static_cast<int>(input.size()), nullptr, 0, nullptr, nullptr);
    if (!size) network_error();
    std::string result(size, '\0');
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, input.data(),
                            static_cast<int>(input.size()), result.data(), size, nullptr, nullptr))
        network_error();
    return result;
}

std::string lower(std::string value) {
    for (char& c : value) if (c >= 'A' && c <= 'Z') c += 'a' - 'A';
    return value;
}

struct Url {
    std::wstring host, target;
    INTERNET_PORT port;
    bool secure;
};

Url parse_url(const std::string& value) {
    if (value.empty() || value.size() > 16384 ||
        value.find_first_of("#\\") != std::string::npos ||
        std::any_of(value.begin(), value.end(), [](unsigned char c) { return c <= 32 || c == 127; }))
        throw HttpError(400, "Invalid HTTP URL.");
    const auto text = wide(value);
    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwHostNameLength = parts.dwUrlPathLength = parts.dwExtraInfoLength =
        parts.dwUserNameLength = parts.dwPasswordLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(text.c_str(), static_cast<DWORD>(text.size()), 0, &parts) ||
        (parts.nScheme != INTERNET_SCHEME_HTTP && parts.nScheme != INTERNET_SCHEME_HTTPS) ||
        !parts.dwHostNameLength || parts.dwUserNameLength || parts.dwPasswordLength || !parts.nPort)
        throw HttpError(400, "Invalid HTTP URL.");
    // An empty userinfo component is forbidden too.
    const auto authority_begin = value.find("://");
    const auto authority_end = value.find_first_of("/?", authority_begin + 3);
    if (authority_begin == std::string::npos ||
        value.substr(authority_begin + 3, authority_end - authority_begin - 3).find('@') != std::string::npos)
        throw HttpError(400, "Invalid HTTP URL.");
    Url result{std::wstring(parts.lpszHostName, parts.dwHostNameLength), {}, parts.nPort,
               parts.nScheme == INTERNET_SCHEME_HTTPS};
    if (parts.dwUrlPathLength) result.target.assign(parts.lpszUrlPath, parts.dwUrlPathLength);
    if (result.target.empty()) result.target = L"/";
    if (parts.dwExtraInfoLength) result.target.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
    return result;
}

struct Handle {
    HINTERNET value = nullptr;
    explicit Handle(HINTERNET handle) : value(handle) { if (!value) network_error(); }
    ~Handle() { if (value) WinHttpCloseHandle(value); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
};

// Only the waiting thread closes the request. Async WinHTTP lets cancellation
// close an outstanding operation safely; HANDLE_CLOSING keeps callback state
// alive until WinHTTP has finished using it.
class AsyncRequest {
public:
    explicit AsyncRequest(HINTERNET request) : handle_(request) {
        if (!handle_) network_error();
        DWORD_PTR context = reinterpret_cast<DWORD_PTR>(this);
        if (!WinHttpSetOption(handle_, WINHTTP_OPTION_CONTEXT_VALUE, &context, sizeof(context))) {
            WinHttpCloseHandle(handle_);
            network_error();
        }
        if (WinHttpSetStatusCallback(handle_, callback,
                WINHTTP_CALLBACK_FLAG_ALL_COMPLETIONS | WINHTTP_CALLBACK_FLAG_HANDLES, 0) ==
            WINHTTP_INVALID_STATUS_CALLBACK) {
            WinHttpCloseHandle(handle_);
            network_error();
        }
    }
    ~AsyncRequest() {
        WinHttpCloseHandle(handle_);
        std::unique_lock lock(mutex_);
        changed_.wait(lock, [&] { return closed_; });
    }
    AsyncRequest(const AsyncRequest&) = delete;
    AsyncRequest& operator=(const AsyncRequest&) = delete;
    HINTERNET get() const { return handle_; }

    void started(BOOL result) {
        if (!result && GetLastError() != ERROR_IO_PENDING) network_error();
    }
    DWORD wait(DWORD expected, Clock::time_point deadline, std::stop_token stop) {
        std::stop_callback wake(stop, [this] {
            // Synchronize with the predicate-to-wait transition so cancellation
            // cannot notify just before this thread starts waiting.
            std::lock_guard lock(mutex_);
            changed_.notify_all();
        });
        std::unique_lock lock(mutex_);
        if (!changed_.wait_until(lock, deadline, [&] {
                return completion_ == expected || failed_ || stop.stop_requested();
            })) throw HttpError(504, "通信がタイムアウトしました。接続先の応答を確認してください。");
        check_stop(stop);
        if (failed_) network_error();
        completion_ = 0;
        return read_size_;
    }
private:
    static void CALLBACK callback(HINTERNET, DWORD_PTR context, DWORD status,
                                  void* information, DWORD size) noexcept {
        if (!context) return;
        auto& self = *reinterpret_cast<AsyncRequest*>(context);
        std::lock_guard lock(self.mutex_);
        if (status == WINHTTP_CALLBACK_STATUS_HANDLE_CLOSING) self.closed_ = true;
        else if (status == WINHTTP_CALLBACK_STATUS_REQUEST_ERROR) self.failed_ = true;
        else if (status == WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE ||
                 status == WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE ||
                 status == WINHTTP_CALLBACK_STATUS_READ_COMPLETE ||
                 status == WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE) {
            self.completion_ = status;
            self.read_size_ = status == WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE && information
                ? *static_cast<DWORD*>(information) : size;
        }
        self.changed_.notify_all();
    }
    HINTERNET handle_;
    std::mutex mutex_;
    std::condition_variable changed_;
    DWORD completion_ = 0, read_size_ = 0;
    bool failed_ = false, closed_ = false;
};

bool token_character(unsigned char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
           (c >= '0' && c <= '9') || std::string_view("!#$%&'*+-.^_`|~").find(c) != std::string_view::npos;
}

std::wstring make_headers(const std::map<std::string, std::string>& headers) {
    std::string result;
    for (const auto& [name, value] : headers) {
        const auto normalized = lower(name);
        if (name.empty() || !std::all_of(name.begin(), name.end(), token_character) ||
            std::any_of(value.begin(), value.end(), [](unsigned char c) { return c < 32 || c == 127; }) ||
            normalized == "host" || normalized == "content-length" || normalized == "transfer-encoding" ||
            normalized == "connection" || result.size() + name.size() + value.size() + 4 > max_headers)
            throw HttpError(400, "Invalid HTTP headers.");
        result += name + ": " + value + "\r\n";
    }
    return wide(result);
}

void read_headers(HINTERNET request, HttpResponse& response) {
    DWORD status_size = sizeof(DWORD), status = 0;
    if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &status, &status_size, WINHTTP_NO_HEADER_INDEX))
        network_error();
    response.status = static_cast<int>(status);
    DWORD size = 0;
    WinHttpQueryHeaders(request, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX,
                        nullptr, &size, WINHTTP_NO_HEADER_INDEX);
    if (!size || size > max_headers) throw HttpError(502, "HTTP headers are too large.");
    std::vector<wchar_t> raw(size / sizeof(wchar_t) + 1, L'\0');
    if (!WinHttpQueryHeaders(request, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_HEADER_NAME_BY_INDEX,
                             raw.data(), &size, WINHTTP_NO_HEADER_INDEX)) network_error();
    const auto text = utf8(std::wstring_view(raw.data()));
    auto start = text.find("\r\n");
    while (start != std::string::npos) {
        start += 2;
        const auto end = text.find("\r\n", start);
        if (end == std::string::npos || end == start) break;
        const auto colon = text.find(':', start);
        if (colon < end) {
            auto first = colon + 1;
            while (first < end && (text[first] == ' ' || text[first] == '\t')) ++first;
            response.headers[lower(text.substr(start, colon - start))] = text.substr(first, end - first);
        }
        start = end;
    }
}

std::uint64_t retry_after(const HttpResponse& response) {
    const auto it = response.headers.find("retry-after");
    if (it == response.headers.end()) return 0;
    std::uint64_t seconds = 0;
    const auto parsed = std::from_chars(it->second.data(), it->second.data() + it->second.size(), seconds);
    return parsed.ec == std::errc{} && parsed.ptr == it->second.data() + it->second.size() ? seconds : 0;
}

HttpResponse perform(const std::string& method, const std::string& url,
                     const std::map<std::string, std::string>& headers, const std::string& body,
                     const std::function<bool(std::string_view)>* sink, std::stop_token stop) {
    check_stop(stop);
    if (method.empty() || !std::all_of(method.begin(), method.end(), token_character) || body.size() > max_body)
        throw HttpError(400, "Invalid HTTP request.");
    const auto parsed = parse_url(url);
    const auto header_text = make_headers(headers);
    const auto verb = wide(method);
    const auto deadline = Clock::now() + std::chrono::seconds(25);
    Handle session(WinHttpOpen(L"SpoonManager/1.0", WINHTTP_ACCESS_TYPE_NO_PROXY,
                              WINHTTP_NO_PROXY_NAME, WINHTTP_NO_PROXY_BYPASS, WINHTTP_FLAG_ASYNC));
    if (!WinHttpSetTimeouts(session.value, 5000, 5000, 10000, sink ? 45000 : 10000)) network_error();
    // TLS validation remains enabled. Restrict protocols to TLS 1.2 or newer.
    DWORD protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
#ifdef WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3
    protocols |= WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_3;
#endif
    if (!WinHttpSetOption(session.value, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols))) {
        // Older supported Windows versions do not understand the TLS 1.3 flag.
        protocols = WINHTTP_FLAG_SECURE_PROTOCOL_TLS1_2;
        if (!WinHttpSetOption(session.value, WINHTTP_OPTION_SECURE_PROTOCOLS, &protocols, sizeof(protocols)))
            network_error();
    }
    Handle connection(WinHttpConnect(session.value, parsed.host.c_str(), parsed.port, 0));
    // Declared before the request so an outstanding read cannot outlive its buffer.
    std::array<char, 16384> buffer{};
    AsyncRequest request(WinHttpOpenRequest(connection.value, verb.c_str(), parsed.target.c_str(), nullptr,
                                            WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
                                            parsed.secure ? WINHTTP_FLAG_SECURE : 0));
    DWORD disabled = WINHTTP_DISABLE_REDIRECTS | WINHTTP_DISABLE_COOKIES | WINHTTP_DISABLE_AUTHENTICATION;
    if (!WinHttpSetOption(request.get(), WINHTTP_OPTION_DISABLE_FEATURE, &disabled, sizeof(disabled)))
        network_error();
    DWORD header_limit = static_cast<DWORD>(max_headers);
    if (!WinHttpSetOption(request.get(), WINHTTP_OPTION_MAX_RESPONSE_HEADER_SIZE,
                          &header_limit, sizeof(header_limit))) network_error();
    // WinHTTP never follows a redirect or retries a failed grant in application code.
    request.started(WinHttpSendRequest(request.get(), header_text.empty() ? WINHTTP_NO_ADDITIONAL_HEADERS : header_text.c_str(),
                                      static_cast<DWORD>(header_text.size()),
                                      body.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char*>(body.data()),
                                      static_cast<DWORD>(body.size()), static_cast<DWORD>(body.size()),
                                      reinterpret_cast<DWORD_PTR>(&request)));
    request.wait(WINHTTP_CALLBACK_STATUS_SENDREQUEST_COMPLETE, deadline, stop);
    request.started(WinHttpReceiveResponse(request.get(), nullptr));
    request.wait(WINHTTP_CALLBACK_STATUS_HEADERS_AVAILABLE, deadline, stop);
    HttpResponse response;
    read_headers(request.get(), response);
    if (response.status >= 300 && response.status < 400)
        throw HttpError(response.status, "HTTP redirects are not allowed.");
    if (sink) {
        if (response.status < 200 || response.status >= 300)
            throw HttpError(response.status, "Event request failed.", retry_after(response));
        const auto type = lower(response.headers["content-type"]);
        const auto separator = type.find(';');
        auto media = type.substr(0, separator);
        while (!media.empty() && media.back() == ' ') media.pop_back();
        if (media != "text/event-stream") throw HttpError(502, "Invalid event stream response.");
    }
    for (;;) {
        check_stop(stop);
        // Reading a full 16 KB on a never-ending SSE response can wait for the
        // buffer to fill. Read only bytes WinHTTP has actually received, so a
        // single comment or heartbeat is delivered before the next one arrives.
        DWORD wanted = static_cast<DWORD>(buffer.size());
        if (sink) {
            request.started(WinHttpQueryDataAvailable(request.get(), nullptr));
            const auto available = request.wait(WINHTTP_CALLBACK_STATUS_DATA_AVAILABLE,
                Clock::now() + std::chrono::seconds(45), stop);
            if (!available) break;
            wanted = std::min(wanted, available);
        }
        request.started(WinHttpReadData(request.get(), buffer.data(), wanted, nullptr));
        const auto size = request.wait(WINHTTP_CALLBACK_STATUS_READ_COMPLETE,
                                      sink ? Clock::now() + std::chrono::seconds(45) : deadline, stop);
        if (!size) break;
        check_stop(stop);
        if (sink) {
            if (!(*sink)(std::string_view(buffer.data(), size))) break;
        } else {
            if (response.body.size() + size > max_body) throw HttpError(502, "HTTP response is too large.");
            response.body.append(buffer.data(), size);
        }
    }
    return response;
}
}

HttpResponse HttpClient::request(const std::string& method, const std::string& url,
                                 const std::map<std::string, std::string>& headers,
                                 const std::string& body, std::stop_token stop) const {
    return perform(method, url, headers, body, nullptr, stop);
}

void HttpClient::stream(const std::string& url, const std::map<std::string, std::string>& headers,
                        const std::function<bool(std::string_view)>& sink, std::stop_token stop) const {
    if (!sink) throw HttpError(400, "An event handler is required.");
    perform("GET", url, headers, {}, &sink, stop);
}

std::string percent_encode(std::string_view value) {
    constexpr char digits[] = "0123456789ABCDEF";
    std::string result;
    for (unsigned char c : value) {
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') result += c;
        else { result += '%'; result += digits[c >> 4]; result += digits[c & 15]; }
    }
    return result;
}

bool is_loopback_origin(const std::string& origin) {
    try {
        const auto url = parse_url(origin);
        const auto separator = origin.find("://");
        const auto path = origin.find_first_of("/?", separator + 3);
        const auto authority = lower(origin.substr(separator + 3, path - separator - 3));
        // Validate the raw authority as well, avoiding alternate numeric spellings
        // and escaped hosts that Windows might normalize before connecting.
        const auto host_end = authority.starts_with('[') ? authority.find(']') + 1 : authority.find(':');
        const auto host = authority.substr(0, host_end);
        if (host != "localhost" && host != "127.0.0.1" && host != "[::1]") return false;
        if (host.size() != authority.size()) {
            const auto port = std::string_view(authority).substr(host.size());
            if (port.size() < 2 || port.front() != ':' ||
                !std::all_of(port.begin() + 1, port.end(), [](unsigned char c) { return c >= '0' && c <= '9'; }))
                return false;
            unsigned number = 0;
            const auto parsed = std::from_chars(port.data() + 1, port.data() + port.size(), number);
            if (parsed.ec != std::errc{} || number == 0 || number > 65535) return false;
        }
        return url.target == L"/" &&
               (path == std::string::npos || origin.substr(path) == "/");
    } catch (...) { return false; }
}
}
