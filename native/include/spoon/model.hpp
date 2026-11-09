#pragma once

#include <nlohmann/json.hpp>

#include <cstdint>
#include <functional>
#include <string>
#include <unordered_map>
#include <unordered_set>

namespace spoon {

using Json = nlohmann::json;

// In-memory domain model for the existing state.json envelope. No file I/O or
// threads: callers synchronize access and persist snapshot() themselves. Parsing
// errors / corrupt files belong to the storage boundary, not to this class.
class Model {
public:
    using Clock = std::function<std::int64_t()>; // Unix milliseconds, UTC.

    explicit Model(Json state = Json::object());
    Model(Json state, Clock now);

    // Full persistence state, not the renderer's derived ManagerStore.snapshot.
    // Unrecognized properties survive, including at nested object boundaries.
    Json snapshot() const;
    // Recursive object patch; arrays/scalars (including null) replace values.
    void set_settings(const Json& settings);
    // Validate manager goals/templates and merge into manager.preferences.
    void set_preferences(const Json& preferences);
    void begin_session(const std::string& key, const Json& live);
    bool record(const std::string& key, const Json& event);
    void observe(const std::string& key, const Json& users);
    void finish_session(const std::string& key);
    void set_donations(const std::string& key, const Json& rows);
    void set_runtime(const Json& runtime);

    // UTF-8 BOM, quoted cells and CRLF rows, matching the desktop exports.
    // Missing session exports contain just the header. Analytics exports the
    // latest 10 saved sessions for the active (or first retained) session's DJ,
    // ordered oldest first, matching the desktop's default analysis range.
    std::string participants_csv(const std::string& key) const;
    std::string logs_csv(const std::string& key) const;
    std::string analytics_csv() const;

private:
    Json state_;
    Clock now_;
    std::string active_key_; // Runtime state, deliberately never persisted.
    std::unordered_map<std::string, std::unordered_set<std::string>> seen_;

    Json* session(const std::string& key);
    const Json* session(const std::string& key) const;
    Json* user(Json& session, const Json& input, const std::string& stamp);
};

} // namespace spoon
