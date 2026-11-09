#pragma once

#include <cstdint>
#include <functional>
#include <map>
#include <stdexcept>
#include <stop_token>
#include <string>
#include <string_view>

namespace spoon {
struct HttpResponse {
    int status = 0;
    std::string body;
    // Response header names are lowercase.
    std::map<std::string, std::string> headers;
};

// Messages are fixed local text; remote bodies, URLs and credentials never enter errors.
class HttpError : public std::runtime_error {
public:
    explicit HttpError(int status, const std::string& message,
                       std::uint64_t retry_after = 0);
    const int status;
    const std::uint64_t retry_after;
};

class HttpClient {
public:
    HttpResponse request(const std::string& method, const std::string& url,
                         const std::map<std::string, std::string>& headers = {},
                         const std::string& body = {}, std::stop_token stop = {}) const;
    // Requires a successful text/event-stream response. False stops reading immediately.
    void stream(const std::string& url, const std::map<std::string, std::string>& headers,
                const std::function<bool(std::string_view)>& sink,
                std::stop_token stop = {}) const;
};

std::string percent_encode(std::string_view value);
// Only an explicit HTTP(S) origin with a literal loopback host is accepted.
bool is_loopback_origin(const std::string& origin);
}
