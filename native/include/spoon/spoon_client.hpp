#pragma once

#include "spoon/http.hpp"
#include <filesystem>
#include <memory>
#include <nlohmann/json.hpp>

namespace spoon {
using Json = nlohmann::json;

struct SseFrame {
    std::string id, event, data;
};

// Incremental byte parser: UTF-8 and CRLF may span chunks. Unterminated EOF frames
// are discarded, matching the renderer. Each line and complete frame is bounded.
class SseParser {
public:
    explicit SseParser(std::function<bool(const SseFrame&)> handler);
    bool feed(std::string_view bytes);
private:
    bool line();
    std::function<bool(const SseFrame&)> handler_;
    std::string line_;
    SseFrame frame_;
    std::size_t frame_size_ = 0;
    bool data_seen_ = false, skip_lf_ = false, stopped_ = false;
    std::string prefix_;
    bool prefix_done_ = false;
};

class SpoonClient {
public:
    SpoonClient(std::filesystem::path data_dir, Json connection,
                std::string test_api_origin = "");
    ~SpoonClient();
    SpoonClient(const SpoonClient&) = delete;
    SpoonClient& operator=(const SpoonClient&) = delete;

    bool authorized() const;
    std::string granted_scopes() const;
    std::string prepare_authorization(const Json& features);
    // Binds synchronously; completion runs on a server worker with an empty
    // string on success or a fixed safe error message. Keep the client alive
    // until the callback returns; do not destroy it from that callback.
    void start_callback(std::function<void(std::string)> completed);
    Json request(const std::string& path, const std::string& method = "GET",
                 const Json& body = nullptr, std::stop_token stop = {});
    void events(const std::function<bool(const SseFrame&)>& handler,
                std::stop_token stop = {}, const std::function<void()>& activity = {});
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
}
