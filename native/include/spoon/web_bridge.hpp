#pragma once

#include "spoon/application.hpp"

namespace spoon {

// A synchronous, allowlisted adapter for the WebView2 host. The host calls
// dispatch on its serialized worker and keeps Application alive for its lifetime.
// No renderer operation accepts a filesystem path, arbitrary URL or raw request.
class WebBridge {
public:
    explicit WebBridge(Application& application);

    // Read operations return facade values; mutations return JSON null.
    // Payloads must be objects with exactly the operation's documented fields.
    // Invalid payloads and unsupported operations throw std::invalid_argument;
    // facade failures propagate to the host's error response handler.
    Json dispatch(std::string operation, const Json& input = Json::object());

private:
    Application& application_;
};

}
