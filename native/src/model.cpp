#include "spoon/model.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cmath>
#include <iomanip>
#include <limits>
#include <locale>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <vector>

namespace spoon {
namespace {

constexpr std::size_t max_sessions = 100;
constexpr std::size_t max_users = 1000;
constexpr std::size_t max_events = 10000;
constexpr std::size_t max_seen = 20000;
constexpr std::array fields{"comments", "entries", "hearts", "spoons", "follows"};
const Json missing = nullptr;

const Json& member(const Json& object, const char* key) {
    const auto it = object.is_object() ? object.find(key) : object.end();
    return it == object.end() ? missing : *it;
}

std::string text(const Json& value) {
    if (value.is_null() || value.is_object()) return value.is_null() ? "" : "[object Object]";
    if (value.is_string()) return value.get<std::string>();
    return value.dump(-1, ' ', false, Json::error_handler_t::replace);
}

std::string string_member(const Json& value, const char* key) {
    const auto& found = member(value, key);
    return found.is_string() ? found.get<std::string>() : "";
}

bool yes(const Json& value, const char* key) {
    return member(value, key) == true;
}

// JavaScript's limits are UTF-16 code units, not UTF-8 bytes. Never split a
// multibyte code point (nor emit an unpaired surrogate for a clipped emoji).
std::string clip(const std::string& value, std::size_t limit) {
    std::size_t i = 0, units = 0;
    while (i < value.size()) {
        const auto lead = static_cast<unsigned char>(value[i]);
        const std::size_t bytes = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
        const std::size_t cost = bytes == 4 ? 2 : 1;
        if (units + cost > limit || i + bytes > value.size()) break;
        i += bytes;
        units += cost;
    }
    return value.substr(0, i);
}

std::string trim(std::string value) {
    const auto first = value.find_first_not_of(" \t\r\n\v\f");
    if (first == std::string::npos) return "";
    const auto last = value.find_last_not_of(" \t\r\n\v\f");
    return value.substr(first, last - first + 1);
}

void merge(Json& destination, const Json& patch) {
    for (const auto& [key, value] : patch.items()) {
        if (value.is_object() && destination.contains(key) && destination[key].is_object())
            merge(destination[key], value);
        else destination[key] = value;
    }
}

void defaults(Json& object, const Json& values) {
    for (const auto& [key, value] : values.items()) {
        if (!object.contains(key)) object[key] = value;
    }
}

Json totals() {
    return { {"comments", 0}, {"entries", 0}, {"hearts", 0}, {"spoons", 0}, {"follows", 0} };
}

Json preferences() {
    return {{"heartGoal", 100}, {"spoonGoal", 100},
        {"features", {{"fans", false}, {"follow", false}, {"chat", false}, {"djFollow", false}, {"donations", false}}},
        {"commands", {{"enabled", true}, {"cooldownSeconds", 10}}},
        {"templates", Json::array({
            {{"label", "配信のご案内"}, {"text", "遊びに来てくれてありがとうございます！気軽にコメントしてくださいね。"}},
            {{"label", "お礼"}, {"text", "ハートとスプーン、ありがとうございます！"}}})}};
}

// ISO 8601 public API timestamps, explicit UTC / offsets, and date-only legacy
// stamps. No machine-local time conversion, so JST boundaries are reproducible.
std::optional<std::int64_t> parse_time(const Json& value) {
    if (value.is_number()) {
        const double number = value.get<double>();
        if (std::isfinite(number) && std::abs(number) <= 8640000000000000.0)
            return static_cast<std::int64_t>(number);
        return std::nullopt;
    }
    if (!value.is_string()) return std::nullopt;
    const auto s = value.get<std::string>();
    auto digits = [&](std::size_t start, std::size_t length) -> int {
        if (start + length > s.size()) return -1;
        int result = 0;
        for (std::size_t i = start; i < start + length; ++i) {
            if (s[i] < '0' || s[i] > '9') return -1;
            result = result * 10 + s[i] - '0';
        }
        return result;
    };
    if (s.size() < 10 || s[4] != '-' || s[7] != '-') return std::nullopt;
    const int y = digits(0, 4), m = digits(5, 2), d = digits(8, 2);
    const std::chrono::year_month_day date{std::chrono::year{y},
        std::chrono::month{static_cast<unsigned>(m)}, std::chrono::day{static_cast<unsigned>(d)}};
    if (y < 0 || !date.ok()) return std::nullopt;
    auto result = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::sys_days{date}.time_since_epoch()).count();
    if (s.size() == 10) return result;
    if (s.size() < 19 || (s[10] != 'T' && s[10] != 't' && s[10] != ' ') || s[13] != ':' || s[16] != ':')
        return std::nullopt;
    const int h = digits(11, 2), min = digits(14, 2), sec = digits(17, 2);
    if (h < 0 || h > 23 || min < 0 || min > 59 || sec < 0 || sec > 59) return std::nullopt;
    result += ((h * 60LL + min) * 60 + sec) * 1000;
    std::size_t pos = 19;
    if (pos < s.size() && s[pos] == '.') {
        ++pos;
        const auto start = pos;
        int millis = 0;
        while (pos < s.size() && s[pos] >= '0' && s[pos] <= '9') {
            if (pos - start < 3) millis = millis * 10 + s[pos] - '0';
            ++pos;
        }
        if (pos == start) return std::nullopt;
        for (auto n = pos - start; n < 3; ++n) millis *= 10;
        result += millis;
    }
    if (pos == s.size() - 1 && (s[pos] == 'Z' || s[pos] == 'z')) return result;
    if (pos + 6 != s.size() || (s[pos] != '+' && s[pos] != '-') || s[pos + 3] != ':')
        return std::nullopt;
    const int oh = digits(pos + 1, 2), om = digits(pos + 4, 2);
    if (oh < 0 || oh > 23 || om < 0 || om > 59) return std::nullopt;
    return result - (s[pos] == '+' ? 1 : -1) * (oh * 60LL + om) * 60000;
}

std::string timestamp(std::int64_t milliseconds) {
    using namespace std::chrono;
    const sys_time<std::chrono::milliseconds> time{std::chrono::milliseconds{milliseconds}};
    const auto day = floor<days>(time);
    const year_month_day date{day};
    const hh_mm_ss clock{time - day};
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::setfill('0') << std::setw(4) << int(date.year()) << '-'
        << std::setw(2) << unsigned(date.month()) << '-' << std::setw(2) << unsigned(date.day())
        << 'T' << std::setw(2) << clock.hours().count() << ':' << std::setw(2) << clock.minutes().count()
        << ':' << std::setw(2) << clock.seconds().count() << '.' << std::setw(3)
        << clock.subseconds().count() << 'Z';
    return out.str();
}

std::string owner(const std::string& key) {
    if (key.starts_with("dom:")) return key;
    const auto colon = key.rfind(':');
    return colon == std::string::npos ? key.substr(0, key.empty() ? 0 : key.size() - 1) : key.substr(0, colon);
}

bool attendance_type(const std::string& type) {
    return type == "entry" || type == "comment" || type == "heart" || type == "spoon" || type == "follow";
}

void visit(const Json& session, Json& user, const Json& time, bool entry = false) {
    const auto dj = owner(string_member(session, "key"));
    if (string_member(user, "id") == dj + ":" + (dj.size() > 4 ? dj.substr(4) : "")) return;
    const auto instant = parse_time(time);
    if (!instant) return;
    const auto date = timestamp(*instant + 9 * 3600000LL).substr(0, 10);
    const auto stamp = timestamp(*instant);
    if (!user.contains("visits") || !user["visits"].is_object()) user["visits"] = Json::object();
    auto& visits = user["visits"];
    if (!visits.contains(date)) visits[date] = {{"firstSeen", stamp}, {"lastSeen", stamp}, {"entries", 0}};
    auto& day = visits[date];
    if (stamp < string_member(day, "firstSeen")) day["firstSeen"] = stamp;
    if (stamp > string_member(day, "lastSeen")) day["lastSeen"] = stamp;
    if (entry) day["entries"] = day.value("entries", 0LL) + 1;
}

void retain(Json& array, std::size_t count, bool newest) {
    if (array.size() <= count) return;
    if (newest) array.erase(array.begin(), array.end() - static_cast<Json::difference_type>(count));
    else array.erase(array.begin() + static_cast<Json::difference_type>(count), array.end());
}

std::optional<double> converted_number(const Json& value) {
    if (value.is_number()) {
        const auto result = value.get<double>();
        return std::isfinite(result) ? std::optional(result) : std::nullopt;
    }
    if (value.is_boolean()) return value.get<bool>() ? 1 : 0;
    if (value.is_null()) return 0;
    if (!value.is_string()) return std::nullopt;
    auto s = value.get<std::string>();
    const auto start = s.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) return 0;
    const auto end = s.find_last_not_of(" \t\r\n");
    std::string_view trimmed(s.data() + start, end - start + 1);
    if (trimmed.starts_with('+')) {
        trimmed.remove_prefix(1);
        if (trimmed.empty() || trimmed.starts_with('-') || trimmed.starts_with('+')) return std::nullopt;
    }
    double result = 0;
    const auto parsed = std::from_chars(trimmed.data(), trimmed.data() + trimmed.size(), result);
    if (parsed.ec != std::errc{} || parsed.ptr != trimmed.data() + trimmed.size() || !std::isfinite(result)) return std::nullopt;
    return result;
}

double number(const Json& value) {
    return converted_number(value).value_or(0);
}

Json numeric(double value) {
    if (value >= 0 && value < 9223372036854775808.0 && std::floor(value) == value)
        return static_cast<std::int64_t>(value);
    return value;
}

void add(Json& target, const char* field, double amount) {
    const auto sum = number(member(target, field)) + amount;
    target[field] = numeric(std::isfinite(sum) ? sum : std::numeric_limits<double>::max());
}

std::string cell(const Json& value) {
    std::string result = text(value);
    std::size_t first = 0;
    while (first < result.size() && static_cast<unsigned char>(result[first]) <= 0x20) ++first;
    // Unicode whitespace that JS's \s recognizes (UTF-8), including fullwidth
    // spaces and BOM. Inspect repeatedly to cover mixed whitespace prefixes.
    constexpr std::array<std::string_view, 18> spaces{"\xc2\xa0", "\xe1\x9a\x80", "\xe2\x80\x80", "\xe2\x80\x81",
        "\xe2\x80\x82", "\xe2\x80\x83", "\xe2\x80\x84", "\xe2\x80\x85", "\xe2\x80\x86", "\xe2\x80\x87",
        "\xe2\x80\x88", "\xe2\x80\x89", "\xe2\x80\x8a", "\xe2\x80\xa8", "\xe2\x80\xa9", "\xe2\x80\xaf",
        "\xe2\x81\x9f", "\xe3\x80\x80"};
    bool advanced = true;
    while (advanced && first < result.size()) {
        advanced = false;
        const auto tail = std::string_view(result).substr(first);
        if (static_cast<unsigned char>(result[first]) <= 0x20) { ++first; advanced = true; }
        else if (tail.starts_with("\xef\xbb\xbf")) {first += 3; advanced = true;}
        else for (const auto space : spaces) if (tail.starts_with(space)) {first += space.size(); advanced = true; break;}
    }
    if ((!result.empty() && (result[0] == '\t' || result[0] == '\r' || result[0] == '\n')) ||
        (first < result.size() && std::string_view("=+@-").find(result[first]) != std::string_view::npos))
        result.insert(result.begin(), '\'');
    std::string quoted = "\"";
    for (const auto c : result) {quoted += c; if (c == '"') quoted += '"';}
    return quoted + '"';
}

void row(std::string& csv, const Json& values) {
    if (csv.size() > 3) csv += "\r\n";
    bool first = true;
    for (const auto& value : values) {
        if (!first) csv += ',';
        csv += cell(value);
        first = false;
    }
}

std::string fixed(double value, int precision) {
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::fixed << std::setprecision(precision) << value;
    return out.str();
}

std::string event_label(const std::string& type) {
    if (type == "comment") return "コメント";
    if (type == "entry") return "入室";
    if (type == "heart") return "ハート";
    if (type == "spoon") return "スプーン";
    if (type == "follow") return "フォロー";
    if (type == "temperature") return "温度";
    if (type == "question") return "質問箱";
    if (type == "automatic") return "自動コメント";
    if (type == "automaticError") return "自動コメント失敗";
    if (type == "bot") return "ボット送信";
    if (type == "botError") return "ボット送信失敗";
    return type;
}

} // namespace

Model::Model(Json state) : Model(std::move(state), [] {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
}) {}

Model::Model(Json state, Clock now) : state_(std::move(state)), now_(std::move(now)) {
    if (!state_.is_object()) throw std::invalid_argument("Model state must be an object");
    if (!now_) throw std::invalid_argument("Model clock is required");
    if (!state_.contains("settings")) state_["settings"] = Json::object();
    if (!state_.contains("manager")) state_["manager"] = Json::object();
    auto& manager = state_["manager"];
    if (!manager.is_object()) throw std::invalid_argument("manager must be an object");
    defaults(manager, {{"preferences", preferences()}, {"sessions", Json::array()}, {"playroom", {{"profiles", Json::array()}}}});
    if (!manager["sessions"].is_array()) throw std::invalid_argument("sessions must be an array");
    retain(manager["sessions"], max_sessions, false);
    for (auto& saved : manager["sessions"]) {
        if (!saved.is_object() || !member(saved, "key").is_string() ||
            !member(saved, "users").is_array() || !member(saved, "events").is_array())
            throw std::invalid_argument("Invalid saved session");
        defaults(saved, {{"seen", Json::array()}, {"totals", totals()}, {"live", Json::object()},
            {"requests", {{"open", false}, {"items", Json::array()}}}});
        retain(saved["users"], max_users, false);
        retain(saved["events"], max_events, true);
        retain(saved["seen"], max_seen, true);
        for (const auto& id : saved["seen"]) if (id.is_string()) seen_[saved["key"].get<std::string>()].insert(id.get<std::string>());
        for (auto& person : saved["users"]) {
            if (person.contains("visits") && person["visits"].is_object()) continue;
            person["visits"] = Json::object();
            visit(saved, person, member(person, "firstSeen"));
            visit(saved, person, member(person, "lastSeen"));
            for (const auto& event : saved["events"]) {
                const auto type = string_member(event, "type");
                if (member(member(event, "user"), "id") == member(person, "id") && !yes(event, "isDj") && attendance_type(type))
                    visit(saved, person, member(event, "time"), type == "entry");
            }
        }
    }
}

Json Model::snapshot() const { return state_; }

void Model::set_settings(const Json& settings) {
    if (!settings.is_object()) throw std::invalid_argument("settings patch must be an object");
    if (!state_["settings"].is_object()) throw std::invalid_argument("saved settings must be an object");
    merge(state_["settings"], settings);
}

void Model::set_preferences(const Json& patch) {
    if (!patch.is_object()) throw std::invalid_argument("preferences patch must be an object");
    auto candidate = preferences();
    const auto& saved = state_["manager"]["preferences"];
    if (!saved.is_object()) throw std::invalid_argument("saved preferences must be an object");
    merge(candidate, saved);
    merge(candidate, patch);
    for (const auto* field : {"heartGoal", "spoonGoal"}) {
        const auto& value = candidate[field];
        // Number() coercion matches the old UI, but invalid strings must not
        // silently become zero as they do for best-effort event quantities.
        const auto goal = value.is_null() ? std::optional(100.0) : converted_number(value);
        if (!goal || *goal < 0 || *goal > 1000000000 || std::floor(*goal) != *goal)
            throw std::invalid_argument("Goals must be integers from 0 to 1000000000");
        candidate[field] = numeric(*goal);
    }
    if (!candidate["features"].is_object() || !candidate["commands"].is_object())
        throw std::invalid_argument("features and commands must be objects");
    for (const auto* feature : {"fans", "follow", "chat", "djFollow", "donations"})
        candidate["features"][feature] = yes(candidate["features"], feature);
    auto& commands = candidate["commands"];
    commands["enabled"] = member(commands, "enabled") != false;
    const auto cooldown = number(member(commands, "cooldownSeconds"));
    commands["cooldownSeconds"] = numeric(std::clamp(std::trunc(cooldown == 0 ? 10 : cooldown), 10.0, 120.0));
    if (candidate["templates"].is_null()) candidate["templates"] = preferences()["templates"];
    if (!candidate["templates"].is_array() || candidate["templates"].size() > 8)
        throw std::invalid_argument("At most 8 templates are allowed");
    for (auto& item : candidate["templates"]) {
        const auto label = trim(text(member(item, "label")));
        const auto body = trim(text(member(item, "text")));
        if (!item.is_object() || label.empty() || body.empty() || clip(label, 40) != label || clip(body, 200) != body)
            throw std::invalid_argument("Template label/text must contain 1-40 / 1-200 UTF-16 units");
        item["label"] = label;
        item["text"] = body;
    }
    state_["manager"]["preferences"] = std::move(candidate);
}

Json* Model::session(const std::string& key) {
    for (auto& saved : state_["manager"]["sessions"]) if (member(saved, "key") == key) return &saved;
    return nullptr;
}

const Json* Model::session(const std::string& key) const {
    for (const auto& saved : state_["manager"]["sessions"]) if (member(saved, "key") == key) return &saved;
    return nullptr;
}

void Model::begin_session(const std::string& key, const Json& live) {
    if (key.empty()) throw std::invalid_argument("session key must not be empty");
    if (!live.is_null() && !live.is_object()) throw std::invalid_argument("live must be an object or null");
    auto* saved = session(key);
    const auto stamp = timestamp(now_());
    if (!saved) {
        auto& sessions = state_["manager"]["sessions"];
        Json fresh = {{"key", key}, {"live", Json::object()}, {"observedAt", stamp},
            {"endedAt", nullptr}, {"users", Json::array()}, {"events", Json::array()}, {"seen", Json::array()},
            {"totals", totals()}, {"requests", {{"open", false}, {"items", Json::array()}}}};
        sessions.insert(sessions.begin(), std::move(fresh));
        if (sessions.size() > max_sessions) {
            seen_.erase(string_member(sessions.back(), "key"));
            retain(sessions, max_sessions, false);
        }
        saved = &sessions.front();
    }
    if (live.is_object()) {
        // Preserve future saved live fields, but accept only the documented
        // public fields from a connection payload. Never persist its tokens.
        auto& target = (*saved)["live"];
        for (const auto* name : {"liveId", "startedAt", "closeAirTime", "listenerCount", "totalListenerCount"})
            if (live.contains(name)) target[name] = live[name];
        target["title"] = clip(string_member(live, "title"), 300);
        target["welcomeMessage"] = clip(string_member(live, "welcomeMessage"), 500);
        target["isChatFrozen"] = yes(live, "isChatFrozen");
        target["tags"] = Json::array();
        if (member(live, "tags").is_array()) for (const auto& tag : live["tags"]) {
            if (target["tags"].size() == 20) break;
            target["tags"].push_back(tag.is_null() ? "null" : text(tag));
        }
        (*saved)["updatedAt"] = stamp;
        (*saved)["liveUpdatedAt"] = stamp;
        (*saved)["endedAt"] = nullptr;
    }
    active_key_ = key;
}

Json* Model::user(Json& saved, const Json& input, const std::string& stamp) {
    if (!member(input, "id").is_string() || !member(input, "name").is_string()) return nullptr;
    const auto id = clip(input["id"].get<std::string>(), 300);
    auto& users = saved["users"];
    Json* person = nullptr;
    for (auto& item : users) if (member(item, "id") == id) { person = &item; break; }
    if (!person && users.size() < max_users) {
        Json fresh = totals();
        fresh.update({{"id", id}, {"name", ""}, {"firstSeen", stamp}, {"lastSeen", ""}, {"visits", Json::object()}});
        users.push_back(std::move(fresh));
        person = &users.back();
    }
    if (person) {
        (*person)["name"] = clip(input["name"].get<std::string>(), 120);
        (*person)["lastSeen"] = stamp;
        if (input.contains("subscription")) (*person)["subscription"] = input["subscription"];
    }
    return person;
}

bool Model::record(const std::string& key, const Json& event) {
    auto* saved = session(key);
    if (!saved || !member(event, "id").is_string() || string_member(event, "id").empty() || !member(event, "type").is_string()) return false;
    const auto id = event["id"].get<std::string>();
    auto& ids = seen_[key];
    if (ids.contains(id)) return false;
    const auto stamp = timestamp(now_());
    ids.insert(id);
    auto& seen = (*saved)["seen"];
    seen.push_back(id);
    if (seen.size() > max_seen) {
        const auto removed = seen.front().get<std::string>();
        seen.erase(seen.begin());
        // Legacy files may contain the same ID more than once.
        if (std::find(seen.begin(), seen.end(), Json(removed)) == seen.end()) ids.erase(removed);
    }
    const auto type = event["type"].get<std::string>();
    const bool dj = yes(event, "isDj");
    const auto event_time = !event.contains("time") || event["time"].is_null() || event["time"] == "" ? Json(stamp) : event["time"];
    auto* person = user(*saved, member(event, "user"), stamp);
    if (person && !dj && attendance_type(type)) visit(*saved, *person, event_time, type == "entry");
    const char* field = type == "comment" ? "comments" : type == "entry" ? "entries" : type == "heart" ? "hearts" : type == "spoon" ? "spoons" : type == "follow" ? "follows" : nullptr;
    const bool counted = field && !(type == "comment" && dj);
    const bool quantity = type == "heart" || type == "spoon";
    const bool unknown = counted && quantity && (!event.contains("amount") || event["amount"].is_null());
    const double amount = quantity ? std::max(0.0, number(member(event, "amount"))) : 1;
    if (unknown) {
        for (auto* target : {saved, person}) if (target) {
            if (!target->contains("quantityUnknown")) (*target)["quantityUnknown"] = {{"hearts", 0}, {"spoons", 0}};
            add((*target)["quantityUnknown"], field, 1);
        }
    } else if (counted) {
        add((*saved)["totals"], field, amount);
        if (person) add(*person, field, amount);
    }
    Json logged = {{"id", id}, {"type", type}, {"text", clip(event.contains("text") ? (event["text"].is_null() ? "null" : text(event["text"])) : "undefined", 500)},
        {"time", event_time}, {"amount", unknown ? Json(nullptr) : numeric(amount)}, {"isDj", dj}};
    if (event.contains("user")) logged["user"] = event["user"];
    auto& events = (*saved)["events"];
    events.push_back(std::move(logged));
    retain(events, max_events, true);
    (*saved)["updatedAt"] = stamp;
    return true;
}

void Model::observe(const std::string& key, const Json& users) {
    auto* saved = session(key);
    if (!saved) return;
    if (!users.is_array()) throw std::invalid_argument("users must be an array");
    const auto stamp = timestamp(now_());
    for (const auto& input : users) if (auto* person = user(*saved, input, stamp)) visit(*saved, *person, stamp);
}

void Model::finish_session(const std::string& key) {
    if (auto* saved = session(key)) {
        (*saved)["endedAt"] = timestamp(now_());
        if (member(*saved, "poll").is_object()) (*saved)["poll"]["open"] = false;
        if (member(*saved, "requests").is_object()) (*saved)["requests"]["open"] = false;
    }
}

void Model::set_runtime(const Json& runtime) {
    if (!runtime.is_object() || runtime.dump().size() > 8 * 1024 * 1024)
        throw std::invalid_argument("配信ツールの保存データが大きすぎるか、形式が不正です。");
    state_["runtime"] = runtime;
}

void Model::set_donations(const std::string& key, const Json& rows) {
    auto* saved = session(key);
    if (!saved) throw std::invalid_argument("No session for donation history");
    if (!rows.is_array() || rows.size() > max_events) throw std::invalid_argument("Donation history must contain at most 10000 rows");
    double total = 0;
    for (const auto& item : rows) {
        if (!item.is_object() || !member(item, "amount").is_number() || number(item["amount"]) < 0 || !std::isfinite(item["amount"].get<double>()))
            throw std::invalid_argument("Donation amount must be a nonnegative finite number");
        total += item["amount"].get<double>();
        if (!std::isfinite(total)) throw std::invalid_argument("Donation total is too large");
    }
    // Validate the entire fetched snapshot before replacing previous results.
    Json history = member(*saved, "donationHistory").is_object() ? (*saved)["donationHistory"] : Json::object();
    history.update({{"items", rows}, {"total", numeric(total)}, {"fetchedAt", timestamp(now_())}});
    (*saved)["donationHistory"] = std::move(history);
}

std::string Model::participants_csv(const std::string& key) const {
    std::string csv = "\xef\xbb\xbf";
    row(csv, {"配信ID", "ユーザーID", "名前", "初回検出", "最終検出", "コメント", "入室", "ハート", "スプーン", "フォロー",
        "ハート数量不明の通知数", "スプーン数量不明の通知数", "取得方式", "サブスクプラン"});
    if (const auto* saved = session(key)) for (const auto& person : (*saved)["users"]) {
        const auto& subscription = member(person, "subscription");
        Json plan = member(subscription, "plan");
        if (!plan.is_string() || plan.get<std::string>().empty())
            plan = person.contains("subscription") && subscription.is_null() ? "なし" : "未取得";
        Json values = Json::array({member((*saved)["live"], "liveId"), member(person, "id"), member(person, "name"),
            member(person, "firstSeen"), member(person, "lastSeen")});
        for (const auto* field : fields) values.push_back(person.contains(field) ? person[field] : Json(nullptr));
        for (const auto* field : {"hearts", "spoons"}) values.push_back(numeric(number(member(member(person, "quantityUnknown"), field))));
        values.push_back(saved->value("source", Json("api")));
        values.push_back(plan);
        row(csv, values);
    }
    return csv;
}

std::string Model::logs_csv(const std::string& key) const {
    std::string csv = "\xef\xbb\xbf";
    row(csv, {"配信ID", "イベントID", "時刻", "種類", "ユーザーID", "名前", "本文", "数量", "DJ"});
    if (const auto* saved = session(key)) for (const auto& event : (*saved)["events"])
        row(csv, {member((*saved)["live"], "liveId"), member(event, "id"), member(event, "time"), event_label(string_member(event, "type")),
            member(member(event, "user"), "id"), member(member(event, "user"), "name"), member(event, "text"), member(event, "amount"), member(event, "isDj")});
    return csv;
}

std::string Model::analytics_csv() const {
    std::string csv = "\xef\xbb\xbf";
    row(csv, {"配信ID", "タイトル", "受信開始（UTC）", "観測期間（分）", "コメント", "ハート", "スプーン", "参加者", "コメント/分"});
    const auto& sessions = state_["manager"]["sessions"];
    const auto* selected = session(active_key_);
    if (!selected && !sessions.empty()) selected = &sessions.front();
    if (!selected) return csv;
    const auto dj = owner(string_member(*selected, "key"));
    std::vector<const Json*> history;
    for (const auto& saved : sessions) if (owner(string_member(saved, "key")) == dj) history.push_back(&saved);
    std::stable_sort(history.begin(), history.end(), [](const Json* a, const Json* b) {
        return parse_time(member(*a, "observedAt")).value_or(0) > parse_time(member(*b, "observedAt")).value_or(0);
    });
    if (history.size() > 10) history.resize(10);
    const auto now = now_();
    for (auto it = history.rbegin(); it != history.rend(); ++it) {
        const auto& saved = **it;
        const auto start = parse_time(member(saved, "observedAt"));
        auto end = parse_time(member(saved, "endedAt"));
        if (!end) end = string_member(saved, "key") == active_key_ ? std::optional(now) : parse_time(member(saved, "updatedAt"));
        const double minutes = start ? std::max(0.0, (std::min(now, end.value_or(*start)) - *start) / 60000.0) : 0;
        const auto& counts = member(saved, "totals");
        const auto comments = std::max(0.0, number(member(counts, "comments")));
        auto title = string_member(member(saved, "live"), "title");
        row(csv, {member(saved, "key"), title.empty() ? "配信" : title, member(saved, "observedAt"), fixed(minutes, 1),
            numeric(comments), numeric(std::max(0.0, number(member(counts, "hearts")))), numeric(std::max(0.0, number(member(counts, "spoons")))),
            saved["users"].size(), minutes >= 1 ? fixed(comments / minutes, 2) : ""});
    }
    return csv;
}

} // namespace spoon
